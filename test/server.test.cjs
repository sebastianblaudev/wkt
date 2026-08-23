// Integration tests for server AI handlers (socket + HTTP).
// Starts the server in mock mode and exercises the real socket flow.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const { execSync } = require('child_process');
const PORT = 3999;
const URL = `http://localhost:${PORT}`;
let server;

process.on('exit', () => { try { if (server) server.kill('SIGKILL'); } catch (_) {} });
process.on('uncaughtException', (err) => { console.error(err); try { if (server) server.kill('SIGKILL'); } catch (_) {} process.exit(1); });

function startServer() {
    try {
        execSync(`kill -9 $(lsof -t -i:${PORT}) 2>/dev/null || true`);
    } catch (_) {}
    return new Promise((resolve, reject) => {
        server = spawn('node', ['server.cjs'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), SUPER_ADMIN_KEY: 'test-key', SIGNAL_SECRET: 'test-sig', NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let out = '';
        server.stdout.on('data', d => { out += d; if (out.includes('Server running')) resolve(); });
        server.stderr.on('data', d => process.stderr.write(d));
        setTimeout(() => reject(new Error('server start timeout')), 8000);
    });
}

function connect() { return io(URL, { transports: ['websocket'], forceNew: true }); }

function emitUntil(sock, event, payload, listen, timeout = 4000) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting ' + listen)), timeout);
        sock.once(listen, d => { clearTimeout(t); resolve(d); });
        sock.emit(event, payload);
    });
}

let passed = 0;
function test(name, fn) {
    return (async () => {
        try { await fn(); passed++; console.log('  ✓', name); }
        catch (e) { console.error('  ✗', name, '\n    ', e.message); process.exitCode = 1; }
    })();
}

async function run() {
    await startServer();
    const admin = connect();
    const client = connect();
    const opId = 'itest-' + Math.floor(Math.random() * 10000);
    let token = null;

    console.log('Server integration tests');

    await test('super-admin login and tenant creation', async () => {
        await new Promise(r => admin.on('connect', r));
        admin.emit('login-super-admin', { key: 'test-key' });
        const auth = await emitUntil(admin, 'create-tenant', { key: 'test-key', opId, password: 'p' }, 'tenant-created');
        token = auth.token;
        assert.ok(token);
    });

    await test('admin login and authentication', async () => {
        admin.emit('login-admin', { opId, password: 'p' });
        await emitUntil(admin, 'login-admin', { opId, password: 'p' }, 'admin-authenticated');
    });

    await test('autonomy mode change', async () => {
        const mode = await new Promise((resolve) => {
            const t = setTimeout(() => resolve('TIMEOUT'), 4000);
            admin.on('autonomy-mode', m => {
                if (m === 'SUGGEST_APPROVE') { clearTimeout(t); resolve(m); }
            });
            admin.emit('set-autonomy-mode', { mode: 'SUGGEST_APPROVE' });
        });
        assert.strictEqual(mode, 'SUGGEST_APPROVE');
    });

    await test('unit join operation', async () => {
        if (!client.connected) await new Promise(r => client.on('connect', r));
        client.emit('join-operation', { opId, token, userId: 'u1', callSign: 'ALPHA' });
        await emitUntil(client, 'join-operation', { opId, token, userId: 'u1', callSign: 'ALPHA' }, 'operation-config');
        client.emit('update-location', { id: 'u1', lat: 19.4, lng: -99.1 });
    });

    await test('request timeline via socket', async () => {
        admin.emit('request-timeline');
        const tl = await emitUntil(admin, 'request-timeline', {}, 'timeline');
        assert.ok(Array.isArray(tl.events));
    });

    await test('HTTP timeline endpoint', async () => {
        const http = await fetch(`${URL}/timeline/${opId}`);
        const body = await http.json();
        assert.ok(Array.isArray(body.events));
    });

    admin.close(); client.close();
    server.kill();
    console.log(`\n${passed} passed`);
    process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
