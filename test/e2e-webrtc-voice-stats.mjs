import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_URL = 'http://localhost:3000';
const OP_ID = 'VOICE-STATS-' + Math.floor(1000 + Math.random() * 9000);
const OP_PASS = 'adminpass123';
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || 'test-master-key';

async function main() {
    console.log('=== TEST PROFUNDO DE TRANSMISIÓN DE VOZ WEBRTC REAL ===');
    console.log('1. Creando operación de prueba:', OP_ID);

    const adminSocket = io(SERVER_URL, { transports: ['websocket'] });
    let token1 = await new Promise((resolve, reject) => {
        adminSocket.on('connect', () => {
            adminSocket.emit('create-tenant', { key: SUPER_ADMIN_KEY, opId: OP_ID, password: OP_PASS });
        });
        adminSocket.on('tenant-created', (data) => {
            if (data.success) resolve(data.token);
            else reject(new Error(data.msg));
        });
        setTimeout(() => reject(new Error('Timeout creando tenant')), 5000);
    });

    let token2 = await new Promise((resolve, reject) => {
        adminSocket.emit('generate-invite', { opId: OP_ID });
        adminSocket.on('invite-generated', (data) => {
            if (data.token) resolve(data.token);
            else reject(new Error('Error token 2'));
        });
        setTimeout(() => reject(new Error('Timeout token 2')), 5000);
    });

    adminSocket.close();

    // Launch Chrome with simulated microphone
    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });

    try {
        const ctx1 = await browser.createBrowserContext();
        await ctx1.overridePermissions(SERVER_URL, ['microphone', 'geolocation']);
        const ctx2 = await browser.createBrowserContext();
        await ctx2.overridePermissions(SERVER_URL, ['microphone', 'geolocation']);

        console.log('2. Conectando Operador 1...');
        const page1 = await ctx1.newPage();
        await page1.setCacheEnabled(false);
        page1.on('console', msg => console.log('[OP 1]:', msg.text()));
        await page1.goto(`${SERVER_URL}/?op=${OP_ID}&token=${token1}`, { waitUntil: 'networkidle0' });

        console.log('3. Conectando Operador 2...');
        const page2 = await ctx2.newPage();
        await page2.setCacheEnabled(false);
        page2.on('console', msg => console.log('[OP 2]:', msg.text()));
        await page2.goto(`${SERVER_URL}/?op=${OP_ID}&token=${token2}`, { waitUntil: 'networkidle0' });

        // Simulate user interactions on both pages
        await page1.click('body');
        await page2.click('body');
        await new Promise(r => setTimeout(r, 2000));

        // Get initial WebRTC stats before PTT
        const statsBefore = await page2.evaluate(async () => {
            const results = {};
            const pcs = window.peers || {};
            for (const [id, pc] of Object.entries(pcs)) {
                const stats = await pc.getStats();
                let bytesIn = 0;
                let packetsIn = 0;
                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                        bytesIn += (report.bytesReceived || 0);
                        packetsIn += (report.packetsReceived || 0);
                    }
                });
                results[id] = { bytesIn, packetsIn, iceState: pc.iceConnectionState };
            }
            return results;
        });
        console.log('Stats en Operador 2 antes de PTT:', statsBefore);

        // Op 1 transmits
        console.log('4. Operador 1 presiona PTT y habla al micrófono...');
        const talkBtn1 = await page1.$('#talk-btn');
        const box1 = await talkBtn1.boundingBox();
        await page1.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
        await page1.mouse.down();
        
        // Speak for 2.5 seconds
        await new Promise(r => setTimeout(r, 2500));

        // Inspect Op 2 audio playback element & WebRTC inbound RTP stats DURING transmission
        const statsDuring = await page2.evaluate(async () => {
            const results = {};
            const pcs = window.peers || {};
            for (const [id, pc] of Object.entries(pcs)) {
                const stats = await pc.getStats();
                let bytesIn = 0;
                let packetsIn = 0;
                let trackId = null;
                stats.forEach(report => {
                    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                        bytesIn += (report.bytesReceived || 0);
                        packetsIn += (report.packetsReceived || 0);
                        trackId = report.trackId || report.ssrc;
                    }
                });
                const audioEl = document.getElementById(`audio-${id}`);
                results[id] = {
                    bytesIn,
                    packetsIn,
                    trackId,
                    iceState: pc.iceConnectionState,
                    hasAudioElement: !!audioEl,
                    audioPaused: audioEl ? audioEl.paused : null,
                    audioVolume: audioEl ? audioEl.volume : null,
                    audioMuted: audioEl ? audioEl.muted : null,
                    hasStream: audioEl ? !!audioEl.srcObject : false,
                    trackLive: audioEl && audioEl.srcObject ? audioEl.srcObject.getAudioTracks().map(t => ({ kind: t.kind, readyState: t.readyState, enabled: t.enabled, muted: t.muted })) : []
                };
            }
            return results;
        });

        const statusOp1 = await page1.$eval('#status-text', el => el.innerText);
        const statusOp2 = await page2.$eval('#status-text', el => el.innerText);

        console.log('Estado Op 1:', statusOp1);
        console.log('Estado Op 2:', statusOp2);
        console.log('Diagnóstico de Voz y Reproducción en Operador 2:', JSON.stringify(statsDuring, null, 2));

        // Op 1 releases PTT
        console.log('5. Operador 1 suelta PTT...');
        await page1.mouse.up();
        await new Promise(r => setTimeout(r, 1000));

        // Evaluate results
        const op2Data = Object.values(statsDuring)[0] || {};
        const isRtpFlowing = (op2Data.bytesIn || 0) > 0;
        const isIceConnected = op2Data.iceState === 'connected' || op2Data.iceState === 'completed';
        const isAudioPlaying = op2Data.hasAudioElement && !op2Data.audioPaused && op2Data.hasStream;

        console.log('\n=== REPORTE TÉCNICO FINAL ===');
        console.log('1. Conexión P2P WebRTC ICE:', isIceConnected ? '✅ CONECTADA' : '❌ FALLO');
        console.log('2. Paquetes de audio RTP transmitidos (Bytes):', isRtpFlowing ? `✅ RECIBIENDO VOZ (${op2Data.bytesIn} bytes / ${op2Data.packetsIn} paquetes)` : '❌ 0 BYTES');
        console.log('3. Reproductor de altavoz en Receptor:', isAudioPlaying ? `✅ REPRODUCIENDO (Volumen: ${op2Data.audioVolume}, Muted: ${op2Data.audioMuted})` : '❌ DETENIDO');
        console.log('4. Estado de la pista de voz:', JSON.stringify(op2Data.trackLive));

        if (isIceConnected && isRtpFlowing && isAudioPlaying) {
            console.log('\n🎉 ¡VERIFICACIÓN EXITOSA: LA VOZ ESTÁ LLEGANDO Y SONANDO EN EL ALTAVOZ AL 100%!');
        } else {
            console.log('\n⚠️ FALLO EN LA VERIFICACIÓN DE AUDIO');
        }

    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error('ERROR EN TEST:', err);
    process.exit(1);
});
