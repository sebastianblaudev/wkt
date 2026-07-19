const getServerUrl = () => {
    // 1. Manually set override
    if (localStorage.getItem('walkieTalkieServer')) {
        return localStorage.getItem('walkieTalkieServer');
    }

    // 2. Network/Local Development
    const hostname = window.location.hostname;
    const port = window.location.port;

    // If we are on port 3001/5173 (Vite/Dev), connect to local backend
    if (port === '3001' || port === '5173' || hostname === 'localhost') {
        if (hostname === 'localhost' && !port) {
            // Likely Capacitor on Android/iOS
            return "https://walkie-talkie-server-fix.onrender.com";
        }
        return `http://${hostname}:3000`;
    }

    // 3. Fallback to production Render URL if not on a standard web domain
    if (hostname.includes('onrender.com')) {
        return window.location.origin;
    }

    return "https://walkie-talkie-server-fix.onrender.com";
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

// --- Operation Logic ---
let currentOpId = null;
const urlParams = new URLSearchParams(window.location.search);
let opIdParam = urlParams.get('op');
let tokenParam = urlParams.get('token');

// --- Capacitor Deep Linking ---
try {
    const { App } = window.Capacitor?.Plugins || {};
    if (App && typeof App.addListener === 'function') {
        App.addListener('appUrlOpen', (event) => {
            console.log('App opened with URL:', event.url);
            try {
                const url = new URL(event.url);
                const op = url.searchParams.get('op');
                const token = url.searchParams.get('token');

                if (op && token) {
                    opIdParam = op;
                    tokenParam = token;
                    currentOpId = op;

                    if (!isPoweredOn) {
                        const startOverlay = document.getElementById('start-overlay');
                        if (startOverlay) startOverlay.click();
                    } else {
                        // Reconnect to join new operation
                        socket.disconnect();
                        socket.connect();
                    }
                }
            } catch (e) { console.error("Error parsing deep link", e); }
        });
    }
} catch (e) {
    console.warn("Capacitor App plugin not found, skipping deep link attach.");
}

// --- Auto-Initialize Logic ---
const autoInit = () => {
    console.log("System Auto-Initialization...");
    if (!isPoweredOn) {
        powerBtn.click();
    }
};

window.addEventListener('load', () => {
    // Try auto-init after a short delay
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
const debugInfo = document.createElement('div');
debugInfo.style = "position:fixed; bottom:10px; right:10px; color:#50E3C2; font-size:9px; font-family:monospace; pointer-events:none; z-index:1000; background:rgba(0,0,0,0.5); padding:5px;";
document.body.appendChild(debugInfo);
function updateDebug(msg) { debugInfo.innerText = msg; console.log("[DEBUG]", msg); }
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
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.ekiga.net' },
    { urls: 'stun:stun.ideasip.com' }
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
        // Only initiate if my ID is "smaller" to avoid Glare
        if (socket.id < targetId) {
            console.log(`[SIGNALLING] Initiating offer to existing user: ${targetId}`);
            createOffer(targetId);
        } else {
            console.log(`[SIGNALLING] Waiting for offer from: ${targetId}`);
        }
    });
});

// Socket Connect Handler moved below joinRoom for better scoping

socket.on('operation-config', (config) => {
    console.log("Joined Operation:", config.opId);
    currentOpId = config.opId;
    statusText.innerText = `OP: ${config.opId.toUpperCase()}`;
    updateChannelUI(config.channels);

    // Persist op/token so we can auto re-join after a server "wake"/reconnect.
    if (opIdParam && tokenParam) {
        localStorage.setItem('walkie_op_id', opIdParam);
        localStorage.setItem('walkie_op_token', tokenParam);
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

    // Auto-join default channel if not already in one
    if (config.defaultChannel && !roomId && isPoweredOn) {
        console.log("Auto-joining default channel:", config.defaultChannel);
        joinRoom(config.defaultChannel);
    }
});

function playTacticalAlert() {
    if (!audioContext) return;
    if (audioContext.state === 'suspended') audioContext.resume();
    try {
        const osc = audioContext.createOscillator();
        const gainInfo = audioContext.createGain();
        osc.connect(gainInfo);
        gainInfo.connect(audioContext.destination);

        osc.type = 'square';
        osc.frequency.setValueAtTime(880, audioContext.currentTime); // A5
        osc.frequency.setValueAtTime(1108.73, audioContext.currentTime + 0.1); // C#6

        gainInfo.gain.setValueAtTime(0, audioContext.currentTime);
        gainInfo.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.02);
        gainInfo.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.4);

        osc.start(audioContext.currentTime);
        osc.stop(audioContext.currentTime + 0.5);
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
    alert("ACCESS DENIED: " + msg);
    statusText.innerText = "ACCESS DENIED";
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
                    alert("Power ON the device first!");
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

    roomInput.value = roomId;
    statusText.innerText = "TUNING...";
    joinBtn.disabled = true;
    roomInput.disabled = true;
    talkBtn.disabled = false;

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
        statusText.innerText = "ONLINE";
        updateDebug(`Channel: ${room}`);
    }, 500);
}

// Update connect handler to join channel if roomId is set
// This handles the Reconnect case in joinRoom
const originalConnectHandler = socket.listeners('connect')[0];
socket.off('connect'); // Remove old one to replace/wrap it

socket.on('connect', () => {
    updateDebug("Network Link: ESTABLISHED");
    console.log('Socket Connected!', socket.id);

    // Attempt Join Operation if params exist, else use last persisted session
    // (so a server wake/reconnect auto-restores the operator's channel).
    const savedOp = localStorage.getItem('walkie_op_id');
    const savedToken = localStorage.getItem('walkie_op_token');
    const joinOp = opIdParam || savedOp;
    const joinToken = tokenParam || savedToken;
    if (joinOp && joinToken) {
        socket.emit('join-operation', {
            opId: joinOp,
            token: joinToken,
            userId: localStorage.getItem('walkie_user_id') || generateUUID(),
            callSign: localStorage.getItem('walkie_callsign') || 'OPERATOR'
        });
    }
});

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
            if (error.code === 1) statusText.innerText = "NO LOCATION";
            if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
                statusText.innerText = "GPS BLOCKED";
            }
        }, {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 10000
        });
    } else {
        alert("Geolocation not supported.");
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
    statusText.innerText = "OFFLINE";
    statusText.className = "";
    joinBtn.disabled = true;
    talkBtn.disabled = true;
    pttContainer.classList.remove('transmitting', 'receiving');

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

// --- Man Down Protocol Logic ---
// Man Down can be disabled via ?manDown=0 or a stored preference (e.g. for testing).
const manDownEnabled = (() => {
    const p = new URLSearchParams(window.location.search).get('manDown');
    if (p === '0') return false;
    if (p === '1') return true;
    return localStorage.getItem('walkie_man_down') !== '0';
})();

let manDownTimer = null;
let sosCountdown = 15;
let lastMotionTime = Date.now();
const INACTIVITY_THRESHOLD = 60000; // 60 seconds
const FALL_THRESHOLD = 20; // High acceleration
let isSosActive = false;
let sosCountdownInterval = null;

const sosOverlay = document.getElementById('sos-countdown-overlay');
const sosTimerDisplay = document.getElementById('sos-timer');
const cancelSosBtn = document.getElementById('cancel-sos-btn');

function triggerManDown() {
    if (!manDownEnabled) return;
    if (!isPoweredOn || isSosActive) return;
    isSosActive = true;
    sosCountdown = 15;

    playTacticalAlert();

    if (sosOverlay && sosTimerDisplay) {
        sosTimerDisplay.innerText = `ACTIVATING SOS IN ${sosCountdown}s`;
        sosOverlay.classList.remove('hidden');
        sosOverlay.classList.add('show');
    }

    if (navigator.vibrate) {
        navigator.vibrate([500, 200, 500, 200, 500]);
    }

    sosCountdownInterval = setInterval(() => {
        sosCountdown--;
        if (sosTimerDisplay) sosTimerDisplay.innerText = `ACTIVATING SOS IN ${sosCountdown}s`;

        if (sosCountdown <= 0) {
            clearInterval(sosCountdownInterval);
            emitSosAlert();
        }
    }, 1000);
}

if (cancelSosBtn) {
    cancelSosBtn.addEventListener('click', () => {
        isSosActive = false;
        clearInterval(sosCountdownInterval);
        if (sosOverlay) {
            sosOverlay.classList.remove('show');
            setTimeout(() => sosOverlay.classList.add('hidden'), 300);
        }
        lastMotionTime = Date.now();
    });
}

function emitSosAlert() {
    if (sosOverlay && sosTimerDisplay) {
        sosTimerDisplay.innerText = "SOS TRANSMITTED";
        setTimeout(() => {
            sosOverlay.classList.remove('show');
            setTimeout(() => sosOverlay.classList.add('hidden'), 300);
        }, 3000);
    }

    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition((position) => {
            socket.emit('sos-alert', { lat: position.coords.latitude, lng: position.coords.longitude });
        }, () => {
            socket.emit('sos-alert', { lat: 0, lng: 0 });
        });
    } else {
        socket.emit('sos-alert', { lat: 0, lng: 0 });
    }
}

window.addEventListener('devicemotion', (e) => {
    if (!isPoweredOn) return;
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;

    const magnitude = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);

    if (magnitude > FALL_THRESHOLD) {
        console.log("Significant impact detected.");
        triggerManDown();
    }

    if (Math.abs(magnitude - 9.8) > 1.0) {
        lastMotionTime = Date.now();
    }
});

setInterval(() => {
    if (!isPoweredOn || isSosActive) return;
    if (Date.now() - lastMotionTime > INACTIVITY_THRESHOLD) {
        console.log("Inactivity detected.");
        triggerManDown();
    }
    // Periodic MediaSession refresh to keep alive
    if (isPoweredOn && roomId) updateMediaSession();
}, 5000);

powerBtn.addEventListener('click', async () => {
    isPoweredOn = !isPoweredOn;
    if (isPoweredOn) {
        statusText.innerText = "INITIALIZING...";
        if (!socket.connected) socket.connect();
        startGpsTracking();
        await requestWakeLock();

        try {
            const rawStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } else if (audioContext.state === 'suspended') {
                audioContext.resume();
            }
            micSource = audioContext.createMediaStreamSource(rawStream);
            analyser = audioContext.createAnalyser();

            micSource.connect(analyser);

            localStream = rawStream;
            localStream.getAudioTracks().forEach(t => t.enabled = false);

            // --- Track Injection into existing peers ---
            Object.keys(peers).forEach(targetId => {
                const pc = peers[targetId];
                if (pc && pc.signalingState !== 'closed') {
                    localStream.getTracks().forEach(track => {
                        // Avoid adding twice
                        const senders = pc.getSenders();
                        const exists = senders.some(s => s.track && s.track.kind === track.kind);
                        if (!exists) {
                            pc.addTrack(track, localStream);
                        }
                    });
                    // Renegotiate
                    createOffer(targetId);
                }
            });

            analyser.fftSize = 64;
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);

            drawVisualizer();
            statusText.innerText = "STANDBY";
            joinBtn.disabled = false;

            // Trigger auto-join if we already received config but weren't powered on
            const firstChannel = document.querySelector('.channel-item')?.getAttribute('data-channel');
            if (!roomId && firstChannel) { // Fallback if we don't have the config handy but UI rendered
                const chItems = document.querySelectorAll('.channel-item');
                let targetCh = firstChannel;
                chItems.forEach(i => { if (i.getAttribute('data-channel') === 'BASE') targetCh = 'BASE'; });
                joinRoom(targetCh);
            }
            updateOverlayState();
        } catch (err) {
            console.error("Error accessing microphone:", err);
            statusText.innerText = "MIC ERROR";
            alert("Microphone access required!");
            forcePowerOff();
        }
    } else {
        forcePowerOff();
    }
});

// --- PTT Logic ---

const startTx = () => {
    if (!isPoweredOn || !roomId) return;
    
    // Reset inactivity timer on PTT action
    lastMotionTime = Date.now();
    updateDebug("PTT Active - Timer Reset");

    // Resume context on EVERY talk click to be 100% sure
    if (audioContext && audioContext.state === 'suspended') audioContext.resume();

    // Tactical beep removed by user request
    // playTacticalAlert();

    statusText.innerText = "TRANSMITTING";
    updateDebug("TX Active");
    talkBtn.classList.add('talking');
    pttContainer.classList.add('transmitting');
    if (signalStrength) {
        const bars = signalStrength.querySelectorAll('.bar');
        bars.forEach(bar => bar.style.backgroundColor = 'var(--primary-color)');
    }
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = true);
};

const stopTx = () => {
    if (!isPoweredOn || !roomId) return;
    statusText.innerText = "STANDBY";
    talkBtn.classList.remove('talking');
    pttContainer.classList.remove('transmitting');
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
};

talkBtn.addEventListener('mousedown', startTx);
window.addEventListener('mouseup', stopTx);
talkBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTx(); });
talkBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTx(); });


// --- Visualizer Logic ---
let isReceiving = false;
const statusBar = document.querySelector('.status-bar');

function drawVisualizer() {
    if (!isPoweredOn) return;
    animationId = requestAnimationFrame(drawVisualizer);

    if (talkBtn.classList.contains('talking')) {
        analyser.getByteFrequencyData(dataArray);
        drawBars(canvas, canvasCtx, dataArray, "TX");
    }
    else if (remoteAnalyser && remoteDataArray) {
        remoteAnalyser.getByteFrequencyData(remoteDataArray);
        const sum = remoteDataArray.reduce((a, b) => a + b, 0);
        const average = sum / remoteDataArray.length;

        if (average > 10) {
            if (!isReceiving) {
                isReceiving = true;
                statusText.innerText = "RECEIVING...";
                statusBar.classList.add('receiving');
                talkBtn.classList.add('receiving');
            }
            drawBars(canvas, canvasCtx, remoteDataArray, "RX");
        } else {
            if (isReceiving) {
                isReceiving = false;
                statusText.innerText = "STANDBY";
                statusBar.classList.remove('receiving');
                talkBtn.classList.remove('receiving');
                canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
            }
        }
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
    // Standard initiation: Only initiate if I'm the designated "caller" (ID comparison)
    if (socket.id < userId) {
        console.log(`[SIGNALLING] I am polite caller for ${userId}, initiating offer...`);
        createOffer(userId);
    }
});

function createPeerConnection(targetId) {
    if (peers[targetId]) return peers[targetId];

    const pc = new RTCPeerConnection(rtcConfig);
    peers[targetId] = pc;
    peerStates[targetId] = { makingOffer: false, ignoreOffer: false };

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.ontrack = (event) => {
        const stream = event.streams[0];
        updateDebug(`Track Received from ${targetId}`);
        console.log(`[WebRTC] Track matched: ${stream.id}`);

        let remoteAudio = document.getElementById(`audio-${targetId}`);
        if (!remoteAudio) {
            remoteAudio = new Audio();
            remoteAudio.id = `audio-${targetId}`;
            remoteAudio.autoplay = true;
            remoteAudio.playsInline = true;
            // NOTE: display:none can prevent playback on some mobile browsers.
            // Keep it in the layout but invisible/silent instead.
            remoteAudio.style.position = 'absolute';
            remoteAudio.style.width = '1px';
            remoteAudio.style.height = '1px';
            remoteAudio.style.opacity = '0';
            remoteAudio.style.pointerEvents = 'none';
            remoteAudio.style.left = '-10px';
            remoteAudio.style.top = '-10px';
            document.body.appendChild(remoteAudio);
        }

        // Play directly through the <audio> element (most reliable on mobile).
        remoteAudio.srcObject = stream;
        remoteAudio.volume = 1.0;

        const playRemote = () => {
            remoteAudio.play().catch(e => {
                console.warn("Playback blocked, waiting for interaction", e);
                updateDebug("TAP SCREEN TO HEAR AUDIO");
                statusText.innerText = "AUDIO BLOCKED - TAP";
                statusText.classList.add('error-blink');
            });
        };
        playRemote();

        // Visualizer only: feed the stream into an analyser. Do NOT connect to
        // audioContext.destination — that double-routes and can mute output on
        // mobile when the AudioContext is suspended by autoplay policy.
        if (audioContext) {
            audioContext.resume().catch(() => {});
            try {
                if (!remoteAudio.connectedToContext) {
                    const source = audioContext.createMediaStreamSource(stream);
                    remoteAnalyser = audioContext.createAnalyser();
                    remoteAnalyser.fftSize = 64;
                    remoteDataArray = new Uint8Array(remoteAnalyser.frequencyBinCount);
                    source.connect(remoteAnalyser);
                    remoteAudio.connectedToContext = true;
                    updateDebug("Audio Graph: VISUALIZER OK");
                    statusText.classList.remove('error-blink');
                    if (statusText.innerText.startsWith("AUDIO BLOCKED")) statusText.innerText = "ONLINE";
                }
            } catch (e) {
                updateDebug("Bridge Error: " + e.message);
            }
        }
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


let userId = localStorage.getItem('walkie_user_id');
if (!userId) {
    userId = 'U-' + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem('walkie_user_id', userId);
}
const callSigns = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ROVER', 'EAGLE'];
let userCallSign = localStorage.getItem('walkie_callsign');
if (!userCallSign) {
    const randomName = callSigns[Math.floor(Math.random() * callSigns.length)];
    const randomNum = Math.floor(1 + Math.random() * 99).toString().padStart(2, '0');
    userCallSign = `${randomName}-${randomNum}`;
    localStorage.setItem('walkie_callsign', userCallSign);
}

if (document.getElementById('profile-id')) {
    document.getElementById('profile-id').innerText = userId;
    document.getElementById('profile-callsign').innerText = userCallSign;
}

if (navProfile) navProfile.addEventListener('click', () => profileSheet.classList.add('show'));
if (closeProfileBtn) closeProfileBtn.addEventListener('click', () => profileSheet.classList.remove('show'));

if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => {
        if (confirm('Disconnect from secure network?')) {
            forcePowerOff();
            profileSheet.classList.remove('show');
        }
    });
}

// --- Start Overlay Logic (Auto-hide if power on succeeds) ---
const startOverlay = document.getElementById('start-overlay');

function updateOverlayState() {
    if (isPoweredOn && startOverlay) {
        startOverlay.style.opacity = '0';
        setTimeout(() => startOverlay.remove(), 500);
    }
}

// Watch for power state to hide overlay automatically
const originalPowerOn = powerBtn.onclick; // We don't use onclick, we use listeners. 
// Instead, let's just check in an interval or trigger from the click listener itself.

// --- Hidden Server Config ---
const serverConfigBtn = document.getElementById('server-config-btn');
if (serverConfigBtn) {
    let clickCount = 0;
    serverConfigBtn.addEventListener('click', () => {
        clickCount++;
        if (clickCount >= 5) {
            const newUrl = prompt("Enter Tactical Server URL:", serverUrl);
            if (newUrl) {
                localStorage.setItem('walkieTalkieServer', newUrl);
                window.location.reload();
            }
            clickCount = 0;
        }
    });
}
