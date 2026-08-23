import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_URL = 'http://localhost:3000';
const OP_ID = 'TWO-OP-PTT-' + Math.floor(1000 + Math.random() * 9000);
const OP_PASS = 'adminpass123';
const SUPER_ADMIN_KEY = process.env.SUPER_ADMIN_KEY || 'test-master-key';

async function main() {
    console.log('=== TEST MULTI-OPERADOR PUSH-TO-TALK EN VIVO ===');
    console.log('1. Creando operación multi-unidad:', OP_ID);

    // Step 1: Create operation & generate invite tokens for 2 operators
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

    // Generate second token
    let token2 = await new Promise((resolve, reject) => {
        adminSocket.emit('generate-invite', { opId: OP_ID });
        adminSocket.on('invite-generated', (data) => {
            if (data.token) resolve(data.token);
            else reject(new Error(data.error || 'Token error'));
        });
        setTimeout(() => reject(new Error('Timeout generando token 2')), 5000);
    });

    console.log('Tokens de invitación generados:', { token1, token2 });
    adminSocket.close();

    // Step 2: Launch Google Chrome
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
        const context1 = await browser.createBrowserContext();
        await context1.overridePermissions(SERVER_URL, ['microphone', 'geolocation']);
        const context2 = await browser.createBrowserContext();
        await context2.overridePermissions(SERVER_URL, ['microphone', 'geolocation']);

        // Op 1 Page
        console.log('2. Conectando Operador 1...');
        const page1 = await context1.newPage();
        await page1.setCacheEnabled(false);
        page1.on('console', msg => console.log('[OP 1 LOG]:', msg.text()));
        await page1.setViewport({ width: 414, height: 896 });
        await page1.goto(`${SERVER_URL}/?op=${OP_ID}&token=${token1}`, { waitUntil: 'networkidle0' });

        // Op 2 Page
        console.log('3. Conectando Operador 2...');
        const page2 = await context2.newPage();
        await page2.setCacheEnabled(false);
        page2.on('console', msg => console.log('[OP 2 LOG]:', msg.text()));
        await page2.setViewport({ width: 414, height: 896 });
        await page2.goto(`${SERVER_URL}/?op=${OP_ID}&token=${token2}`, { waitUntil: 'networkidle0' });

        await new Promise(r => setTimeout(r, 2000));

        let statusOp1 = await page1.$eval('#status-text', el => el.innerText);
        let statusOp2 = await page2.$eval('#status-text', el => el.innerText);
        console.log('Estados iniciales:', { Op1: statusOp1, Op2: statusOp2 });

        // Test Transmission: Op 1 talks
        console.log('4. Operador 1 presiona PTT (TX)...');
        const talkBtn1 = await page1.$('#talk-btn');
        const box1 = await talkBtn1.boundingBox();
        await page1.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
        await page1.mouse.down();
        await new Promise(r => setTimeout(r, 800));

        let txStatusOp1 = await page1.$eval('#status-text', el => el.innerText);
        let rxStatusOp2 = await page2.$eval('#status-text', el => el.innerText);
        console.log('Transmisión Op 1 -> Op 2:', { Op1_TX: txStatusOp1, Op2_RX: rxStatusOp2 });

        // Release PTT Op 1
        console.log('5. Operador 1 suelta PTT...');
        await page1.mouse.up();
        await new Promise(r => setTimeout(r, 800));

        let idleStatusOp1 = await page1.$eval('#status-text', el => el.innerText);
        let idleStatusOp2 = await page2.$eval('#status-text', el => el.innerText);
        console.log('Reposo tras TX Op 1:', { Op1: idleStatusOp1, Op2: idleStatusOp2 });

        // Test Transmission: Op 2 talks
        console.log('6. Operador 2 presiona PTT (TX)...');
        const talkBtn2 = await page2.$('#talk-btn');
        const box2 = await talkBtn2.boundingBox();
        await page2.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
        await page2.mouse.down();
        await new Promise(r => setTimeout(r, 800));

        let rxStatusOp1 = await page1.$eval('#status-text', el => el.innerText);
        let txStatusOp2 = await page2.$eval('#status-text', el => el.innerText);
        console.log('Transmisión Op 2 -> Op 1:', { Op1_RX: rxStatusOp1, Op2_TX: txStatusOp2 });

        // Release PTT Op 2
        console.log('7. Operador 2 suelta PTT...');
        await page2.mouse.up();
        await new Promise(r => setTimeout(r, 800));

        let finalOp1 = await page1.$eval('#status-text', el => el.innerText);
        let finalOp2 = await page2.$eval('#status-text', el => el.innerText);
        console.log('Reposo final:', { Op1: finalOp1, Op2: finalOp2 });

        console.log('\n=== RESULTADO FINAL PTT MULTI-OPERADOR ===');
        const op1TxOk = txStatusOp1.includes('TRANSMITIENDO') && rxStatusOp2.includes('RECIBIENDO');
        const op2TxOk = txStatusOp2.includes('TRANSMITIENDO') && rxStatusOp1.includes('RECIBIENDO');
        const idleOk = finalOp1 === 'STANDBY' && finalOp2 === 'STANDBY';

        if (op1TxOk && op2TxOk && idleOk) {
            console.log('✅ PUSH-TO-TALK BIDIRECCIONAL COMPLETO: 100% OPERATIVO Y VERIFICADO!');
        } else {
            console.log('⚠️ Resultado detallado:', { op1TxOk, op2TxOk, idleOk });
        }

    } finally {
        await browser.close();
    }
}

main().catch(err => {
    console.error('CRITICAL ERROR:', err);
    process.exit(1);
});
