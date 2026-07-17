const fs = require('fs');
const path = require('path');

const MOCK_DB_PATH = path.join(__dirname, 'mock_db.json');

// Initial state
const initialState = {
    operations: [],
    channels: [],
    operation_tokens: [],
    units: []
};

function readDB() {
    if (!fs.existsSync(MOCK_DB_PATH)) {
        fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(initialState, null, 2));
    }
    return JSON.parse(fs.readFileSync(MOCK_DB_PATH, 'utf8'));
}

function writeDB(data) {
    fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(data, null, 2));
}

// Helper: apply a list of equality/inequality filters to a dataset
function applyFilters(rows, filters) {
    return rows.filter(item =>
        filters.every(f => {
            if (f.type === 'eq') return item[f.col] === f.val;
            if (f.type === 'neq') return item[f.col] !== f.val;
            return true;
        })
    );
}

const mockSupabase = {
    from: (table) => {
        // Builder holds its own filters so chained calls never bleed across queries.
        const builder = {
            _filters: [],

            select: function () {
                const self = this;
                const query = {
                    eq(col, val) {
                        self._filters.push({ type: 'eq', col, val });
                        return query;
                    },
                    neq(col, val) {
                        self._filters.push({ type: 'neq', col, val });
                        return query;
                    },
                    async single() {
                        const db = readDB();
                        const rows = applyFilters(db[table] || [], self._filters);
                        const item = rows[0] || null;
                        self._filters = [];
                        return { data: item, error: item ? null : { message: 'Not found' } };
                    },
                    then(resolve) {
                        const db = readDB();
                        const rows = applyFilters(db[table] || [], self._filters);
                        self._filters = [];
                        resolve({ data: rows, error: null });
                        return Promise.resolve();
                    }
                };
                return query;
            },

            insert: async (data) => {
                const db = readDB();
                if (!db[table]) db[table] = [];
                const records = Array.isArray(data) ? data : [data];

                // Enforce UNIQUE(token) on operation_tokens to mimic production schema
                if (table === 'operation_tokens') {
                    for (const rec of records) {
                        if (db[table].some(t => t.token === rec.token)) {
                            return { error: { message: 'duplicate key value violates unique constraint' } };
                        }
                    }
                }

                db[table].push(...records);
                writeDB(db);
                return { error: null };
            },

            upsert: async (data) => {
                const db = readDB();
                if (!db[table]) db[table] = [];
                const records = Array.isArray(data) ? data : [data];
                records.forEach(rec => {
                    const index = db[table].findIndex(i => i.id === rec.id);
                    if (index !== -1) {
                        db[table][index] = { ...db[table][index], ...rec };
                    } else {
                        db[table].push(rec);
                    }
                });
                writeDB(db);
                return { error: null };
            },

            update: (updateData) => ({
                eq: async (col, val) => {
                    const db = readDB();
                    if (!db[table]) return { error: { message: 'Not found' } };
                    let found = false;
                    db[table].forEach((item, index) => {
                        if (item[col] === val) {
                            db[table][index] = { ...item, ...updateData };
                            found = true;
                        }
                    });
                    if (found) {
                        writeDB(db);
                        return { error: null };
                    }
                    return { error: { message: 'Not found' } };
                }
            }),

            delete: () => ({
                match: async (filter) => {
                    const db = readDB();
                    if (!db[table]) return { error: null };
                    db[table] = db[table].filter(i =>
                        !Object.entries(filter).every(([k, v]) => i[k] === v)
                    );
                    writeDB(db);
                    return { error: null };
                }
            })
        };

        return builder;
    }
};

module.exports = mockSupabase;
