// Run: SUPER_ADMIN_KEY=tu_key node scripts/make-invite.mjs
// Creates a fresh operation and prints the APK deep link + web link.
import { io } from 'socket.io-client';

const KEY = process.env.SUPER_ADMIN_KEY;
const URL = process.env.SERVER_URL || 'https://wkt.ash-2.instapods.app';
const OP_ID = process.env.OP_ID || ('op-' + Math.random().toString(36).slice(2, 8));
const PASS = process.env.OP_PASS || 'admin123';

if (!KEY) { console.error('Set SUPER_ADMIN_KEY'); process.exit(1); }

const socket = io(URL, { transports: ['websocket'] });

socket.on('connect', () => {
    socket.emit('create-tenant', { key: KEY, opId: OP_ID, password: PASS });
});

socket.on('tenant-created', ({ success, msg, opId, token }) => {
    if (!success) { console.error('Error:', msg); process.exit(1); }
    console.log('\n=== OPERATION CREATED ===');
    console.log('Operation ID :', opId);
    console.log('Admin Pass   :', PASS);
    console.log('APK deep link:', `${URL}/invite?op=${opId}&token=${token}`);
    console.log('Web link     :', `${URL}/?op=${opId}&token=${token}`);
    socket.close();
    process.exit(0);
});

socket.on('connect_error', (e) => { console.error('Connect error:', e.message); process.exit(1); });
setTimeout(() => { console.error('Timeout'); process.exit(1); }, 15000);
