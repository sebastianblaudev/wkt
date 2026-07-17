import { describe, it, expect, beforeEach } from 'vitest';
import mockSupabase from '../mock_db.cjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MOCK_DB_PATH = path.join(__dirname, '../mock_db.json');

describe('Mock Database (mock_db.cjs)', () => {
    beforeEach(() => {
        const initialState = {
            operations: [],
            channels: [],
            operation_tokens: [],
            units: []
        };
        fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(initialState, null, 2));
    });

    it('should insert and select data', async () => {
        const testOp = { id: 'test-op', admin_password: '123' };
        await mockSupabase.from('operations').insert(testOp);

        const { data, error } = await mockSupabase.from('operations').select('*').eq('id', 'test-op').single();
        
        expect(error).toBeNull();
        expect(data).toMatchObject(testOp);
    });

    it('should filter data with eq and neq', async () => {
        await mockSupabase.from('units').insert([
            { id: 'u1', status: 'ONLINE', op_id: 'op1' },
            { id: 'u2', status: 'OFFLINE', op_id: 'op1' },
            { id: 'u3', status: 'ONLINE', op_id: 'op2' }
        ]);

        const { data: onlineUnits } = await mockSupabase.from('units').select('*').eq('status', 'ONLINE');
        expect(onlineUnits).toHaveLength(2);

        const { data: op1Units } = await mockSupabase.from('units').select('*').eq('op_id', 'op1').neq('status', 'OFFLINE');
        expect(op1Units).toHaveLength(1);
        expect(op1Units[0].id).toBe('u1');
    });

    it('should update existing data using upsert', async () => {
        await mockSupabase.from('units').insert({ id: 'u1', status: 'ONLINE' });
        await mockSupabase.from('units').upsert({ id: 'u1', status: 'BUSY' });

        const { data } = await mockSupabase.from('units').select('*').eq('id', 'u1').single();
        expect(data.status).toBe('BUSY');
    });

    it('should update data using update().eq()', async () => {
        await mockSupabase.from('units').insert({ id: 'u1', status: 'ONLINE' });
        await mockSupabase.from('units').update({ status: 'OFFLINE' }).eq('id', 'u1');

        const { data } = await mockSupabase.from('units').select('*').eq('id', 'u1').single();
        expect(data.status).toBe('OFFLINE');
    });

    it('should delete data using delete().match()', async () => {
        await mockSupabase.from('channels').insert([
            { op_id: 'op1', name: 'BASE' },
            { op_id: 'op1', name: 'TEMP' }
        ]);

        await mockSupabase.from('channels').delete().match({ op_id: 'op1', name: 'TEMP' });

        const { data } = await mockSupabase.from('channels').select('*').eq('op_id', 'op1');
        expect(data).toHaveLength(1);
        expect(data[0].name).toBe('BASE');
    });

    it('should return error for single() when no match is found', async () => {
        const { data, error } = await mockSupabase.from('operations').select('*').eq('id', 'non-existent').single();
        expect(data).toBeNull();
        expect(error).not.toBeNull();
        expect(error.message).toBe('Not found');
    });

    it('should reject duplicate tokens on operation_tokens (UNIQUE)', async () => {
        const { error: e1 } = await mockSupabase.from('operation_tokens').insert({ token: 'abc123', op_id: 'op1' });
        expect(e1).toBeNull();

        const { error: e2 } = await mockSupabase.from('operation_tokens').insert({ token: 'abc123', op_id: 'op2' });
        expect(e2).not.toBeNull();
    });
});
