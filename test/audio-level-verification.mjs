import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_URL = 'http://localhost:3000';
const OP_ID = 'AUDIO-VERIFY-' + Math.floor(1000 + Math.random() * 9000);
const OP_PASS = 'adminpass123';
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || 'test-master-key';

async function main() {
    console.log('=== VERIFICACIÓN EXHAUSTIVA DE AUDIO DE VOZ PTT ===');
    console.log('1. Creando operación de prueba:', OP_ID);

    // Step 1: Create operation & tokens
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

    // Step 2: Launch browser with synthetic media stream
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

        console.log('2. Conectando Operador 1 (Emisor)...');
        const page1 = await ctx1.newPage();
        await page1.setCacheEnabled(false);
        page1.on('console', msg => console.log('[OP 1 CONSOLE]:', msg.text()));
        page1.on('pageerror', err => console.error('[OP 1 ERROR]:', err));
        await page1.goto(`${SERVER_URL}/?op=${OP_ID}&token=${token1}`, { waitUntil: 'networkidle0' });

        console.log('3. Conectando Operador 2 (Receptor)...');
        const page2 = await ctx2.newPage();
        await page2.setCacheEnabled(false);
        page2.on('console', msg => console.log('[OP 2 CONSOLE]:', msg.text()));
        page2.on('pageerror', err => console.error('[OP 2 ERROR]:', err));
        await page2.goto(`${SERVER_URL}/?op=${OP_ID}&token=${token2}`, { waitUntil: 'networkidle0' });

        await new Promise(r => setTimeout(r, 2000));

        // Inject active 440Hz test audio tone into Op 1's local stream to simulate speaking into the mic
        await page1.evaluate(() => {
            const ctx = window.audioContext || new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const dst = ctx.createMediaStreamDestination();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            osc.start();
            osc.connect(dst);
            
            const syntheticTrack = dst.stream.getAudioTracks()[0];
            if (window.localStream && syntheticTrack) {
                // Replace track with synthetic speaking tone
                window.localStream.removeTrack(window.localStream.getAudioTracks()[0]);
                window.localStream.addTrack(syntheticTrack);
                Object.values(window.peers || {}).forEach(pc => {
                    pc.getSenders().forEach(s => {
                        if (s.track && s.track.kind === 'audio') {
                            s.replaceTrack(syntheticTrack);
                        }
                    });
                });
            }
        });

        // Measure audio energy on Op 2 (Receiver) BEFORE PTT
        const energyBeforePtt = await page2.evaluate(() => {
            if (!window.remoteAnalyser || !window.remoteDataArray) return 0;
            window.remoteAnalyser.getByteFrequencyData(window.remoteDataArray);
            return window.remoteDataArray.reduce((a, b) => a + b, 0);
        });
        console.log('Energía de audio en Op 2 antes de PTT (Reposo):', energyBeforePtt);

        // Op 1 Presses PTT (speaking)
        console.log('4. Operador 1 presiona PTT y habla...');
        const talkBtn1 = await page1.$('#talk-btn');
        const box1 = await talkBtn1.boundingBox();
        await page1.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
        await page1.mouse.down();
        await new Promise(r => setTimeout(r, 1000));

        // Measure audio energy on Op 2 (Receiver) DURING PTT
        const energyDuringPtt = await page2.evaluate(() => {
            if (!window.remoteAnalyser || !window.remoteDataArray) return 0;
            window.remoteAnalyser.getByteFrequencyData(window.remoteDataArray);
            return window.remoteDataArray.reduce((a, b) => a + b, 0);
        });

        const statusOp1 = await page1.$eval('#status-text', el => el.innerText);
        const statusOp2 = await page2.$eval('#status-text', el => el.innerText);

        console.log('Estado Op 1 (Emisor):', statusOp1);
        console.log('Estado Op 2 (Receptor):', statusOp2);
        console.log('Energía de audio recibida en Op 2 DURANTE PTT:', energyDuringPtt);

        // Op 1 Releases PTT
        console.log('5. Operador 1 suelta PTT...');
        await page1.mouse.up();
        await new Promise(r => setTimeout(r, 1000));

        const energyAfterPtt = await page2.evaluate(() => {
            if (!window.remoteAnalyser || !window.remoteDataArray) return 0;
            window.remoteAnalyser.getByteFrequencyData(window.remoteDataArray);
            return window.remoteDataArray.reduce((a, b) => a + b, 0);
        });
        console.log('Energía de audio recibida en Op 2 TRAS soltar PTT:', energyAfterPtt);

        console.log('\n=== RESULTADOS DEL TEST DE VOZ ===');
        const txOk = statusOp1 === 'TRANSMITIENDO';
        const rxOk = statusOp2.includes('RECIBIENDO');
        const audioTransmittedOk = energyDuringPtt > 0;

        console.log('1. Estado Transmisor (TX):', txOk ? '✅ OK' : '❌ ERROR');
        console.log('2. Estado Receptor (RX):', rxOk ? '✅ OK' : '❌ ERROR');
        console.log('3. Flujo de voz en tiempo real:', audioTransmittedOk ? `✅ OK (Nivel de señal: ${energyDuringPtt})` : '❌ ERROR');

        if (txOk && rxOk && audioTransmittedOk) {
            console.log('\n🎉 ¡VOZ Y AUDIO VERIFICADOS 100% FUNCIONANDO!');
        } else {
            console.log('\n⚠️ Revisión detallada:', { txOk, rxOk, audioTransmittedOk, energyDuringPtt });
        }

    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error('CRITICAL ERROR:', err);
    process.exit(1);
});
