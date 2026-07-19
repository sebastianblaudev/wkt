-- Tables for Walkie-Talkie (Supabase)

-- 1. Operations
-- admin_password stores a bcrypt hash (never plaintext).
-- autonomy_mode: SUGGEST_ONLY | SUGGEST_APPROVE | AUTO_EXECUTE
CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    admin_password TEXT NOT NULL,
    autonomy_mode TEXT DEFAULT 'SUGGEST_ONLY',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Event Log (operational timeline / replay)
CREATE TABLE IF NOT EXISTS event_log (
    id BIGSERIAL PRIMARY KEY,
    op_id TEXT REFERENCES operations(id) ON DELETE CASCADE,
    ts TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    type TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb
);

-- 6. Operational Memory (cross-shift learning)
-- One row per operation storing learned patterns + running summary.
CREATE TABLE IF NOT EXISTS operational_memory (
    op_id TEXT PRIMARY KEY REFERENCES operations(id) ON DELETE CASCADE,
    shift_count INTEGER DEFAULT 0,
    learned JSONB DEFAULT '{}'::jsonb,
    summary TEXT DEFAULT '',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Channels
CREATE TABLE IF NOT EXISTS channels (
    id BIGSERIAL PRIMARY KEY,
    op_id TEXT REFERENCES operations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    UNIQUE(op_id, name)
);

-- 3. Operation Tokens (Invites)
-- Single-use, expiring invite tokens. expires_at defaults to +24h.
CREATE TABLE IF NOT EXISTS operation_tokens (
    token TEXT PRIMARY KEY,
    op_id TEXT REFERENCES operations(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (timezone('utc'::text, now()) + interval '24 hours') NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE
);

-- 4. Units (Users/Radios)
CREATE TABLE IF NOT EXISTS units (
    id TEXT PRIMARY KEY,
    op_id TEXT REFERENCES operations(id) ON DELETE CASCADE,
    callsign TEXT NOT NULL,
    socket_id TEXT,
    status TEXT DEFAULT 'OFFLINE',
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
    lat DOUBLE PRECISION DEFAULT 0,
    lng DOUBLE PRECISION DEFAULT 0
);

-- Optional: Enable Realtime (if needed for the future)
-- alter publication supabase_realtime add table units, operations, channels, operation_tokens;
