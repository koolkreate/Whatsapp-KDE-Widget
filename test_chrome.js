const path = require('path');
const puppeteer = require('./backend/node_modules/puppeteer-core');
const chromePath = require('./test/chromePath');

async function run() {
    console.log("Launching browser...");
    const browser = await puppeteer.launch({
        executablePath: chromePath(),
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    console.log("Browser launched.");
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
    
    console.log("Navigating to WhatsApp Web...");
    try {
        await page.goto('https://web.whatsapp.com', {
            waitUntil: 'networkidle0',
            timeout: 60000
        });
        console.log("Navigation complete.");
    } catch (err) {
        console.error("Navigation error:", err);
    }
    
    console.log("Taking screenshot...");
    await page.screenshot({ path: path.join(__dirname, 'wa_screenshot.png') });
    console.log("Screenshot saved to wa_screenshot.png");
    
    await browser.close();
    console.log("Done.");
}

run().catch(console.error);
