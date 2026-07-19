// Operational AI module (VANT command-center brain).
//
// This is a deterministic, rules + template engine so the product works with
// ZERO external API keys. The exported functions are intentionally shaped
// like an LLM prompt/response boundary, so swapping in OpenAI/Anthropic later
// is a drop-in: replace the body of each function with an API call.
//
// Modes of autonomy:
//   SUGGEST_ONLY     -> AI only emits suggestions (default, safest)
//   SUGGEST_APPROVE  -> AI emits suggestions; admin must approve to execute
//   AUTO_EXECUTE     -> AI executes recommended actions automatically

const MODES = ['SUGGEST_ONLY', 'SUGGEST_APPROVE', 'AUTO_EXECUTE'];

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// --- Optional LLM layer (OpenAI-compatible, works with Kimi/Moonshot) ---
// Set AI_PROVIDER_URL (e.g. https://api.moonshot.cn/v1/chat/completions) and
// AI_API_KEY to enable natural-language summaries/insights. When unset, the
// deterministic engine above is used, so the product works with ZERO keys.
const AI_PROVIDER_URL = process.env.AI_PROVIDER_URL || '';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'moonshot-v1-8k';

let _llmAvailable = null;
function llmAvailable() {
    if (_llmAvailable === null) _llmAvailable = Boolean(AI_PROVIDER_URL && AI_API_KEY);
    return _llmAvailable;
}

async function callLLM(system, user) {
    if (!llmAvailable()) return null;
    try {
        const res = await fetch(AI_PROVIDER_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${AI_API_KEY}`
            },
            body: JSON.stringify({
                model: AI_MODEL,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user }
                ],
                temperature: 0.3
            })
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.choices?.[0]?.message?.content?.trim() || null;
    } catch {
        return null;
    }
}

// --- Summarize a shift from its event log ---
async function summarizeShift(events = []) {
    const counts = {};
    let sos = 0, dispatches = 0, joins = 0, locations = 0;
    for (const e of events) {
        counts[e.type] = (counts[e.type] || 0) + 1;
        if (e.type === 'sos-triggered') sos++;
        if (e.type === 'dispatch') dispatches++;
        if (e.type === 'join-operation') joins++;
        if (e.type === 'update-location') locations++;
    }
    const total = events.length;
    const durationMin = total ? Math.max(1, Math.round(
        (new Date(events[total - 1].ts) - new Date(events[0].ts)) / 60000
    )) : 0;

    let text = `Resumen operacional: ${total} eventos en ~${durationMin} min. `;
    text += `${joins} unidades conectadas, ${locations} actualizaciones de GPS, `;
    text += `${dispatches} despachos, ${sos} alertas SOS. `;
    if (sos > 0) text += `Se requiere revisión post-incidente por SOS activado. `;
    if (dispatches === 0 && joins > 0) text += `Sin despachos ejecutados pese a tener unidades activas. `;

    if (llmAvailable()) {
        const llm = await callLLM(
            "Eres el analista de operaciones de un centro de mando táctico (walkie-talkie). Redacta un resumen ejecutivo breve y profesional en español.",
            `Eventos de la operación: ${JSON.stringify({ total, joins, locations, dispatches, sos, durationMin, counts })}`
        );
        if (llm) text = llm;
    }
    return { text, metrics: { total, joins, locations, dispatches, sos, durationMin } };
}

// --- Dispatch recommendation: pick best unit(s) for a task ---
// units: [{ id, callSign, status, lat, lng, distance? }]
function recommendDispatch(units = [], task = {}) {
    const available = units.filter(u => u.status === 'ACTIVE' || u.status === 'WAITING FOR GPS...');
    if (available.length === 0) {
        return { recommended: [], rationale: 'No hay unidades activas disponibles para despachar.' };
    }
    // Prefer ACTIVE, then nearest if coords present.
    const sorted = available.slice().sort((a, b) => {
        if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
        if (task.lat != null && a.lat != null) {
            const da = Math.hypot(a.lat - task.lat, a.lng - task.lng);
            const db = Math.hypot(b.lat - task.lat, b.lng - task.lng);
            return da - db;
        }
        return 0;
    });
    const recommended = sorted.slice(0, task.count || 1).map(u => u.id);
    const rationale = `Recomendado(s): ${recommended.join(', ')} por estar activo(s)${task.lat != null ? ' y ser el/los más cercano(s) al objetivo' : ''}.`;
    return { recommended, rationale };
}

// --- Real-time supervisor: propose actions from current state ---
// state: { chaos: {index, state}, units: [...], openIncidents: number, sosActive: number }
function supervise(state = {}) {
    const actions = [];
    const chaosIdx = state.chaos?.index ?? 0;
    if (state.sosActive > 0) {
        actions.push({ type: 'PRIORITIZE_SOS', priority: 'CRITICAL',
            text: `SOS activo(s): ${state.sosActive}. Despachar unidad de respuesta inmediata y abrir canal dedicado.` });
    }
    if (chaosIdx >= 75) {
        actions.push({ type: 'SPLIT_COMMS', priority: 'HIGH',
            text: 'Caos CRÍTICO: dividir en canales tácticos por zona para reducir saturación.' });
    } else if (chaosIdx >= 50) {
        actions.push({ type: 'MONITOR', priority: 'MEDIUM',
            text: 'Caos ALTO: reforzar supervisión y pre-asignar unidades de reserva.' });
    }
    if (state.openIncidents > 0 && (state.units?.length || 0) > 0) {
        actions.push({ type: 'DISPATCH_RESERVE', priority: 'MEDIUM',
            text: `${state.openIncidents} incidente(s) abierto(s); considerar despacho de reserva.` });
    }
    if (actions.length === 0) {
        actions.push({ type: 'NOMINAL', priority: 'LOW', text: 'Operación en estado nominal. Sin acciones requeridas.' });
    }
    return actions;
}

// --- Learn from a finished shift and produce predictions ---
// memory.learned: { peakHours: {hour: count}, weakUnits: {id: count}, sosZones: {zone: count} }
// events: shift events
function learnFromShift(memory = { learned: {} }, events = []) {
    const learned = JSON.parse(JSON.stringify(memory.learned || {}));
    learned.peakHours = learned.peakHours || {};
    learned.weakUnits = learned.weakUnits || {};
    learned.sosZones = learned.sosZones || {};

    for (const e of events) {
        const h = new Date(e.ts).getUTCHours();
        learned.peakHours[h] = (learned.peakHours[h] || 0) + 1;
        if (e.type === 'unit-offline') learned.weakUnits[e.payload?.id] = (learned.weakUnits[e.payload?.id] || 0) + 1;
        if (e.type === 'sos-triggered' && e.payload?.channelName)
            learned.sosZones[e.payload.channelName] = (learned.sosZones[e.payload.channelName] || 0) + 1;
    }

    // Predictions
    const peak = Object.entries(learned.peakHours).sort((a, b) => b[1] - a[1])[0];
    const weak = Object.entries(learned.weakUnits).sort((a, b) => b[1] - a[1])[0];
    const predictions = [];
    if (peak) predictions.push(`Mayor carga operacional esperada cerca de la hora ${peak[0]}:00 UTC (basado en ${peak[1]} eventos previos).`);
    if (weak) predictions.push(`La unidad ${weak[0]} tiende a caerse en turnos previos; prever respaldo.`);
    return { learned, predictions };
}

// --- Build an AI insight object emitted to admins ---
function buildInsight({ mode = 'SUGGEST_ONLY', summary, actions = [], predictions = [], dispatch = null }) {
    return {
        mode,
        summary: summary?.text || null,
        metrics: summary?.metrics || null,
        actions,            // supervisor proposals
        predictions,        // from memory
        dispatch,           // { recommended, rationale } or null
        auto: mode === 'AUTO_EXECUTE'
    };
}

module.exports = {
    MODES,
    summarizeShift,
    recommendDispatch,
    supervise,
    learnFromShift,
    buildInsight
};
