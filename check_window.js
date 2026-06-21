const puppeteer = require('./backend/node_modules/puppeteer-core');

async function run() {
    console.log("Launching browser...");
    const browser = await puppeteer.launch({
        executablePath: '/home/kwame-t/projects/whatsapp-kde-widget/chrome/linux-150.0.7871.24/chrome-linux64/chrome',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36');
    
    console.log("Navigating...");
    await page.goto('https://web.whatsapp.com', { waitUntil: 'networkidle0', timeout: 60000 });
    
    console.log("Checking window properties after 5 seconds...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const debugInfo = await page.evaluate(() => {
        return {
            hasRequire: typeof require !== 'undefined',
            windowDebug: typeof window.Debug !== 'undefined' ? {
                exists: true,
                keys: Object.keys(window.Debug || {}),
                version: window.Debug ? window.Debug.VERSION : null
            } : { exists: false },
            windowStore: typeof window.Store !== 'undefined',
            localStorageKeys: Object.keys(localStorage)
        };
    });
    
    console.log("Debug info:", JSON.stringify(debugInfo, null, 2));
    await browser.close();
}

run().catch(console.error);
