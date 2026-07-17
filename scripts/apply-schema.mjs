// Applies schema.sql to a Supabase project using the service_role key.
// Usage: node scripts/apply-schema.mjs
// Requires SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment (.env).
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment.');
    process.exit(1);
}

const sql = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');

// Supabase management SQL endpoint (service role only).
const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec`, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY
    },
    body: JSON.stringify({ query: sql })
}).catch(() => null);

if (!res || !res.ok) {
    // Fallback: some projects expose /sql instead of rpc/exec.
    const res2 = await fetch(`${SUPABASE_URL}/rest/v1/sql`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'apikey': SERVICE_KEY
        },
        body: JSON.stringify({ query: sql })
    });
    if (!res2.ok) {
        const text = await res2.text();
        console.error('Failed to apply schema:', res2.status, text);
        console.error('\nAlternative: paste schema.sql into the Supabase SQL editor manually.');
        process.exit(1);
    }
    console.log('Schema applied via /rest/v1/sql');
    process.exit(0);
}

console.log('Schema applied via rpc/exec');
