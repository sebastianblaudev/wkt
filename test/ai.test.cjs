// Tests for the Operational AI deterministic engine (ai.cjs).
// No external deps: uses Node's built-in assert.
const assert = require('assert');
const AI = require('../ai.cjs');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ✓', name);
    } catch (e) {
        console.error('  ✗', name);
        console.error('    ', e.message);
        process.exitCode = 1;
    }
}

console.log('AI engine tests');

test('MODES are valid', () => {
    assert.deepStrictEqual(AI.MODES, ['SUGGEST_ONLY', 'SUGGEST_APPROVE', 'AUTO_EXECUTE']);
});

test('summarizeShift counts events', async () => {
    const events = [
        { ts: '2026-01-01T00:00:00Z', type: 'join-operation' },
        { ts: '2026-01-01T00:01:00Z', type: 'update-location' },
    ];
    const s = await AI.summarizeShift(events);
    assert.strictEqual(s.metrics.total, 2);
    assert.strictEqual(s.metrics.joins, 1);
});

test('recommendDispatch returns nearest active unit', () => {
    const units = [
        { id: 'a', status: 'ACTIVE', lat: 19.40, lng: -99.10 },
        { id: 'b', status: 'ACTIVE', lat: 19.50, lng: -99.50 },
        { id: 'c', status: 'OFFLINE', lat: 19.41, lng: -99.12 },
    ];
    const d = AI.recommendDispatch(units, { lat: 19.41, lng: -99.12, count: 1 });
    assert.deepStrictEqual(d.recommended, ['a']);
});

test('recommendDispatch returns empty when none active', () => {
    const d = AI.recommendDispatch([{ id: 'x', status: 'OFFLINE' }], {});
    assert.strictEqual(d.recommended.length, 0);
});

test('supervise flags high chaos', () => {
    const actions = AI.supervise({ chaos: { index: 85, state: 'CRITICO' }, units: [], openIncidents: 0 });
    assert.ok(actions.some(a => a.priority === 'HIGH'));
});

test('learnFromShift builds predictions', () => {
    const mem = { learned: {} };
    const events = [
        { ts: '2026-01-01T03:00:00Z', type: 'unit-offline', payload: { id: 'u7' } },
    ];
    const out = AI.learnFromShift(mem, events);
    assert.strictEqual(out.learned.weakUnits['u7'], 1);
    assert.ok(out.predictions.length > 0);
});

test('buildInsight shapes payload', () => {
    const ins = AI.buildInsight({ mode: 'AUTO_EXECUTE', summary: { text: 'x' }, actions: [], predictions: ['p'], dispatch: null });
    assert.strictEqual(ins.mode, 'AUTO_EXECUTE');
    assert.strictEqual(ins.auto, true);
    assert.strictEqual(ins.summary, 'x');
    assert.deepStrictEqual(ins.predictions, ['p']);
});

console.log(`\n${passed} passed`);
