const getServerUrl = () => {
    const hostname = window.location.hostname;
    const port = window.location.port;
    if (port === '3001' || port === '5173') {
        return `http://${hostname}:3000`;
    }
    return window.location.origin;
};
const url = getServerUrl();
console.log(`Connecting to Socket.IO at: ${url}`);
const socket = io(url, {
    reconnection: true,
    reconnectionAttempts: 10,
    timeout: 10000
});

// State
let masterToken = '';

// DOM Elements
const loginDiv = document.getElementById('super-login');
const dashDiv = document.getElementById('super-dashboard');
const masterKeyInput = document.getElementById('master-key');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');

const createOpBtn = document.getElementById('create-op-btn');
const newOpIdInput = document.getElementById('new-op-id');
const newOpPassInput = document.getElementById('new-op-pass');
const createMsg = document.getElementById('create-msg');

const opList = document.getElementById('op-list');
const refreshBtn = document.getElementById('refresh-btn');

// --- Login ---

loginBtn.addEventListener('click', () => {
    const key = masterKeyInput.value.trim();
    if (!key) return;

    if (!socket.connected) {
        loginError.innerText = "Connecting to server... Please wait.";
        loginError.style.display = 'block';
        loginError.style.color = "#ff9f0a";
        
        socket.connect();
        
        let attempts = 0;
        const checkConn = setInterval(() => {
            attempts++;
            if (socket.connected) {
                clearInterval(checkConn);
                loginError.style.display = 'none';
                socket.emit('login-super-admin', { key });
            } else if (attempts > 20) {
                clearInterval(checkConn);
                loginError.innerText = "Error: Could not connect to server at " + url;
                loginError.style.color = "#ff5e57";
            }
        }, 200);
        return;
    }

    socket.emit('login-super-admin', { key });
});

socket.on('connect', () => {
    console.log('Connected to server via Socket.IO');
});

socket.on('super-admin-auth', ({ success, msg, token }) => {
    console.log('Auth Response:', { success, msg });
    if (success) {
        masterToken = token; // Currently just reusing the key or a session token if server provided one
        loginDiv.style.display = 'none';
        dashDiv.style.display = 'block';
        fetchOperations();
    } else {
        loginError.innerText = msg || 'Auth Failed';
        loginError.style.display = 'block';
    }
});

// --- Create Operation ---

createOpBtn.addEventListener('click', () => {
    const opId = newOpIdInput.value.trim();
    const password = newOpPassInput.value.trim();

    if (!opId || !password) {
        createMsg.innerText = "All fields required.";
        createMsg.style.color = "#ff5e57";
        return;
    }

    socket.emit('create-tenant', {
        key: masterKeyInput.value.trim(), // Send key for verification
        opId,
        password
    });
});

socket.on('tenant-created', ({ success, msg, opId, token }) => {
    if (success) {
        const inviteUrl = `${window.location.origin}/?op=${opId}&token=${token}`;
        
        createMsg.innerHTML = `
            <div style="background: rgba(80, 227, 194, 0.1); padding: 15px; border-radius: 8px; border: 1px solid #50E3C2; margin-top: 15px;">
                <p style="color: #50E3C2; margin: 0 0 10px 0; font-weight: 600;">Operation '${opId}' Created!</p>
                <p style="font-size: 12px; color: #aaa; margin-bottom: 8px;">Share this link with operators:</p>
                <div style="display: flex; gap: 8px;">
                    <input type="text" value="${inviteUrl}" readonly style="flex: 1; font-size: 11px; padding: 8px; background: #000; border: 1px solid #333;">
                    <button id="copy-invite-btn" style="width: auto; padding: 0 15px; font-size: 12px; height: 34px;">COPY</button>
                </div>
            </div>
        `;
        
        document.getElementById('copy-invite-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(inviteUrl).then(() => {
                const btn = document.getElementById('copy-invite-btn');
                btn.innerText = "COPIED!";
                btn.style.background = "#fff";
                setTimeout(() => {
                    btn.innerText = "COPY";
                    btn.style.background = "#50E3C2";
                }, 2000);
            });
        });

        newOpIdInput.value = '';
        newOpPassInput.value = '';
        fetchOperations();
    } else {
        createMsg.innerText = msg;
        createMsg.style.color = "#ff5e57";
    }
});

// --- List Operations ---

refreshBtn.addEventListener('click', fetchOperations);

function fetchOperations() {
    socket.emit('list-tenants', { key: masterKeyInput.value.trim() });
}

socket.on('tenants-list', (tenants) => {
    // tenants is array of { opId, activeUnitsDefaultCount?? }
    opList.innerHTML = '';

    if (tenants.length === 0) {
        opList.innerHTML = '<li class="op-item" style="justify-content:center; color:#666;">No Active Operations</li>';
        return;
    }

    tenants.forEach(t => {
        const li = document.createElement('li');
        li.className = 'op-item';
        li.innerHTML = `
            <div class="op-info">
                <strong>${t.opId}</strong>
                <span>Password: ${t.adminPass}</span>
            </div>
            <span class="status-active">ACTIVE</span>
        `;
        opList.appendChild(li);
    });
});
