require('dotenv').config({ path: ['.env.local', '.env'] });
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require("socket.io");
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const supabase = require('./db.cjs'); // Intelligent DB selector (Supabase or Mock)
const AI = require('./ai.cjs'); // Operational AI (rules engine; LLM-ready)

// Optional LLM hook: set AI_PROVIDER_URL + AI_API_KEY to call a real model
// later. The ai.cjs interface stays the same; this is the integration seam.
const AI_PROVIDER_URL = process.env.AI_PROVIDER_URL;
const AI_API_KEY = process.env.AI_API_KEY;

const app = express();
const path = require('path');

// --- CORS policy ---
// In production restrict to known origins (comma-separated in ALLOWED_ORIGINS).
// When unset (local/dev) it falls back to reflecting the request origin.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const corsOptions = allowedOrigins.length
    ? { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true }
    : { origin: true, methods: ['GET', 'POST'] };
app.use(cors(corsOptions));

// --- Security helpers ---
const BCRYPT_ROUNDS = 12;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // Invite tokens valid 24h

function hashPassword(plain) {
    return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

function verifyPassword(plain, hash) {
    if (!plain || !hash) return false;
    try { return bcrypt.compareSync(plain, hash); } catch { return false; }
}

// Generate a reasonably unique invite/operation token (24 chars, URL-safe).
function generateToken() {
    return crypto.randomBytes(18).toString('base64url');
}

// Per-channel ephemeral key (used to obfuscate WebRTC signaling for that channel).
function deriveChannelKey(opId, channelName) {
    const seed = process.env.SIGNAL_SECRET || 'dev-insecure-signal-secret-change-me';
    return crypto.createHash('sha256').update(`${seed}:${opId}:${channelName}`).digest('base64url');
}

// --- Per-socket rate limiter (in-memory, per connection) ---
// Prevents a single client from spamming heavy handlers (tenant creation,
// invite generation, signaling). Resets on reconnect.
const RATE_LIMITS = {
    'create-tenant': { max: 5, windowMs: 60000 },
    'generate-invite': { max: 30, windowMs: 60000 },
    'join-operation': { max: 20, windowMs: 60000 },
    'offer': { max: 60, windowMs: 60000 },
    'answer': { max: 60, windowMs: 60000 },
    'ice-candidate': { max: 200, windowMs: 60000 }
};

function rateLimited(socket, event) {
    const cfg = RATE_LIMITS[event];
    if (!cfg) return false;
    const now = Date.now();
    if (!socket._rate) socket._rate = {};
    const rec = socket._rate[event] || { count: 0, start: now };
    if (now - rec.start > cfg.windowMs) {
        rec.count = 0;
        rec.start = now;
    }
    rec.count += 1;
    socket._rate[event] = rec;
    return rec.count > cfg.max;
}

// Maps socket.id -> opId so we can validate WebRTC signaling targets belong
// to the same operation (prevents directing audio signaling at arbitrary sockets).
const socketOpId = new Map();

// --- Operational AI state (per operation, in-memory + persisted) ---
// eventBuffers holds the current shift's events for replay/timeline + AI.
const eventBuffers = {};            // opId -> [ {ts, type, payload} ]
const autonomyMode = {};            // opId -> 'SUGGEST_ONLY' | 'SUGGEST_APPROVE' | 'AUTO_EXECUTE'
const opUnitState = {};             // opId -> { units: {}, sosActive, openIncidents, lastChaos }

async function logEvent(opId, type, payload = {}) {
    if (!opId) return;
    const entry = { ts: new Date().toISOString(), type, payload };
    if (!eventBuffers[opId]) eventBuffers[opId] = [];
    eventBuffers[opId].push(entry);
    // Cap local buffer to avoid unbounded growth; DB is the source of truth.
    if (eventBuffers[opId].length > 5000) eventBuffers[opId].shift();
    try {
        await supabase.from('event_log').insert([{ op_id: opId, type, payload }]);
    } catch (e) { /* best-effort */ }
}

// Emits an AI insight to the op's admins.
function emitInsight(opId, insight) {
    io.to(`admin-${opId}`).emit('ai-insight', insight);
}

// Recompute and push AI insight for an operation (called on relevant events).
async function pushInsight(opId, { dispatchTask = null } = {}) {
    const events = eventBuffers[opId] || [];
    const st = opUnitState[opId] || { units: {}, sosActive: 0, openIncidents: 0, lastChaos: { index: 0, state: 'BAJO' } };
    const mode = autonomyMode[opId] || 'SUGGEST_ONLY';

    const summary = AI.summarizeShift(events);
    const actions = AI.supervise({ chaos: st.lastChaos, units: Object.values(st.units), openIncidents: st.openIncidents, sosActive: st.sosActive });
    const mem = (await supabase.from('operational_memory').select('learned, summary').eq('op_id', opId).single().catch(() => ({ data: null })))?.data;
    const learned = mem ? AI.learnFromShift(mem, events) : { predictions: [] };
    const dispatch = dispatchTask ? AI.recommendDispatch(Object.values(st.units), dispatchTask) : null;

    const insight = AI.buildInsight({ mode, summary, actions, predictions: learned.predictions, dispatch });
    emitInsight(opId, insight);

    // AUTO_EXECUTE: act on the top critical action without waiting for approval.
    if (mode === 'AUTO_EXECUTE' && dispatchTask && dispatch && dispatch.recommended?.length) {
        dispatch.recommended.forEach(uid => {
            const u = Object.values(st.units).find(x => x.id === uid);
            if (u?.socketId) emitForceJoin(u.socketId, opId, dispatchTask.channel || 'BASE');
        });
        await logEvent(opId, 'dispatch-auto', { recommended: dispatch.recommended, task: dispatchTask });
    }
    return insight;
}

// --- TURN credentials (ephemeral, derived from a shared static auth secret) ---
// The TURN server (coturn) is configured with TURN_SECRET. We mint short-lived
// credentials (username = expiry timestamp) so the browser can authenticate
// without ever seeing the secret.
const TURN_SECRET = process.env.TURN_SECRET;
const TURN_URLS = (process.env.TURN_URLS || 'turn:localhost:3478?transport=udp,turn:localhost:3478?transport=tcp')
    .split(',').map(s => s.trim()).filter(Boolean);
const TURN_TTL_SECONDS = 86400; // 24h credential lifetime

function getTurnConfig() {
    if (!TURN_SECRET) return null;
    const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
    const username = String(expiry);
    const credential = crypto
        .createHash('sha1')
        .update(`${username}:${TURN_SECRET}`)
        .digest('base64');
    return { urls: TURN_URLS, username, credential, expiresAt: expiry * 1000 };
}

// Emit force-join-channel including the derived signaling key for that channel.
function emitForceJoin(target, opId, channelName) {
    io.to(target).emit('force-join-channel', {
        channel: channelName,
        channelKey: deriveChannelKey(opId, channelName)
    });
}
app.use(express.static(path.join(__dirname, 'dist'))); // Serve Vite build if exists
app.use(express.static(path.join(__dirname, 'public'))); // Serve PWA assets
app.use(express.static(__dirname)); // Serve root assets (app.js, style.css, etc.)

// --- Pretty URLs ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/gps', (req, res) => res.sendFile(path.join(__dirname, 'gps.html')));
app.get('/superadmin', (req, res) => res.sendFile(path.join(__dirname, 'superadmin.html')));
app.get('/index', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

// Timeline / Replay (read-only). Returns the persisted event log.
app.get('/timeline/:opId', async (req, res) => {
    const opId = req.params.opId;
    try {
        const { data, error } = await supabase
            .from('event_log')
            .select('ts, type, payload')
            .eq('op_id', opId)
            .order('ts', { ascending: true });
        if (error) return res.status(200).json({ opId, events: [], error: error.message });
        res.json({ opId, events: data || [], generatedAt: new Date().toISOString() });
    } catch (e) {
        res.status(200).json({ opId, events: [], error: 'Server error' });
    }
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: allowedOrigins.length
        ? { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true }
        : { origin: true, methods: ["GET", "POST"] }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // --- Operation Management ---
    // Master key loaded from environment. No hardcoded credentials.
    const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY;
    if (!SUPER_ADMIN_KEY) {
        console.warn("[SECURITY] SUPER_ADMIN_KEY is not set. Super-admin operations will be unavailable.");
    }

    socket.on('login-super-admin', ({ key }) => {
        if (!SUPER_ADMIN_KEY || key !== SUPER_ADMIN_KEY) {
            socket.emit('super-admin-auth', { success: false, msg: "Invalid Master Key" });
        } else {
            socket.emit('super-admin-auth', { success: true });
        }
    });

    socket.on('create-tenant', async ({ key, opId, password }) => {
        if (rateLimited(socket, 'create-tenant')) {
            return socket.emit('tenant-created', { success: false, msg: "Rate limited" });
        }
        if (!SUPER_ADMIN_KEY || key !== SUPER_ADMIN_KEY) {
            return socket.emit('tenant-created', { success: false, msg: "Unauthorized" });
        }

        // Check if exists
        const { data: existing } = await supabase.from('operations').select('id').eq('id', opId).single();
        if (existing) {
            return socket.emit('tenant-created', { success: false, msg: "Operation ID already exists." });
        }

        // Create Operation (store hashed password, never plaintext)
        const { error: opError } = await supabase.from('operations').insert([{ id: opId, admin_password: hashPassword(password) }]);
        if (opError) {
            console.error("Create Op Error:", opError);
            return socket.emit('tenant-created', { success: false, msg: "Database Error" });
        }

        // Create Default Channels
        const defaultChannels = [
            { op_id: opId, name: 'CHANNEL 1' },
            { op_id: opId, name: 'LOGISTICS' }
        ];
        await supabase.from('channels').insert(defaultChannels);

        // Generate initial invite token (single-use, 24h expiry)
        const token = generateToken();
        const expires_at = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
        await supabase.from('operation_tokens').insert([{ token, op_id: opId, expires_at }]);

        console.log(`[SUPER ADMIN] Tenant created: ${opId}`);
        socket.emit('tenant-created', { opId, success: true, token });
    });

    socket.on('list-tenants', async ({ key }) => {
        try {
            if (!SUPER_ADMIN_KEY || key !== SUPER_ADMIN_KEY) return;
            const { data, error } = await supabase.from('operations').select('id, admin_password');
            if (!error) {
                socket.emit('tenants-list', data.map(op => ({ opId: op.id, adminPass: op.admin_password })));
            }
        } catch (e) {
            console.error("List Tenants Error:", e);
        }
    });

    socket.on('login-admin', async ({ opId, password }) => {
        try {
            const { data: op, error } = await supabase.from('operations').select('*').eq('id', opId).single();

            if (op && verifyPassword(password, op.admin_password)) {
                socket.join(`admin-${opId}`);
                socket.AdminOpId = opId;

                // Fetch Channels
                const { data: channels } = await supabase.from('channels').select('name').eq('op_id', opId);
                const channelList = channels ? channels.map(c => c.name) : [];

                // Fetch Active Units
                const { data: units } = await supabase.from('units').select('*').eq('op_id', opId).neq('status', 'OFFLINE');
                const activeUnits = {};
                if (units) {
                    units.forEach(u => {
                        activeUnits[u.socket_id] = {
                            id: u.id,
                            callSign: u.callsign, // Map to camelCase
                            lat: u.lat,
                            lng: u.lng,
                            status: u.status,
                            lastSeen: u.last_seen,
                            socketId: u.socket_id
                        };
                    });
                }

                socket.emit('admin-authenticated', { success: true, opId, channels: channelList });
                socket.emit('active-units-list', activeUnits);

                // Restore autonomy mode (default SUGGEST_ONLY) and notify admin.
                if (!autonomyMode[opId]) {
                    autonomyMode[opId] = op.autonomy_mode || 'SUGGEST_ONLY';
                }
                socket.emit('autonomy-mode', autonomyMode[opId]);

                // Push an initial AI insight.
                pushInsight(opId);
            } else {
                socket.emit('admin-auth-error', 'Invalid credentials');
            }
        } catch (e) {
            console.error("Admin Login Error:", e);
            socket.emit('admin-auth-error', 'Server Error');
        }
    });

    socket.on('generate-invite', async ({ opId }) => {
        if (rateLimited(socket, 'generate-invite')) {
            return socket.emit('invite-generated', { error: 'Rate limited' });
        }
        const token = generateToken();
        const expires_at = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
        const { error } = await supabase.from('operation_tokens').insert([{ token, op_id: opId, expires_at }]);
        if (!error) {
            socket.emit('invite-generated', { token, opId, expires_at });
        }
    });

    // --- AI / Autonomy controls ---
    socket.on('set-autonomy-mode', async ({ mode }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;
        if (!AI.MODES.includes(mode)) return;
        autonomyMode[opId] = mode;
        await supabase.from('operations').update({ autonomy_mode: mode }).eq('id', opId);
        io.to(`admin-${opId}`).emit('autonomy-mode', mode);
        await logEvent(opId, 'autonomy-mode', { mode });
    });

    // Timeline / Replay: send the buffered events of the current shift.
    socket.on('request-timeline', () => {
        const opId = socket.AdminOpId;
        if (!opId) return;
        const events = (eventBuffers[opId] || []).slice();
        socket.emit('timeline', {
            opId,
            events,
            generatedAt: new Date().toISOString()
        });
    });

    // Admin approval for a suggested AI action (SUGGEST_APPROVE mode).
    socket.on('approve-ai-action', async ({ actionType, dispatch }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;
        if (dispatch && dispatch.recommended?.length) {
            dispatch.recommended.forEach(uid => {
                const u = Object.values(opUnitState[opId]?.units || {}).find(x => x.id === uid);
                if (u?.socketId) emitForceJoin(u.socketId, opId, dispatch.channel || 'BASE');
            });
            await logEvent(opId, 'dispatch-approved', { recommended: dispatch.recommended, channel: dispatch.channel });
        }
    });

    // --- Channel Management ---
    const fusionMap = {}; // Maps `${opId}-${subId}` -> masterId

    socket.on('fuse-incidents', async ({ masterId, subIds }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        const { error } = await supabase.from('channels').insert([{ op_id: opId, name: masterId }]);
        if (!error) {
            notifyChannelsUpdated(opId);

            subIds.forEach(subId => {
                fusionMap[`${opId}-${subId}`] = masterId;
                // Move everyone currently in subId room to masterId
                const subRoomName = `${opId}-${subId}`;
                const clients = io.sockets.adapter.rooms.get(subRoomName);
                if (clients) {
                    for (const clientId of clients) {
                        emitForceJoin(clientId, opId, masterId);
                    }
                }

                io.to(`admin-${opId}`).emit('incident-fused', { masterId, subIds });
            });
        }
    });

    socket.on('add-channel', async ({ channelName }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        const { error } = await supabase.from('channels').insert([{ op_id: opId, name: channelName }]);
        if (!error) {
            notifyChannelsUpdated(opId);
        }
    });

    socket.on('assign-to-incident', ({ incidentId, unitSocketId }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        // Force the assigned unit to join the incident channel
        emitForceJoin(unitSocketId, opId, incidentId);

        // Also force the admin to join the incident channel so they can talk
        emitForceJoin(socket.id, opId, incidentId);
    });

    socket.on('create-tactical-zone', async ({ channelName, unitSocketIds }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        // 1. Create the ephemeral channel in DB
        const { error } = await supabase.from('channels').insert([{ op_id: opId, name: channelName }]);

        if (!error) {
            notifyChannelsUpdated(opId);

            // 2. Force all selected units into this channel
            unitSocketIds.forEach(targetId => {
                emitForceJoin(targetId, opId, channelName);
            });

            // 3. Force Admin into the channel
            emitForceJoin(socket.id, opId, channelName);

            // 4. Auto-destruct after 5 minutes (300000 ms) of inactivity
            // In a real app we'd reset this timer on audio activity, but for now a fixed TTL
            setTimeout(async () => {
                const { error: delErr } = await supabase.from('channels').delete().match({ op_id: opId, name: channelName });
                if (!delErr) {
                    notifyChannelsUpdated(opId);
                    // Force remaining users in this room back to BASE
                    emitForceJoin(`${opId}-${channelName}`, opId, 'BASE');
                }
            }, 300000);
        }
    });

    socket.on('remove-channel', async ({ channelName }) => {
        const opId = socket.AdminOpId;
        if (!opId) return;

        const { error } = await supabase.from('channels').delete().match({ op_id: opId, name: channelName });
        if (!error) {
            notifyChannelsUpdated(opId);
        }
    });

    async function notifyChannelsUpdated(opId) {
        try {
            const { data: channels, error } = await supabase.from('channels').select('name').eq('op_id', opId);
            if (error) throw error;
            
            const list = channels ? channels.map(c => c.name) : [];

            let defaultChannel = 'BASE';
            if (channels && channels.length > 0) {
                const hasBase = channels.some(c => c.name === 'BASE');
                if (!hasBase) defaultChannel = channels[0].name;
            }

            io.to(`admin-${opId}`).emit('channels-updated', list);
            io.to(opId).emit('operation-config', { channels: list, opId, defaultChannel });
        } catch (e) {
            console.error("Notify Channels Update Error:", e);
        }
    }

    // --- User Logic ---

    socket.on('join-operation', async ({ opId, token, userId, callSign }) => {
        try {
            if (rateLimited(socket, 'join-operation')) {
                return socket.emit('join-error', 'Too many join attempts');
            }
            // Validate the operation exists
            const { data: op } = await supabase.from('operations').select('id').eq('id', opId).single();
            if (!op) return socket.emit('join-error', 'Operation not found');

            // Validate the invite token: must exist, not expired, not already used.
            if (token) {
                const { data: tokRow } = await supabase
                    .from('operation_tokens')
                    .select('token, op_id, expires_at, used_at')
                    .eq('token', token)
                    .eq('op_id', opId)
                    .single();

                const now = Date.now();
                if (!tokRow) {
                    return socket.emit('join-error', 'Invalid invite token');
                }
                if (tokRow.used_at) {
                    return socket.emit('join-error', 'Invite token already used');
                }
                if (tokRow.expires_at && new Date(tokRow.expires_at).getTime() < now) {
                    return socket.emit('join-error', 'Invite token expired');
                }
                // Mark token as used (single-use)
                await supabase.from('operation_tokens').update({ used_at: new Date().toISOString() }).eq('token', token);
            }

            socket.join(opId);
            socket.OpId = opId;
            socket.UserId = userId; // Track user ID
            socketOpId.set(socket.id, opId);

            // Initialize per-op AI state on first join of the shift.
            if (!opUnitState[opId]) opUnitState[opId] = { units: {}, sosActive: 0, openIncidents: 0, lastChaos: { index: 0, state: 'BAJO' } };
            opUnitState[opId].units[userId] = { id: userId, callSign, socketId: socket.id, status: 'WAITING FOR GPS...', lat: 0, lng: 0 };

            await logEvent(opId, 'join-operation', { userId, callSign });
            pushInsight(opId);

            // Get Channels
            const { data: channels } = await supabase.from('channels').select('name').eq('op_id', opId);

            let defaultChannel = 'BASE';
            if (channels && channels.length > 0) {
                const hasBase = channels.some(c => c.name === 'BASE');
                if (!hasBase) defaultChannel = channels[0].name;
            }

            socket.emit('operation-config', {
                channels: channels.map(c => c.name),
                opId,
                defaultChannel,
                turn: getTurnConfig(),
                channelKeys: channels.reduce((acc, c) => {
                    acc[c.name] = deriveChannelKey(opId, c.name);
                    return acc;
                }, {})
            });

            // Register Unit
            const unitData = {
                id: userId,
                op_id: opId,
                callsign: callSign,
                socket_id: socket.id,
                status: "WAITING FOR GPS...",
                last_seen: new Date().toISOString()
            };

            await supabase.from('units').upsert(unitData);

            // Notify Admin with camelCase
            io.to(`admin-${opId}`).emit('register-unit', {
                id: userId,
                callSign: callSign,
                socketId: socket.id,
                status: "WAITING FOR GPS...",
                lat: 0,
                lng: 0,
                lastSeen: unitData.last_seen
            });
        } catch (e) {
            console.error("Join Operation Error:", e);
            socket.emit('join-error', 'Server Error');
        }
    });

    socket.on('join-channel', ({ opId, channelName }) => {
        try {
            // Fallback: if socket.OpId isn't set yet but we have it in the request, use it
            if (!socket.OpId && opId) socket.OpId = opId;
            
            if (socket.OpId !== opId) {
                console.warn(`[JOIN] Request for ${opId} denied (Socket OpId: ${socket.OpId})`);
                return;
            }

            let targetChannel = channelName;
            // Redirect if fused
            if (fusionMap[`${opId}-${channelName}`]) {
                targetChannel = fusionMap[`${opId}-${channelName}`];
                emitForceJoin(socket.id, opId, targetChannel);
                return;
            }

            // Leave previous channel
            if (socket.CurrentChannel) {
                const oldRoom = `${opId}-${socket.CurrentChannel}`;
                socket.leave(oldRoom);
                const oldRoomSize = io.sockets.adapter.rooms.get(oldRoom)?.size || 0;
                io.to(oldRoom).emit('channel-users-count', oldRoomSize);
            }

            socket.CurrentChannel = channelName;
            const newRoom = `${opId}-${channelName}`;
            
            // Get others *before* joining to avoid sending to self? 
            // Actually, get the room's current members and exclude ourselves.
            const existingSockets = io.sockets.adapter.rooms.get(newRoom);
            const otherUsers = [];
            if (existingSockets) {
                existingSockets.forEach(sid => {
                    if (sid !== socket.id) otherUsers.push(sid);
                });
            }
            socket.emit('room-users', otherUsers);

            socket.join(newRoom);
            socket.to(newRoom).emit('user-connected', socket.id);

            const newRoomSize = io.sockets.adapter.rooms.get(newRoom)?.size || 0;
            io.to(newRoom).emit('channel-users-count', newRoomSize);
            console.log(`[CHANNEL] User ${socket.id} joined ${newRoom} (Size: ${newRoomSize})`);
        } catch (e) {
            console.error("Join Channel Error:", e);
        }
    });

    socket.on('leave-room', (channelName) => {
        const opId = socket.OpId;
        if (!opId) return;
        const roomName = `${opId}-${channelName}`;
        socket.leave(roomName);
        if (socket.CurrentChannel === channelName) {
            socket.CurrentChannel = null;
        }
        const roomSize = io.sockets.adapter.rooms.get(roomName)?.size || 0;
        io.to(roomName).emit('channel-users-count', roomSize);
    });

    // --- GPS Logic ---

    socket.on('update-location', async (data) => {
        try {
            const opId = socket.OpId;
            if (!opId) return;

            const updateData = {
                lat: data.lat,
                lng: data.lng, // Fix: data.lng (client sends lng)
                status: "ACTIVE",
                last_seen: new Date().toISOString(),
                socket_id: socket.id
            };

            // Update DB
            await supabase.from('units').update(updateData).eq('id', data.id);
            if (opUnitState[opId]?.units[data.id]) {
                opUnitState[opId].units[data.id].status = 'ACTIVE';
                opUnitState[opId].units[data.id].lat = data.lat;
                opUnitState[opId].units[data.id].lng = data.lng;
            }

            // Propagate to Admin
            io.to(`admin-${opId}`).emit('update-location', { ...data, socketId: socket.id, status: "ACTIVE" });
            await logEvent(opId, 'update-location', { userId: data.id, lat: data.lat, lng: data.lng });
        } catch (e) {
            console.error("Update Location Error:", e);
        }
    });

    socket.on('sos-alert', async ({ lat, lng }) => {
        const opId = socket.OpId;
        if (!opId) return;

        const sosTicket = `SOS-TICKET-${socket.UserId || Date.now().toString().slice(-4)}`;

        // Insert channel
        await supabase.from('channels').insert([{ op_id: opId, name: sosTicket }]);

        notifyChannelsUpdated(opId);
        if (opUnitState[opId]) opUnitState[opId].sosActive += 1;

        emitForceJoin(socket.id, opId, sosTicket);

        io.to(`admin-${opId}`).emit('sos-triggered', {
            userId: socket.UserId,
            channelName: sosTicket,
            lat,
            lng
        });

        await logEvent(opId, 'sos-triggered', { userId: socket.UserId, channelName: sosTicket, lat, lng });
        pushInsight(opId, { dispatchTask: { channel: sosTicket, lat, lng, count: 1 } });
    });

    // --- WebRTC ---
    // Forward signaling only when the target belongs to the same operation as
    // the sender (or the sender is that op's admin). Prevents directing audio
    // signaling at arbitrary sockets.
    function canSignal(opId, targetId) {
        if (!opId || !targetId) return false;
        const targetOp = socketOpId.get(targetId);
        if (targetOp === opId) return true;
        // Admin of the target's op may also signal to its units.
        if (socket.AdminOpId && socket.AdminOpId === targetOp) return true;
        return false;
    }

    socket.on('offer', (data) => {
        if (rateLimited(socket, 'offer')) return;
        if (data.target && data.offer && canSignal(socket.OpId, data.target)) {
            console.log(`[WEBRTC] Offer from ${socket.id} to ${data.target}`);
            io.to(data.target).emit('offer', { offer: data.offer, caller: socket.id });
        }
    });
    socket.on('answer', (data) => {
        if (rateLimited(socket, 'answer')) return;
        if (data.target && data.answer && canSignal(socket.OpId, data.target)) {
            console.log(`[WEBRTC] Answer from ${socket.id} to ${data.target}`);
            io.to(data.target).emit('answer', { answer: data.answer, caller: socket.id });
        }
    });
    socket.on('ice-candidate', (data) => {
        if (rateLimited(socket, 'ice-candidate')) return;
        if (data.target && data.candidate && canSignal(socket.OpId, data.target)) {
            console.log(`[WEBRTC] ICE from ${socket.id} to ${data.target}`);
            io.to(data.target).emit('ice-candidate', { candidate: data.candidate, caller: socket.id });
        }
    });

    socket.on('disconnect', async () => {
        try {
            const opId = socket.OpId;
            socketOpId.delete(socket.id);
            if (opId) {
                if (socket.CurrentChannel) {
                    const roomName = `${opId}-${socket.CurrentChannel}`;
                    const roomSize = io.sockets.adapter.rooms.get(roomName)?.size || 0;
                    io.to(roomName).emit('channel-users-count', roomSize);
                }

                // Mark as Offline
                if (socket.UserId) {
                    await supabase.from('units').update({ status: 'OFFLINE', socket_id: null }).eq('id', socket.UserId);
                }
                io.to(`admin-${opId}`).emit('user-disconnected', socket.id);
            }
            console.log('User disconnected:', socket.id);
        } catch (e) {
            console.error("Disconnect Error:", e);
        }
    });
});

// --- Invite token housekeeping ---
// Periodically purge expired or already-used invite tokens to keep the table small.
setInterval(async () => {
    try {
        const now = new Date().toISOString();
        await supabase
            .from('operation_tokens')
            .delete()
            .or(`expires_at.lt.${now},used_at.not.is.null`);
    } catch (e) {
        // Best-effort cleanup; ignore errors (e.g. mock DB has no .or support).
    }
}, 3600000); // hourly

// --- Chaos Index Evaluator ---
const operationChaosScores = {};

setInterval(() => {
    const activeOpIds = new Set();
    for (const [room, _] of io.sockets.adapter.rooms.entries()) {
        if (room.startsWith('admin-')) {
            activeOpIds.add(room.replace('admin-', ''));
        }
    }

    activeOpIds.forEach(opId => {
        let rawScore = 0;
        let activeIncidents = 0;
        let sosAlerts = 0;
        let busyOperators = 0;

        const rooms = io.sockets.adapter.rooms;
        for (const [room, clients] of rooms.entries()) {
            if (room.startsWith(`${opId}-`)) {
                const channelName = room.replace(`${opId}-`, '');

                let opCount = 0;
                clients.forEach(socketId => {
                    const s = io.sockets.sockets.get(socketId);
                    if (s && s.UserId) opCount++;
                });

                if (channelName.startsWith('INCIDENT-')) {
                    activeIncidents++;
                    rawScore += 15;
                } else if (channelName.startsWith('SOS-')) {
                    sosAlerts++;
                    rawScore += 30;
                }

                if (channelName !== 'BASE' && channelName !== 'LOGISTICS') {
                    busyOperators += opCount;
                    rawScore += opCount * 3;
                }
            }
        }

        if (!operationChaosScores[opId]) {
            operationChaosScores[opId] = { currentScore: 0 };
        }

        // Cap
        let targetScore = Math.min(rawScore, 100);

        // Hysteresis
        const prevScore = operationChaosScores[opId].currentScore;
        const smoothScore = (prevScore * 0.8) + (targetScore * 0.2);
        operationChaosScores[opId].currentScore = smoothScore;

        let index = Math.round(smoothScore);
        let state = "BAJO";
        if (index >= 75) state = "CRÍTICO";
        else if (index >= 50) state = "ALTO";
        else if (index >= 25) state = "MEDIO";

        if (opUnitState[opId]) opUnitState[opId].lastChaos = { index, state };

        io.to(`admin-${opId}`).emit('chaos-index-updated', { index, state });
    });
}, 3000);

// Periodic AI supervisor push (every 15s) so admins always see fresh insights
// even without discrete events. Also persists learned memory periodically.
setInterval(async () => {
    for (const opId of Object.keys(eventBuffers)) {
        try {
            await pushInsight(opId);
            const mem = (await supabase.from('operational_memory').select('learned').eq('op_id', opId).single().catch(() => ({ data: null })))?.data;
            const learned = mem ? (mem.learned || {}) : {};
            const updated = AI.learnFromShift({ learned }, eventBuffers[opId] || []);
            await supabase.from('operational_memory').upsert([{ op_id: opId, learned: updated.learned, summary: (AI.summarizeShift(eventBuffers[opId] || []).text), shift_count: (mem?.shift_count || 0) }]);
        } catch (e) { /* best-effort */ }
    }
}, 15000);

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        
        // --- Render Keep-Alive ---
        // Pings /health on an interval so the service stays warm. NOTE: on the
        // free tier Render suspends the process, so this only helps on paid
        // plans (starter+). Combine with an external monitor (UptimeRobot) for
        // free tiers. 5 minutes < Render's 15-min inactivity window.
        const url = process.env.RENDER_EXTERNAL_URL;
        if (url) {
            console.log(`[KEEP-ALIVE] Pinging ${url}/health every 5 minutes...`);
            setInterval(() => {
                const req = https.get(`${url}/health`, (res) => {
                    res.resume(); // drain
                    console.log(`[KEEP-ALIVE] Self-ping status: ${res.statusCode}`);
                });
                req.setTimeout(10000, () => req.destroy(new Error('keep-alive timeout')));
                req.on('error', (err) => {
                    console.error('[KEEP-ALIVE] Request Error:', err.message);
                });
            }, 300000); // 5 minutes
        }
    });
}

// --- Global Error Handlers to Prevent Server Crashes ---
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = { app, io, server };
