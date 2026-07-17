import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function test() {
    console.log("Checking DB connection and operations table...");
    
    // Check operations table
    const { data: ops, error: opsError } = await client.from('operations').select('*');
    
    if (opsError) {
        console.error("ERROR querying operations table:", opsError);
    } else {
        console.log("OPERATIONS IN DB:", ops);
    }
}
test();
