const { createClient } = require('@supabase/supabase-js');
const mockSupabase = require('./mock_db.cjs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let client;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    console.log("[DB] Initializing Supabase Client...");
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
} else {
    console.log("[DB] Using Local Mock Database...");
    client = mockSupabase;
}

module.exports = client;
