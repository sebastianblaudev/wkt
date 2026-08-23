import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_URL = 'http://localhost:3000';
const OP_ID = 'BROWSER-OP-LIVE-' + Math.floor(1000 + Math.random() * 9000);
const OP_PASS = 'adminpass123';
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || 'test-master-key';

async function main() {
    console.log('=== INICIANDO PRUEBA DE NAVEGADOR EN VIVO ===');
    console.log('1. Creando operación:', OP_ID);

    // Step 1: Create operation & generate invite token
    const adminSocket = io(SERVER_URL, { transports: ['websocket'] });
    let token = await new Promise((resolve, reject) => {
        adminSocket.on('connect', () => {
            adminSocket.emit('create-tenant', { key: SUPER_ADMIN_KEY, opId: OP_ID, password: OP_PASS });
        });
        adminSocket.on('tenant-created', (data) => {
            if (data.success) resolve(data.token);
            else reject(new Error(data.msg));
        });
        setTimeout(() => reject(new Error('Timeout creando tenant')), 5000);
    });

    console.log('Token de invitación generado:', token);
    adminSocket.close();

    // Step 2: Launch Google Chrome
    console.log('2. Lanzando Google Chrome ejecutable...');
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
        const context = await browser.createBrowserContext();
        await context.overridePermissions(SERVER_URL, ['microphone', 'geolocation']);

        // Page 1: Operator 1
        console.log('3. Abriendo Operador 1 en el navegador...');
        const page1 = await context.newPage();
        await page1.setCacheEnabled(false);
        page1.on('console', msg => console.log('PAGE1 BROWSER CONSOLE:', msg.text()));
        page1.on('pageerror', err => console.error('PAGE1 ERROR:', err));
        await page1.setViewport({ width: 414, height: 896 }); // Mobile view
        
        const url1 = `${SERVER_URL}/?op=${OP_ID}&token=${token}`;
        await page1.goto(url1, { waitUntil: 'networkidle0' });

        // Power On Operator 1
        console.log('4. Esperando inicialización del equipo...');
        await page1.waitForFunction(() => {
            const el = document.getElementById('status-text');
            return el && (el.innerText === 'STANDBY' || el.innerText === 'ONLINE' || el.innerText.startsWith('OP:'));
        }, { timeout: 8000 }).catch(async () => {
            const status = await page1.$eval('#status-text', el => el.innerText).catch(() => '');
            if (status === 'OFFLINE') {
                await page1.evaluate(() => document.getElementById('power-btn').click());
            }
        });
        await new Promise(r => setTimeout(r, 1000));

        let status1 = await page1.$eval('#status-text', el => el.innerText);
        console.log('Estado de Operador 1 tras encender:', status1);

        // Page 2: Admin Overwatch
        console.log('5. Abriendo Consola de Administración...');
        const pageAdmin = await context.newPage();
        await pageAdmin.setCacheEnabled(false);
        await pageAdmin.setViewport({ width: 1280, height: 800 });
        await pageAdmin.goto(`${SERVER_URL}/admin`, { waitUntil: 'networkidle0' });

        // Login Admin
        await pageAdmin.type('#op-id-input', OP_ID);
        await pageAdmin.type('#op-pass-input', OP_PASS);
        await pageAdmin.click('#login-btn');
        await pageAdmin.waitForSelector('#dashboard-container.active', { timeout: 5000 });
        console.log('Admin Overwatch iniciado correctamente.');

        // Step 6: Test PTT Transmission from Operator 1
        console.log('6. Probando transmisión PTT (Push-to-Talk) desde Operador 1...');
        const talkBtn = await page1.$('#talk-btn');
        const box = await talkBtn.boundingBox();
        
        // Simular evento pointerdown sobre el botón PTT
        await page1.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page1.mouse.down();
        await new Promise(r => setTimeout(r, 800));

        let txStatus = await page1.$eval('#status-text', el => el.innerText);
        console.log('Estado de Operador 1 durante PTT:', txStatus);

        // Verificar en Admin Overwatch si se muestra el banner "EN AIRE"
        let activeSpeakerText = await pageAdmin.$eval('#active-speaker-name', el => el.innerText).catch(() => '');
        let activeSpeakerVisible = await pageAdmin.$eval('#active-speaker-bar', el => el.style.display !== 'none').catch(() => false);
        console.log('Banner Admin EN AIRE visible:', activeSpeakerVisible, '| Texto:', activeSpeakerText);

        // Capturar pantalla durante la transmisión PTT
        const screenshotPath = './artifacts_ptt_tx_test.png';
        await page1.screenshot({ path: screenshotPath });
        console.log('Captura guardada en:', screenshotPath);

        // Soltar PTT
        console.log('7. Soltando botón PTT (Fin de transmisión)...');
        await page1.mouse.up();
        await new Promise(r => setTimeout(r, 800));

        let idleStatus = await page1.$eval('#status-text', el => el.innerText);
        console.log('Estado de Operador 1 tras soltar PTT:', idleStatus);

        let activeSpeakerAfter = await pageAdmin.$eval('#active-speaker-bar', el => el.style.display !== 'none').catch(() => false);
        console.log('Banner Admin EN AIRE liberado:', !activeSpeakerAfter);

        console.log('\n=== RESULTADO DE LA PRUEBA EN NAVEGADOR ===');
        if (txStatus.includes('TRANSMITIENDO') && idleStatus === 'STANDBY' && activeSpeakerVisible && !activeSpeakerAfter) {
            console.log('✅ TODAS LAS PRUEBAS DE NAVEGADOR PASARON EXITOSAMENTE 100%!');
        } else {
            console.log('⚠️ Resultado:', { txStatus, idleStatus, activeSpeakerVisible, activeSpeakerAfter });
        }

    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error('CRITICAL: Error en la prueba de navegador:', err);
    process.exit(1);
});
