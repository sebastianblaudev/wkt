// One-shot production setup helper.
//   node scripts/setup-prod.mjs
//
// What it does (automated):
//   1. Generates strong random secrets for SUPER_ADMIN_KEY, SIGNAL_SECRET, TURN_SECRET.
//   2. Reads SUPABASE_URL / SUPABASE_SERVICE_KEY from .env (you must set them first).
//   3. Applies schema.sql to Supabase.
//   4. Prints a copy-paste block of Render environment variables.
//
// What you must still do manually (cannot be automated):
//   - Regenerate the SUPABASE_SERVICE_KEY in the Supabase dashboard if it was ever
//     committed (the old key must be considered compromised).
//   - Create the Web Service in Render and paste the printed env vars.
//   - Provide a TURN host (or skip TURN and accept P2P only on permissive networks).
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

console.log('\n=== Walkie-Talkie Production Setup ===\n');

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('MISSING: SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
    console.error('Set them (preferably the REGENERATED service_role key) and re-run.\n');
    process.exit(1);
}

// 1. Generate secrets
const secrets = {
    SUPER_ADMIN_KEY: randomBytes(32).toString('base64url'),
    SIGNAL_SECRET: randomBytes(32).toString('base64url'),
    TURN_SECRET: randomBytes(24).toString('base64url')
};

// 2. Apply schema
const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
let schemaApplied = false;
try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sql`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'apikey': SERVICE_KEY
        },
        body: JSON.stringify({ query: sql })
    });
    if (res.ok) {
        schemaApplied = true;
    } else {
        const t = await res.text();
        console.warn('Schema auto-apply failed:', res.status, t.slice(0, 200));
    }
} catch (e) {
    console.warn('Schema auto-apply error:', e.message);
}

// 3. Print Render env var block
const turnUrls = process.env.TURN_URLS || 'turn:YOUR_TURN_HOST:3478?transport=udp,turn:YOUR_TURN_HOST:3478?transport=tcp';
const allowedOrigins = process.env.ALLOWED_ORIGINS || 'https://YOUR_APP.onrender.com';

console.log('Schema applied to Supabase:', schemaApplied ? 'YES' : 'NO (paste schema.sql in SQL Editor)');
console.log('\n--- COPY THESE INTO Render > Environment ---\n');
console.log(`SUPABASE_URL=${SUPABASE_URL}`);
console.log(`SUPABASE_SERVICE_KEY=${SERVICE_KEY}`);
console.log(`SUPER_ADMIN_KEY=${secrets.SUPER_ADMIN_KEY}`);
console.log(`SIGNAL_SECRET=${secrets.SIGNAL_SECRET}`);
console.log(`ALLOWED_ORIGINS=${allowedOrigins}`);
console.log(`TURN_SECRET=${secrets.TURN_SECRET}`);
console.log(`TURN_URLS=${turnUrls}`);
console.log(`TURN_EXTERNAL_IP=${process.env.TURN_EXTERNAL_IP || 'YOUR_TURN_PUBLIC_IP'}`);
console.log('\nPORT=3000  (Render injects this; do not set manually)');
console.log('\n--- END ---\n');
console.log('Next: create the Web Service in Render pointing at your repo; render.yaml handles the rest.');
