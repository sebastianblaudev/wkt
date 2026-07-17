import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as Client } from 'socket.io-client';
import { server } from '../server.cjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOCK_DB_PATH = path.join(__dirname, '../mock_db.json');

// Master key used by the super-admin tests. Falls back to a dev value so the
// suite can run without secrets configured. Never hardcode production keys.
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || 'test-master-key';

describe('Socket Server Integration (server.cjs)', () => {
    let clientSocket;
    const port = 3001;

    beforeAll(() => {
        // Start from a clean mock DB so token/tenant tests are deterministic.
        try {
            fs.writeFileSync(MOCK_DB_PATH, JSON.stringify({
                operations: [], channels: [], operation_tokens: [], units: []
            }, null, 2));
        } catch (e) { /* ignore */ }
        return new Promise((resolve) => {
            server.listen(port, () => {
                resolve();
            });
        });
    });

    afterAll(() => {
        server.close();
    });

    it('should connect and authenticate a super admin', () => {
        return new Promise((resolve) => {
            clientSocket = new Client(`http://localhost:${port}`);
            clientSocket.on('connect', () => {
                clientSocket.emit('login-super-admin', { key: SUPER_ADMIN_KEY });
                clientSocket.on('super-admin-auth', (data) => {
                    expect(data.success).toBe(true);
                    clientSocket.disconnect();
                    resolve();
                });
            });
        });
    });

    it('should create a tenant and list it', () => {
        return new Promise((resolve) => {
            clientSocket = new Client(`http://localhost:${port}`);
            clientSocket.on('connect', () => {
                clientSocket.emit('create-tenant', { 
                    key: SUPER_ADMIN_KEY,
                    opId: 'test-op-1', 
                    password: 'pass' 
                });
                clientSocket.on('tenant-created', (data) => {
                    expect(data.success).toBe(true);
                    expect(data.opId).toBe('test-op-1');

                    clientSocket.emit('list-tenants', { key: SUPER_ADMIN_KEY });
                    clientSocket.on('tenants-list', (list) => {
                        expect(list.some(t => t.opId === 'test-op-1')).toBe(true);
                        clientSocket.disconnect();
                        resolve();
                    });
                });
            });
        });
    });

    it('should receive existing users when joining a channel', () => {
        const client1 = new Client(`http://localhost:${port}`, { autoConnect: false });
        const client2 = new Client(`http://localhost:${port}`, { autoConnect: false });
        
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Test timed out manually")), 8000);
            let token1 = null, token2 = null;

            // Create a tenant and grab two invite tokens (single-use each).
            const admin = new Client(`http://localhost:${port}`);
            admin.on('connect', () => {
                admin.emit('create-tenant', { key: SUPER_ADMIN_KEY, opId: 'channel-test-op', password: 'pw' });
            });
            admin.on('tenant-created', (t) => {
                token1 = t.token;
                admin.emit('generate-invite', { opId: 'channel-test-op' });
            });
            admin.on('invite-generated', (inv) => {
                token2 = inv.token;
                admin.disconnect();
            });

            client1.on('connect', () => {
                console.log("Client 1 connected");
                client1.emit('join-operation', { opId: 'channel-test-op', token: token1, userId: 'u1', callSign: 'C1' });
                client1.on('operation-config', () => {
                    console.log("Client 1 config received");
                    client1.emit('join-channel', { opId: 'channel-test-op', channelName: 'CHANNEL 1' });

                    // Once client1 is in, join client2 after a short delay
                    setTimeout(() => {
                        client2.on('connect', () => {
                            console.log("Client 2 connected");
                            client2.emit('join-operation', { opId: 'channel-test-op', token: token2, userId: 'u2', callSign: 'C2' });
                            client2.on('operation-config', () => {
                                console.log("Client 2 config received");
                                client2.emit('join-channel', { opId: 'channel-test-op', channelName: 'CHANNEL 1' });
                                client2.on('room-users', (users) => {
                                    console.log("Client 2 room-users received:", users);
                                    expect(users).toContain(client1.id);
                                    client1.disconnect();
                                    client2.disconnect();
                                    clearTimeout(timeout);
                                    resolve();
                                });
                            });
                        });
                        client2.connect();
                    }, 500);
                });
            });
            client1.connect();
        }, 12000);
    });

    it('should handle operator joining an operation and channel', () => {
        return new Promise((resolve) => {
            clientSocket = new Client(`http://localhost:${port}`);
            let inviteToken = null;
            clientSocket.on('connect', () => {
                // Create a fresh tenant and capture its invite token.
                clientSocket.emit('create-tenant', { key: SUPER_ADMIN_KEY, opId: 'join-test-op', password: 'pw' });
                clientSocket.on('tenant-created', (t) => {
                    inviteToken = t.token;

                    clientSocket.emit('join-operation', {
                        opId: 'join-test-op',
                        token: inviteToken,
                        userId: 'u1',
                        callSign: 'SIG-1'
                    });
                });

                clientSocket.on('operation-config', (config) => {
                    expect(config.opId).toBe('join-test-op');
                    expect(config.channels).toContain('CHANNEL 1');

                    clientSocket.emit('join-channel', { opId: 'join-test-op', channelName: 'CHANNEL 1' });
                    // No direct event for success, but we can check if we receive room size
                    clientSocket.on('channel-users-count', (count) => {
                        expect(count).toBeGreaterThan(0);
                        clientSocket.disconnect();
                        resolve();
                    });
                });
            });
        });
    });

    it('should reject joining with an invalid token', () => {
        return new Promise((resolve) => {
            const c = new Client(`http://localhost:${port}`);
            c.on('connect', () => {
                c.emit('join-operation', { opId: 'join-test-op', token: 'wrong-token', userId: 'x', callSign: 'X' });
                c.on('join-error', (msg) => {
                    expect(msg).toBeTruthy();
                    c.disconnect();
                    resolve();
                });
            });
        });
    });

    it('should reject reusing an already-used token', () => {
        return new Promise((resolve, reject) => {
            const fail = (err) => { reject(err instanceof Error ? err : new Error(String(err))); };
            const timer = setTimeout(() => fail('timeout waiting for token reuse rejection'), 8000);
            const admin = new Client(`http://localhost:${port}`);
            let token = null;
            admin.on('connect', () => {
                admin.emit('create-tenant', { key: SUPER_ADMIN_KEY, opId: 'reuse-op', password: 'pw' });
            });
            admin.on('tenant-created', (t) => {
                token = t.token;
                admin.disconnect();
                // First use consumes the token
                const u1 = new Client(`http://localhost:${port}`);
                u1.on('connect', () => u1.emit('join-operation', { opId: 'reuse-op', token, userId: 'a', callSign: 'A' }));
                u1.on('operation-config', () => {
                    u1.disconnect();
                    // Second use must fail
                    const u2 = new Client(`http://localhost:${port}`);
                    u2.on('connect', () => u2.emit('join-operation', { opId: 'reuse-op', token, userId: 'b', callSign: 'B' }));
                    u2.on('join-error', (msg) => {
                        expect(msg).toMatch(/used|Invalid/i);
                        u2.disconnect();
                        clearTimeout(timer);
                        resolve();
                    });
                });
            });
        });
    }, 12000);
});
