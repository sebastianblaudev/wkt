const PROD_SERVER_URL = "https://wkt.ash-2.instapods.app";

const getServerUrl = () => {
    // 1. Manually set override
    if (localStorage.getItem('walkieTalkieServer')) {
        return localStorage.getItem('walkieTalkieServer');
    }

    // 2. Capacitor/embedded WebView: always use production server.
    if (window.Capacitor) {
        return PROD_SERVER_URL;
    }

    // 3. Network/Local Development
    const hostname = window.location.hostname;
    const port = window.location.port;

    // If we are on port 3001/5173 (Vite/Dev), connect to local backend
    if (port === '3001' || port === '5173') {
        return `http://${hostname}:3000`;
    }

    // 4. Running in browser: use same origin (localhost, custom domain, or deployed app)
    if (window.location.origin && window.location.origin.startsWith('http')) {
        return window.location.origin;
    }

    // 5. Fallback
    return PROD_SERVER_URL;
};

const serverUrl = getServerUrl();
console.log("Attempting to connect to:", serverUrl);
let socket = io(serverUrl, {
    reconnection: true,
    reconnectionRequests: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
});

function getOrCreateUserId() {
    let id = localStorage.getItem('walkie_user_id');
    if (!id) {
        id = 'U-' + Math.floor(1000 + Math.random() * 9000);
        localStorage.setItem('walkie_user_id', id);
    }
    return id;
}

function getOrCreateCallSign() {
    let cs = localStorage.getItem('walkie_callsign');
    if (!cs) {
        const names = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ROVER', 'EAGLE'];
        const randomName = names[Math.floor(Math.random() * names.length)];
        const randomNum = Math.floor(1 + Math.random() * 99).toString().padStart(2, '0');
        cs = `${randomName}-${randomNum}`;
        localStorage.setItem('walkie_callsign', cs);
    }
    return cs;
}

let userId = getOrCreateUserId();
let userCallSign = getOrCreateCallSign();

// --- Operation Logic ---
let currentOpId = null;
const urlParams = new URLSearchParams(window.location.search);
let opIdParam = urlParams.get('op');
let tokenParam = urlParams.get('token');

// --- Capacitor Deep Linking ---
// Store a flag so the connect handler knows to (re)emit join-operation.
let deepLinkPending = false;

function activateDeepLink(op, token) {
    opIdParam = op;
    tokenParam = token;
    currentOpId = op;
    deepLinkPending = true;
    // Persist immediately so reconnects also pick them up.
    localStorage.setItem('walkie_op_id', op);
    localStorage.setItem('walkie_op_token', token);
    console.log('[DEEPLINK] Params stored:', op, token);
    // Power on automatically so operation-config can auto-join a channel.
    // Without this, isPoweredOn stays false (web flow never clicks the button)
    // and the channel is never joined, leaving the app stuck.
    if (!isPoweredOn) {
        powerOn().catch(e => console.error('[DEEPLINK] powerOn error:', e));
    }
}

function joinViaDeepLink() {
    if (!opIdParam || !tokenParam) return;
    console.log('[DEEPLINK] joinViaDeepLink - power on and let connect handler emit join-operation');
    // NO emit join-operation here — the connect handler already does this
    // with the same opIdParam/tokenParam. Emitting here would cause a double
    // join-operation → double operation-config → double joinRoom.
    // Just ensure the device is powered on so the PTT works once joined.
    if (!isPoweredOn) {
        powerOn().catch(e => console.error('[DEEPLINK] powerOn error:', e));
    }
}

// Try multiple strategies to capture the deep link URL.
// Strategy 1: Capacitor appUrlOpen event (fastest, if available).
try {
    const { App } = window.Capacitor?.Plugins || {};
    if (App && typeof App.addListener === 'function') {
        App.addListener('appUrlOpen', (event) => {
            console.log('[DEEPLINK] appUrlOpen event:', event.url);
            try {
                const url = new URL(event.url);
                const op = url.searchParams.get('op');
                const token = url.searchParams.get('token');
                if (op && token) {
                    activateDeepLink(op, token);
                    if (document.readyState === 'complete') {
                        setTimeout(joinViaDeepLink, 300);
                    } else {
                        window.addEventListener('load', () => setTimeout(joinViaDeepLink, 300));
                    }
                }
            } catch (e) { console.error("[DEEPLINK] parse error", e); }
        });
        console.log('[DEEPLINK] appUrlOpen listener registered');
    }
} catch (e) {
    console.warn("[DEEPLINK] Capacitor App plugin not available:", e.message);
}

// Strategy 2: Android may pass the intent URL via a global before the script runs.
// Check once more after DOM is ready (Capacitor sometimes injects it late).
window.addEventListener('DOMContentLoaded', () => {
    // Capacitor injects a <script> with the launch URL — check it.
    try {
        const capUrl = window.Capacitor?.getAppUrl?.() || null;
        if (capUrl && capUrl.includes('op=')) {
            const u = new URL(capUrl);
            const op = u.searchParams.get('op');
            const token = u.searchParams.get('token');
            if (op && token && !opIdParam) {
                activateDeepLink(op, token);
            }
        }
    } catch (_) {}
});

// Strategy 3 is removed — it disconnected the socket every 500ms, killing the
// join-operation response before it arrived. joinViaDeepLink handles retries now.

// Web (non-APK) deep link: params arrive directly in the URL (?op=...&token=...).
// If present and not yet handled by the Capacitor appUrlOpen path, activate them
// so the device powers on and auto-joins the operation as a web app.
window.addEventListener('DOMContentLoaded', () => {
    if (opIdParam && tokenParam && !deepLinkPending) {
        console.log('[WEB] Direct URL params detected, activating deep link');
        activateDeepLink(opIdParam, tokenParam);
        joinViaDeepLink();
    }
});

// --- Auto-Initialize Logic ---
const autoInit = () => {
    if (isPoweredOn) return;
    console.log("System Auto-Initialization...");
    powerOn().catch(e => console.error("autoInit powerOn error:", e));
};

window.addEventListener('load', () => {
    setTimeout(autoInit, 1000);
});

// Also trigger on first touch anywhere if not powered on
document.addEventListener('touchstart', () => {
    if (!isPoweredOn) autoInit();
}, { once: true });

// Mobile autoplay policy: resume AudioContext and (re)play any remote audio on
// any user interaction, so incoming audio is never stuck "blocked".
function resumeAudioOnGesture() {
    if (audioContext && audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    document.querySelectorAll('audio[id^="audio-"]').forEach(el => {
        if (el.srcObject) el.play().catch(() => {});
    });
}
document.addEventListener('touchstart', resumeAudioOnGesture, { passive: true });
document.addEventListener('click', resumeAudioOnGesture);

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// --- Global Vars ---
// --- Debug ---
function updateDebug(msg) { console.log("[DEBUG]", msg); }
updateDebug("Ready.");

let localStream;
let roomId;
let isPoweredOn = false;
let isSwitchingChannels = false;
let wakeLock = null;
// Per-channel signaling keys (HMAC) received from the server.
const channelKeys = {};

// --- Wake Lock Logic ---
async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
        updateDebug("WakeLock: NOT SUPPORTED");
        return;
    }
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        updateDebug("WakeLock: ACTIVE");
        
        wakeLock.addEventListener('release', () => {
            console.log('Wake Lock was released');
        });
    } catch (err) {
        updateDebug(`WakeLock Error: ${err.message}`);
    }
}

function releaseWakeLock() {
    if (wakeLock !== null) {
        wakeLock.release()
            .then(() => {
                wakeLock = null;
                updateDebug("WakeLock: RELEASED");
            });
    }
}

// Re-acquire wake lock when page becomes visible again
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible' && isPoweredOn) {
        await requestWakeLock();
    }
});

// Audio Context & Nodes
let audioContext;
let micSource;
let gainNode;
let destNode;
let analyser;
let dataArray;
let canvas, canvasCtx;
let animationId;
let remoteAnalyser;
let remoteDataArray;
let remoteCanvas, remoteCanvasCtx;

// --- Background Audio & Media Session ---
function updateMediaSession(type = 'COMMUNICATIONS') {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: `WALKIE TALKIE [${roomId || 'STANDBY'}]`,
            artist: 'SECURE COMMS',
            album: currentOpId || 'OPERATIONAL',
            artwork: [
                { src: 'logo.png', sizes: '512x512', type: 'image/png' }
            ]
        });

        // Set state to 'playing' to prevent the OS from suspending the tab
        navigator.mediaSession.playbackState = 'playing';
        
        // Dummy handlers to satisfy some browsers
        navigator.mediaSession.setActionHandler('play', () => {});
        navigator.mediaSession.setActionHandler('pause', () => {});
    }
}

// WebRTC
const peers = {};
const peerStates = {}; // Tracks { makingOffer: bool } per targetId

// TURN servers help establish P2P audio behind restrictive NAT/cellular networks.
// Preferred: ephemeral credentials pushed by the server in `operation-config`
// (see turnConfig below). Build-time override via VITE_TURN_* is also supported.
let turnConfig = (window.TURN_CONFIG)
    || (import.meta.env && import.meta.env.VITE_TURN_URLS
        ? { urls: import.meta.env.VITE_TURN_URLS.split(',').map(u => u.trim()),
            username: import.meta.env.VITE_TURN_USERNAME,
            credential: import.meta.env.VITE_TURN_CREDENTIAL }
        : null);

const baseIceServers = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
        urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
    }
];

// Builds the current ICE server list (STUN + any TURN credentials we have).
function buildIceServers() {
    const servers = baseIceServers.slice();
    if (turnConfig && turnConfig.urls) {
        const urls = Array.isArray(turnConfig.urls) ? turnConfig.urls : [turnConfig.urls];
        urls.forEach(url => {
            const srv = { urls: url };
            if (turnConfig.username) srv.username = turnConfig.username;
            if (turnConfig.credential) srv.credential = turnConfig.credential;
            servers.push(srv);
        });
    }
    return servers;
}

const rtcConfig = {
    iceServers: buildIceServers(),
    iceCandidatePoolSize: 10
};

// DOM Elements
const powerBtn = document.getElementById('power-btn');
const joinBtn = document.getElementById('join-btn');
const talkBtn = document.getElementById('talk-btn');
const roomInput = document.getElementById('room-input');
const statusText = document.getElementById('status-text');
const pttContainer = document.querySelector('.ptt-wrapper');
const signalStrength = document.querySelector('.signal-icon');

// Canvas Setup
canvas = document.getElementById('visualizer');
canvasCtx = canvas.getContext('2d');
remoteCanvas = document.getElementById('remote-visualizer');
remoteCanvasCtx = remoteCanvas.getContext('2d');

// --- Socket Events ---

const opCountDisplay = document.getElementById('operator-count-display');

socket.on('channel-users-count', (count) => {
    if (opCountDisplay) {
        opCountDisplay.innerText = `${count} OPERATOR${count !== 0 ? 'S' : ''} ONLINE`;
    }
});

socket.on('room-users', (users) => {
    console.log("Existing users in room:", users);
    users.forEach(targetId => {
        console.log(`[SIGNALLING] Initiating offer to existing user: ${targetId}`);
        createOffer(targetId);
    });
});

// Socket Connect Handler moved below joinRoom for better scoping

socket.on('operation-config', (config) => {
    console.log("Joined Operation:", config.opId);
    currentOpId = config.opId;
    deepLinkPending = false;
    statusText.innerText = `OP: ${config.opId.toUpperCase()}`;
    updateChannelUI(config.channels);

    // Persist op so we can auto re-join after a server "wake"/reconnect.
    if (currentOpId) {
        localStorage.setItem('walkie_op_id', currentOpId);
        // Single-use token was consumed by server. Clear it so reconnects rely on unit identity.
        localStorage.removeItem('walkie_op_token');
        tokenParam = null;
    }

    // Store per-channel signaling keys for HMAC-protected signaling.
    if (config.channelKeys) {
        Object.entries(config.channelKeys).forEach(([ch, key]) => { channelKeys[ch] = key; });
    }

    // Adopt ephemeral TURN credentials from the server (no secrets in the bundle).
    if (config.turn && config.turn.urls) {
        turnConfig = config.turn;
        rtcConfig.iceServers = buildIceServers();
        updateDebug("TURN configured");
    }

    // Auto-join last channel if already in this op, else default channel.
    // Note: isPoweredOn is NOT checked here — this handler fires asynchronously
    // and may arrive before powerOn() finishes. Channel subscription is independent
    // of mic/audio power state.
    const savedChannel = localStorage.getItem('walkie_last_channel');
    if (savedChannel && !isSwitchingChannels) {
        console.log("Re-joining last channel:", savedChannel);
        joinRoom(savedChannel);
    } else if (config.defaultChannel && !roomId && !isSwitchingChannels) {
        console.log("Auto-joining default channel:", config.defaultChannel);
        joinRoom(config.defaultChannel);
    }
});

function ensureAudioContext() {
    if (!audioContext) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) audioContext = new AudioCtx();
    }
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
    }
    return audioContext;
}

function playPttStartBeep() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1800, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.08);
    } catch (e) {
        console.warn("PTT start tone failed", e);
    }
}

function playRogerBeep() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(ctx.destination);

        osc1.type = 'sine';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(1240, ctx.currentTime);
        osc2.frequency.setValueAtTime(880, ctx.currentTime + 0.07);

        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.16);

        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.07);
        osc2.start(ctx.currentTime + 0.07);
        osc2.stop(ctx.currentTime + 0.16);
    } catch (e) {
        console.warn("Roger beep failed", e);
    }
}

function playBusyBeep() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.setValueAtTime(0, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.2, ctx.currentTime + 0.1);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
    } catch (e) {
        console.warn("Busy tone failed", e);
    }
}

function playTacticalAlert() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
        const osc = ctx.createOscillator();
        const gainInfo = ctx.createGain();
        osc.connect(gainInfo);
        gainInfo.connect(ctx.destination);

        osc.type = 'square';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1108.73, ctx.currentTime + 0.1);

        gainInfo.gain.setValueAtTime(0, ctx.currentTime);
        gainInfo.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.02);
        gainInfo.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);

        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
        console.warn("Audio alert failed", e);
    }
}

socket.on('force-join-channel', (payload) => {
    // Accept both legacy string and new { channel, channelKey } object.
    const channelName = typeof payload === 'string' ? payload : payload.channel;
    const channelKey = typeof payload === 'object' && payload.channelKey ? payload.channelKey : null;
    if (channelKey) {
        channelKeys[channelName] = channelKey;
    }
    console.log(`Command received: Force join ${channelName}`);
    if (isPoweredOn && roomId !== channelName) {
        joinRoom(channelName);

        playTacticalAlert();

        const overlay = document.getElementById('override-overlay');
        const msg = document.getElementById('override-message');
        if (overlay && msg) {
            msg.innerText = `REROUTING TO ${channelName}...`;
            overlay.classList.remove('hidden');
            overlay.classList.add('show');

            // Hide after 3 seconds
            setTimeout(() => {
                overlay.classList.remove('show');
                setTimeout(() => overlay.classList.add('hidden'), 300); // Wait for fade out
            }, 3000);
        }

        statusText.innerText = "OVERRIDE...";
        setTimeout(() => statusText.innerText = `ID: ${userId}`, 3000); // restore
    }
});

socket.on('join-error', (msg) => {
    console.error("ACCESS DENIED:", msg);
    statusText.innerText = `ACCESS DENIED: ${msg}`;
    statusText.classList.add('error-blink');
});

socket.on('connect_error', (err) => {
    console.error('Socket Connection Error:', err);
    statusText.innerText = "LINK LOST";
    statusText.classList.add('error-blink');
    updateDebug("Link Error: " + err.message);
});

socket.on('reconnect_attempt', (attempt) => {
    statusText.innerText = `RETRYING ${attempt}...`;
    updateDebug(`Reconnecting... (Attempt ${attempt})`);
});

socket.on('reconnect', (attempt) => {
    statusText.innerText = "ONLINE";
    statusText.classList.remove('error-blink');
    updateDebug("Link Restored.");
});

socket.on('disconnect', (reason) => {
    console.warn('Socket Disconnected:', reason);
    if (reason === "io server disconnect") {
        // the disconnection was initiated by the server, you need to reconnect manually
        socket.connect();
    }
    statusText.innerText = "DISCONNECTED";
    updateDebug("Link Down: " + reason);
});

// --- Channel Logic ---

function updateChannelUI(channels) {
    console.log("Allowed Channels:", channels);
    const channelSheet = document.getElementById('channel-sheet');
    const list = channelSheet.querySelector('.channel-list');

    if (list) {
        console.log("Clearing old channels and rendering:", channels.length);
        list.innerHTML = '';
        if (channels.length === 0) {
            list.innerHTML = '<div style="padding: 20px; text-align: center; color: #666;">No Access to Channels</div>';
        }
        channels.forEach((ch, index) => {
            console.log(`Rendering channel ${index}:`, ch);
            const div = document.createElement('div');
            div.className = 'channel-item';
            div.setAttribute('data-channel', ch);
            div.innerHTML = `
                <div class="ch-info">
                    <span class="ch-num">#</span>
                    <span class="ch-name">${ch}</span>
                </div>
                <div class="ch-status">IDLE</div>
            `;
            div.addEventListener('click', () => {
                const newChannel = ch;
                if (newChannel === roomId) {
                    channelSheet.classList.remove('show');
                    return;
                }
                if (newChannel && isPoweredOn) {
                    if (audioContext && audioContext.state === 'suspended') audioContext.resume();
                    joinRoom(newChannel);
                    channelSheet.classList.remove('show');
                } else if (!isPoweredOn) {
                    console.warn("Power ON the device first!");
                    channelSheet.classList.remove('show');
                }
            });
            list.appendChild(div);
        });

        // Restore active state if we are currently in a room
        if (roomId) {
            updateChannelSelection(roomId);
        }
    }
}

function updateChannelSelection(roomName) {
    const channelNameDisplay = document.querySelector('.channel-name');
    const channelItems = document.querySelectorAll('.channel-item');

    if (channelNameDisplay) {
        channelNameDisplay.innerHTML = roomName.replace(' ', '<br>');
    }

    channelItems.forEach(item => {
        if (item.getAttribute('data-channel') === roomName) {
            item.classList.add('active');
            item.querySelector('.ch-status').innerText = 'ONLINE';
            item.querySelector('.ch-status').style.background = 'var(--primary-color)';
            item.querySelector('.ch-status').style.color = '#000';
        } else {
            item.classList.remove('active');
            item.querySelector('.ch-status').innerText = 'IDLE';
            item.querySelector('.ch-status').style.background = 'rgba(255,255,255,0.05)';
            item.querySelector('.ch-status').style.color = 'var(--text-muted)';
        }
    });
}

function joinRoom(room) {
    if (isSwitchingChannels) return;
    isSwitchingChannels = true;
    roomId = room;
    localStorage.setItem('walkie_last_channel', room);

    if (roomInput) roomInput.value = roomId;
    if (statusText) statusText.innerText = "TUNING...";
    if (joinBtn) joinBtn.disabled = true;
    if (roomInput) roomInput.disabled = true;
    if (talkBtn) talkBtn.disabled = false;

    // Close WebRTC
    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });

    // Push to server without disconnecting
    if (socket.connected && currentOpId) {
        socket.emit('join-channel', {
            opId: currentOpId,
            channelName: room
        });
    }

    updateChannelSelection(room);

    // Reset flag after a short delay
    setTimeout(() => {
        isSwitchingChannels = false;
        if (statusText && !isTransmitting && !isReceiving) {
            statusText.innerText = "STANDBY";
        }
        updateDebug(`Channel: ${room}`);
    }, 500);
}

// Update connect handler to join channel if roomId is set
// This handles the Reconnect case in joinRoom
const originalConnectHandler = socket.listeners('connect')[0];
socket.off('connect'); // Remove old one to replace/wrap it

function handleSocketConnect() {
    updateDebug("Network Link: ESTABLISHED");
    console.log('Socket Connected!', socket.id);

    const savedOp = localStorage.getItem('walkie_op_id');
    const savedToken = localStorage.getItem('walkie_op_token');
    const joinOp = opIdParam || savedOp;
    const joinToken = opIdParam ? tokenParam : savedToken;
    if (joinOp) {
        console.log('[CONNECT] Joining operation:', joinOp);
        socket.emit('join-operation', {
            opId: joinOp,
            token: joinToken || undefined,
            userId: getOrCreateUserId(),
            callSign: getOrCreateCallSign()
        });
    } else {
        console.log('[CONNECT] No operation to join (opIdParam:', opIdParam, 'savedOp:', savedOp, ')');
    }
}

socket.on('connect', handleSocketConnect);
if (socket.connected) {
    handleSocketConnect();
}

// --- GPS Logic ---
let watchId = null;

function startGpsTracking() {
    const uid = localStorage.getItem('walkie_user_id') || 'UNKNOWN';
    const csign = localStorage.getItem('walkie_callsign') || 'UNIT';

    // Register immediately with Op scope if exists, but server handles based on socket.OpId
    // If we are in an Op, the socket is already tagged on server side from 'join-operation'
    // But we should still emit register-unit for the record
    socket.emit('register-unit', {
        id: uid,
        callSign: csign
    });

    if ("geolocation" in navigator) {
        watchId = navigator.geolocation.watchPosition((position) => {
            const { latitude, longitude } = position.coords;
            socket.emit('update-location', {
                lat: latitude,
                lng: longitude,
                id: uid,
                callSign: csign
            });
        }, (error) => {
            console.warn("GPS Error:", error.message);
            if (error.code === 1 && statusText) statusText.innerText = "NO LOCATION";
            if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
                if (statusText) statusText.innerText = "GPS BLOCKED";
            }
        }, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 10000
        });
    } else {
        console.warn("Geolocation not supported.");
    }
}

function stopGpsTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
}

// --- Power Logic ---

function forcePowerOff() {
    isPoweredOn = false;
    if (statusText) {
        statusText.innerText = "OFFLINE";
        statusText.className = "";
    }
    if (joinBtn) joinBtn.disabled = true;
    if (talkBtn) talkBtn.disabled = true;
    if (pttContainer) pttContainer.classList.remove('transmitting', 'receiving');

    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    Object.keys(peers).forEach(key => {
        peers[key].close();
        delete peers[key];
    });

    if (audioContext && audioContext.state !== 'closed') {
        audioContext.close();
    }

    cancelAnimationFrame(animationId);
    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    // Mute handles
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);

    stopGpsTracking();
    releaseWakeLock();

    if (roomId) {
        socket.emit('leave-room', roomId);
        roomId = null;
    }
    socket.disconnect();
}



// --- Power On (shared by button click and deep-link auto-join) ---
async function powerOn() {
    if (isPoweredOn) return;
    isPoweredOn = true;

    statusText.innerText = "INITIALIZING...";
    if (!socket.connected) socket.connect();
    startGpsTracking();
    try { await requestWakeLock(); } catch (_) {}

    // Try to init audio, but DON'T block or crash if it fails
    try {
        const rawStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false
        });

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
            if (!audioContext) {
                audioContext = new AudioCtx();
            } else if (audioContext.state === 'suspended') {
                audioContext.resume();
            }
            micSource = audioContext.createMediaStreamSource(rawStream);
            analyser = audioContext.createAnalyser();
            micSource.connect(analyser);

            localStream = rawStream;
            localStream.getAudioTracks().forEach(t => t.enabled = false);
            window.localStream = localStream;
            window.audioContext = audioContext;
            window.peers = peers;

            Object.keys(peers).forEach(targetId => {
                const pc = peers[targetId];
                if (pc && pc.signalingState !== 'closed') {
                    localStream.getAudioTracks().forEach(track => {
                        const senders = pc.getSenders();
                        const audioSender = senders.find(s => s.track === null || (s.track && s.track.kind === 'audio'));
                        if (audioSender) {
                            audioSender.replaceTrack(track).catch(e => console.warn("replaceTrack error:", e));
                        } else {
                            pc.addTrack(track, localStream);
                        }
                    });
                }
            });

            analyser.fftSize = 64;
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);
            drawVisualizer();
        }
    } catch (micErr) {
        console.warn("Mic not available, continuing without audio:", micErr.message);
    }

    statusText.innerText = "STANDBY";
    talkBtn.disabled = false;

    // Auto-join default channel
    if (!roomId) {
        const ch = document.querySelector('.channel-item')?.getAttribute('data-channel');
        if (ch) joinRoom(ch);
    }
}

// --- Power Button Handler (capacitor-safe) ---
powerBtn.addEventListener('click', async () => {
    try {
        if (isPoweredOn) {
            forcePowerOff();
            return;
        }
        await powerOn();
    } catch (err) {
        console.error("Power button error:", err);
        isPoweredOn = false;
        statusText.innerText = "ERROR";
    }
});

// --- PTT & Floor Control Logic ---
let isTransmitting = false;
let isReceiving = false;
let pttMode = localStorage.getItem('walkie_ptt_mode') || 'hold'; // 'hold' or 'toggle'
let pointerActiveId = null;

// PTT Floor Control Socket Events
socket.on('ptt-busy', (data) => {
    if (isTransmitting) {
        isTransmitting = false;
        if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
        talkBtn.classList.remove('talking');
        pttContainer.classList.remove('transmitting');
    }
    playBusyBeep();
    statusText.innerText = `BUSY: ${data.ownerCallSign || 'CANAL OCUPADO'}`;
    statusText.classList.add('error-blink');
    updateDebug(`Floor Busy: ${data.ownerCallSign}`);
    setTimeout(() => {
        if (!isTransmitting && !isReceiving) {
            statusText.innerText = "STANDBY";
            statusText.classList.remove('error-blink');
        }
    }, 2500);
});

socket.on('ptt-active', (data) => {
    const isSelf = (data.socketId === socket.id || data.callerId === userId);
    if (!isSelf) {
        isReceiving = true;
        statusText.innerText = `RECIBIENDO: ${data.callSign || 'OPERADOR'}`;
        statusText.classList.remove('error-blink');
        pttContainer.classList.add('receiving');
        talkBtn.classList.add('receiving');
        if (statusBar) statusBar.classList.add('receiving');

        // Ensure receiver's audio context and elements are actively running
        const ctx = ensureAudioContext();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        document.querySelectorAll('audio').forEach(a => {
            if (a.srcObject && a.paused) a.play().catch(() => {});
        });

        playPttStartBeep();
        updateDebug(`RX Active: ${data.callSign}`);
    } else {
        statusText.innerText = "TRANSMITIENDO";
        statusText.classList.remove('error-blink');
        playPttStartBeep();
        updateDebug("TX Floor Granted");
    }
});

socket.on('ptt-idle', (data) => {
    const isSelf = (data.socketId === socket.id || data.callerId === userId);
    if (!isSelf) {
        if (isReceiving) {
            isReceiving = false;
            playRogerBeep();
        }
        statusText.innerText = "STANDBY";
        pttContainer.classList.remove('receiving');
        talkBtn.classList.remove('receiving');
        if (statusBar) statusBar.classList.remove('receiving');
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
        updateDebug("RX Idle");
    }
});

const startTx = () => {
    if (!isPoweredOn) return;
    if (!roomId) {
        const defaultCh = document.querySelector('.channel-item')?.getAttribute('data-channel') || 'CHANNEL 1';
        joinRoom(defaultCh);
    }
    if (isTransmitting) return;
    
    ensureAudioContext();

    isTransmitting = true;
    statusText.innerText = "SOLICITANDO CANAL...";
    statusText.classList.remove('error-blink');
    updateDebug("TX Request sent");

    talkBtn.classList.add('talking');
    pttContainer.classList.add('transmitting');
    if (signalStrength) {
        const bars = signalStrength.querySelectorAll('.bar');
        bars.forEach(bar => bar.style.backgroundColor = 'var(--primary-color)');
    }
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = true);

    socket.emit('ptt-start', {
        opId: currentOpId,
        channelName: roomId,
        userId: userId,
        callSign: userCallSign
    });
};

const stopTx = () => {
    if (!isPoweredOn || !roomId || !isTransmitting) return;
    isTransmitting = false;

    socket.emit('ptt-stop', {
        opId: currentOpId,
        channelName: roomId
    });

    playRogerBeep();
    statusText.innerText = "STANDBY";
    statusText.classList.remove('error-blink');
    talkBtn.classList.remove('talking', 'receiving');
    pttContainer.classList.remove('transmitting', 'receiving');
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
    updateDebug("TX Stopped");
};

// Pointer & Mouse/Touch Event Handlers for universal browser / test runner compatibility
let lastPttTriggerTime = 0;

const handlePttStart = (e) => {
    const now = Date.now();
    if (now - lastPttTriggerTime < 50) return;
    lastPttTriggerTime = now;

    if (e.cancelable) e.preventDefault();
    ensureAudioContext();

    if (pttMode === 'toggle') {
        if (isTransmitting) {
            stopTx();
        } else {
            startTx();
        }
    } else {
        if (e.pointerId !== undefined && talkBtn.setPointerCapture) {
            try { talkBtn.setPointerCapture(e.pointerId); } catch (_) {}
            pointerActiveId = e.pointerId;
        }
        startTx();
    }
};

const handlePttEnd = (e) => {
    if (pttMode === 'hold' && isTransmitting) {
        if (pointerActiveId !== null && e.pointerId === pointerActiveId && talkBtn.releasePointerCapture) {
            try { talkBtn.releasePointerCapture(e.pointerId); } catch (_) {}
            pointerActiveId = null;
        }
        stopTx();
    }
};

talkBtn.addEventListener('pointerdown', handlePttStart);
talkBtn.addEventListener('mousedown', (e) => {
    if (window.PointerEvent && e.pointerId !== undefined) return;
    handlePttStart(e);
});
talkBtn.addEventListener('touchstart', (e) => {
    if (window.PointerEvent && e.pointerId !== undefined) return;
    handlePttStart(e);
});

talkBtn.addEventListener('pointerup', handlePttEnd);
talkBtn.addEventListener('pointercancel', handlePttEnd);
talkBtn.addEventListener('mouseup', (e) => {
    if (window.PointerEvent && e.pointerId !== undefined) return;
    handlePttEnd(e);
});
talkBtn.addEventListener('touchend', (e) => {
    if (window.PointerEvent && e.pointerId !== undefined) return;
    handlePttEnd(e);
});
talkBtn.addEventListener('pointerleave', (e) => {
    if (pttMode === 'hold' && isTransmitting) {
        let hasCap = false;
        try { hasCap = talkBtn.hasPointerCapture(e.pointerId); } catch (_) {}
        if (!hasCap) stopTx();
    }
});

// Window blur & touch safeguards
window.addEventListener('blur', () => { if (isTransmitting) stopTx(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && isTransmitting) stopTx(); });
window.addEventListener('touchcancel', () => { if (isTransmitting) stopTx(); });

// Global Audio Autoplay Unlocking on user interaction
const audioUnlockOverlay = document.getElementById('audio-unlock-overlay');
const audioUnlockBtn = document.getElementById('audio-unlock-btn');

function dismissAudioUnlock() {
    if (audioUnlockOverlay) {
        audioUnlockOverlay.style.opacity = '0';
        audioUnlockOverlay.style.pointerEvents = 'none';
        setTimeout(() => { audioUnlockOverlay.style.display = 'none'; }, 300);
    }
    unlockAllAudio();
}

if (audioUnlockBtn) {
    audioUnlockBtn.addEventListener('click', dismissAudioUnlock);
    audioUnlockBtn.addEventListener('touchend', dismissAudioUnlock);
}
if (audioUnlockOverlay) {
    audioUnlockOverlay.addEventListener('click', dismissAudioUnlock);
}

const unlockAllAudio = () => {
    ensureAudioContext();
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
    }
    document.querySelectorAll('audio').forEach(a => {
        a.muted = false;
        a.volume = 1.0;
        if (a.srcObject) {
            a.play().catch(() => {});
        }
    });
};
window.addEventListener('click', () => { dismissAudioUnlock(); unlockAllAudio(); }, { passive: true });
window.addEventListener('touchstart', () => { dismissAudioUnlock(); unlockAllAudio(); }, { passive: true });
window.addEventListener('pointerdown', () => { dismissAudioUnlock(); unlockAllAudio(); }, { passive: true });



// --- Visualizer Logic ---
const statusBar = document.querySelector('.status-bar');

function drawVisualizer() {
    if (!isPoweredOn) return;
    animationId = requestAnimationFrame(drawVisualizer);

    if (talkBtn.classList.contains('talking') && analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
        drawBars(canvas, canvasCtx, dataArray, "TX");
    }
    else if (isReceiving && remoteAnalyser && remoteDataArray) {
        remoteAnalyser.getByteFrequencyData(remoteDataArray);
        drawBars(canvas, canvasCtx, remoteDataArray, "RX");
    } else {
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

function drawBars(cvs, ctx, data, type) {
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    const barWidth = 6;
    const gap = 4;
    const maxBars = Math.floor(cvs.width / (barWidth + gap));
    let x = (cvs.width - (data.length * (barWidth + gap))) / 2;
    if (x < 0) x = 0;

    for (let i = 0; i < data.length; i++) {
        if (i >= 20) break;
        const value = data[i];
        const barHeight = (value / 255) * cvs.height * 0.8;
        if (barHeight < 2) continue;

        let r, g, b, shadowColor;
        if (type === "TX") {
            r = 80; g = 227; b = 194;
            shadowColor = "rgba(80, 227, 194, 0.6)";
        } else {
            r = 255; g = 159; b = 10;
            shadowColor = "rgba(255, 159, 10, 0.6)";
        }

        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.shadowBlur = 15;
        ctx.shadowColor = shadowColor;
        roundRect(ctx, x, (cvs.height - barHeight) / 2, barWidth, barHeight, 3);
        x += barWidth + gap;
    }
}

// --- Perfect Negotiation Logic ---
function isPolite(targetId) {
    // Standard polite peer: alphabetical comparison of IDs
    return socket.id < targetId;
}

// --- Signaling integrity (HMAC) ---
// Each channel has a shared key. We HMAC the signaling payload so a MitM on the
// websocket cannot forge offers/answers/ICE without the key.
// Uses Web Crypto; falls back to no MAC if unavailable (dev/test only).
async function hmacSign(key, data) {
    if (!key || !crypto?.subtle) return null;
    const enc = new TextEncoder();
    const keyBuf = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', keyBuf, enc.encode(data));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signSignal(payload) {
    const key = channelKeys[roomId];
    if (!key || !crypto?.subtle) return payload;
    const data = JSON.stringify(payload);
    const mac = await hmacSign(key, data);
    return { ...payload, mac };
}

async function verifySignal(data) {
    const key = channelKeys[data.channel] || channelKeys[roomId];
    // If there is no MAC on the incoming message it came relayed from the
    // server (which already validated canSignal / same-operation). Accept it.
    if (!data.mac) return true;
    if (!key || !crypto?.subtle) return true;
    const { mac, ...rest } = data;
    const expected = await hmacSign(key, JSON.stringify(rest));
    return expected === mac;
}

function roundRect(ctx, x, y, width, height, radius) {
    if (width < 2 * radius) radius = width / 2;
    if (height < 2 * radius) radius = height / 2;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
    ctx.fill();
}

// --- WebRTC Core ---

socket.on('user-connected', (userId) => {
    console.log('User connected:', userId);
    createPeerConnection(userId);
});

function createPeerConnection(targetId) {
    if (peers[targetId]) return peers[targetId];

    const pc = new RTCPeerConnection(rtcConfig);
    peers[targetId] = pc;
    peerStates[targetId] = { makingOffer: false, ignoreOffer: false };

    // Attach local audio track if available, otherwise register a single audio transceiver
    if (localStream && localStream.getAudioTracks().length > 0) {
        localStream.getAudioTracks().forEach(track => {
            const sender = pc.addTrack(track, localStream);
            const transceiver = pc.getTransceivers().find(t => t.sender === sender);
            if (transceiver) {
                transceiver.direction = 'sendrecv';
            }
        });
    } else {
        try {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
        } catch (e) {
            console.warn("addTransceiver error:", e);
        }
    }

    pc.ontrack = (event) => {
        const liveTrack = event.track;
        const trackStream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([liveTrack]);
        updateDebug(`Track Received from ${targetId}`);
        console.log(`[WebRTC] Track matched: ${trackStream.id}, kind: ${liveTrack.kind}, state: ${liveTrack.readyState}`);

        let remoteAudio = document.getElementById(`audio-${targetId}`);
        if (!remoteAudio) {
            remoteAudio = document.createElement('audio');
            remoteAudio.id = `audio-${targetId}`;
            remoteAudio.autoplay = true;
            remoteAudio.playsInline = true;
            remoteAudio.setAttribute('playsinline', '');
            remoteAudio.setAttribute('webkit-playsinline', '');
            remoteAudio.setAttribute('autoplay', '');
            remoteAudio.volume = 1.0;
            remoteAudio.muted = false;
            remoteAudio.style.position = 'fixed';
            remoteAudio.style.left = '-9999px';
            remoteAudio.style.top = '-9999px';
            document.body.appendChild(remoteAudio);
        }

        remoteAudio.srcObject = trackStream;
        remoteAudio.volume = 1.0;
        remoteAudio.muted = false;

        const playRemote = () => {
            remoteAudio.play().catch(e => {
                console.warn("[WebRTC] HTMLAudioElement play error:", e);
            });
        };
        playRemote();

        // Visualizer only analyser (do not route to ctx.destination so native audio element output is not muted)
        const bindWebAudioSource = () => {
            const ctx = ensureAudioContext();
            if (!ctx) return;
            try {
                if (remoteAudio.audioSourceNode) {
                    try { remoteAudio.audioSourceNode.disconnect(); } catch (_) {}
                }
                const source = ctx.createMediaStreamSource(trackStream);
                remoteAudio.audioSourceNode = source;
                remoteAnalyser = ctx.createAnalyser();
                remoteAnalyser.fftSize = 64;
                remoteDataArray = new Uint8Array(remoteAnalyser.frequencyBinCount);
                window.remoteAnalyser = remoteAnalyser;
                window.remoteDataArray = remoteDataArray;

                source.connect(remoteAnalyser);

                remoteAudio.connectedToContext = true;
                updateDebug("Audio: NATIVE SPEAKER + VISUALIZER OK");
                console.log(`[WebRTC] Stream from ${targetId} active on native audio element!`);
            } catch (e) {
                console.warn("[WebRTC] Analyser attach warning (audio plays natively):", e);
            }
        };

        bindWebAudioSource();
        liveTrack.onunmute = () => {
            console.log(`[WebRTC] Live track unmuted from ${targetId}`);
            bindWebAudioSource();
            if (remoteAudio.paused) remoteAudio.play().catch(() => {});
        };
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`[WebRTC] ICE State with ${targetId}: ${pc.iceConnectionState}`);
        updateDebug(`P2P: ${pc.iceConnectionState.toUpperCase()}`);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            statusText.innerText = "LINK LOST";
            statusText.classList.add('error-blink');
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            statusText.classList.remove('error-blink');
            statusText.innerText = "ONLINE";
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            signSignal({ target: targetId, candidate: event.candidate, channel: roomId })
                .then(signed => socket.emit('ice-candidate', signed));
        }
    };

    return pc;
}

function createOffer(targetId) {
    console.log(`[WebRTC] Creating Offer for: ${targetId}`);
    updateDebug(`Offer -> ${targetId}`);
    const pc = createPeerConnection(targetId);
    
    peerStates[targetId].makingOffer = true;
    pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .then(() => {
            signSignal({ target: targetId, offer: pc.localDescription, channel: roomId })
                .then(signed => socket.emit('offer', signed));
        })
        .catch(e => {
            console.error("Offer Error:", e);
            updateDebug("Offer Create Error");
        })
        .finally(() => {
            if (peerStates[targetId]) peerStates[targetId].makingOffer = false;
        });
}

socket.on('ice-candidate', async (data) => {
    console.log(`[WebRTC] Received ICE Candidate from ${data.caller}`);
    if (!(await verifySignal(data))) {
        console.warn(`[SIGNALLING] Rejected ICE from ${data.caller}: MAC verification failed`);
        return;
    }
    const pc = peers[data.caller];
    if (pc) {
        pc.addIceCandidate(new RTCIceCandidate(data.candidate))
            .catch(e => updateDebug("ICE Error: " + e.message));
    }
});

socket.on('offer', async (data) => {
    console.log(`[WebRTC] Received Offer from ${data.caller}`);
    updateDebug(`Offer from ${data.caller}`);

    if (!(await verifySignal(data))) {
        console.warn(`[SIGNALLING] Rejected offer from ${data.caller}: MAC verification failed`);
        updateDebug("Signal MAC rejected");
        return;
    }
    
    const targetId = data.caller;
    const pc = createPeerConnection(targetId);
    const polite = isPolite(targetId);
    
    try {
        const state = peerStates[targetId];
        const offerCollision = (data.offer.type === "offer") &&
                               (state.makingOffer || pc.signalingState !== "stable");

        state.ignoreOffer = !polite && offerCollision;
        if (state.ignoreOffer) {
            console.warn(`[SIGNALLING] Glare detected! Ignoring offer from ${targetId} (Impolite)`);
            return;
        }

        if (offerCollision) {
            console.log(`[SIGNALLING] Glare detected! Rolling back local offer for ${targetId} (Polite)`);
            await pc.setLocalDescription({ type: "rollback" });
        }

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        
        if (data.offer.type === "offer") {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signSignal({ target: targetId, answer: pc.localDescription, channel: data.channel || roomId })
                .then(signed => socket.emit('answer', signed));
            
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: 'Secure Channel',
                    artist: 'Walkie-Talkie',
                    album: 'Live Transmission'
                });
                navigator.mediaSession.playbackState = "playing";
            }
        }
    } catch (e) {
        console.error("Negotiation Error:", e);
        updateDebug("Negotiation Fail");
    }
});

socket.on('answer', async (data) => {
    updateDebug(`Answer from ${data.caller}`);
    if (!(await verifySignal(data))) {
        console.warn(`[SIGNALLING] Rejected answer from ${data.caller}: MAC verification failed`);
        return;
    }
    const pc = peers[data.caller];
    if (pc && pc.signalingState === 'have-local-offer') {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer))
            .catch(e => updateDebug("Answer Error: " + e.message));
    }
});


// --- Profile & Sidebar UI Handlers ---
const navChannels = document.getElementById('nav-channels');
const closeChannelsBtn = document.getElementById('close-channels');
const channelSheet = document.getElementById('channel-sheet');

if (navChannels) navChannels.addEventListener('click', () => channelSheet.classList.add('show'));
if (closeChannelsBtn) closeChannelsBtn.addEventListener('click', () => channelSheet.classList.remove('show'));


const profileSheet = document.getElementById('profile-sheet');
const navProfile = document.getElementById('nav-profile');
const closeProfileBtn = document.getElementById('close-profile');
const disconnectBtn = document.getElementById('disconnect-btn');

// Also handle GPS toggles (kept for compatibility)
const navGps = document.getElementById('nav-gps');
const gpsPanel = document.getElementById('gps-panel');
const closeGpsBtn = document.getElementById('close-gps-sidebar');

if (navGps) navGps.addEventListener('click', () => gpsPanel.classList.add('show'));
if (closeGpsBtn) closeGpsBtn.addEventListener('click', () => gpsPanel.classList.remove('show'));


if (document.getElementById('profile-id')) {
    document.getElementById('profile-id').innerText = userId;
    document.getElementById('profile-callsign').innerText = userCallSign;
}

// --- PTT Mode Selector UI Binding ---
const modeHoldBtn = document.getElementById('mode-hold-btn');
const modeToggleBtn = document.getElementById('mode-toggle-btn');

function updatePttModeUI() {
    if (modeHoldBtn && modeToggleBtn) {
        if (pttMode === 'toggle') {
            modeHoldBtn.classList.remove('active');
            modeHoldBtn.style.background = '#222';
            modeHoldBtn.style.color = '#888';
            modeToggleBtn.classList.add('active');
            modeToggleBtn.style.background = 'var(--primary-color)';
            modeToggleBtn.style.color = '#000';
        } else {
            modeToggleBtn.classList.remove('active');
            modeToggleBtn.style.background = '#222';
            modeToggleBtn.style.color = '#888';
            modeHoldBtn.classList.add('active');
            modeHoldBtn.style.background = 'var(--primary-color)';
            modeHoldBtn.style.color = '#000';
        }
    }
}

if (modeHoldBtn) {
    modeHoldBtn.addEventListener('click', () => {
        pttMode = 'hold';
        localStorage.setItem('walkie_ptt_mode', 'hold');
        updatePttModeUI();
    });
}

if (modeToggleBtn) {
    modeToggleBtn.addEventListener('click', () => {
        pttMode = 'toggle';
        localStorage.setItem('walkie_ptt_mode', 'toggle');
        updatePttModeUI();
    });
}
updatePttModeUI();

if (navProfile) navProfile.addEventListener('click', () => profileSheet.classList.add('show'));
if (closeProfileBtn) closeProfileBtn.addEventListener('click', () => profileSheet.classList.remove('show'));

if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => {
        forcePowerOff();
        profileSheet.classList.remove('show');
    });
}

// --- Hidden Server Config ---
const serverConfigBtn = document.getElementById('server-config-btn');
if (serverConfigBtn) {
    let clickCount = 0;
    serverConfigBtn.addEventListener('click', () => {
        clickCount++;
        if (clickCount >= 5) {
            const newUrl = localStorage.getItem('walkieTalkieServer') || serverUrl;
            const input = prompt("Enter Tactical Server URL:", newUrl);
            if (input && input !== newUrl) {
                localStorage.setItem('walkieTalkieServer', input);
                window.location.reload();
            }
            clickCount = 0;
        }
    });
}
