import db from '../db.cjs';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const opId = 'ALPHA-TACTICAL';
const pass = 'admin123';
const hashedPass = bcrypt.hashSync(pass, 12);
const token = crypto.randomBytes(18).toString('base64url');
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

async function run() {
    try {
        await db.from('operations').upsert([{ id: opId, admin_password: hashedPass }]);
        await db.from('channels').upsert([
            { op_id: opId, name: 'CANAL 1' },
            { op_id: opId, name: 'LOGISTICA' }
        ]);
        await db.from('operation_tokens').insert([{ token, op_id: opId, expires_at: expiresAt }]);

        console.log('=== OPERACION CREADA ===');
        console.log('ID Operacion:', opId);
        console.log('Pass Admin:', pass);
        console.log('Token:', token);
        console.log('Link Web Prod:', `https://wkt.ash-2.instapods.app/?op=${opId}&token=${token}`);
        console.log('Link Invite:', `https://wkt.ash-2.instapods.app/invite?op=${opId}&token=${token}`);
        console.log('Link Web Local:', `http://localhost:3000/?op=${opId}&token=${token}`);
    } catch (e) {
        console.error('Error creando operacion:', e);
    }
}

run();
