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
    
    console.log("Waiting 10 seconds for page to load fully...");
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    const pageInfo = await page.evaluate(() => {
        const canvases = [...document.querySelectorAll('canvas')].map(c => ({
            ariaLabel: c.getAttribute('aria-label'),
            parentDataRef: c.parentElement ? c.parentElement.getAttribute('data-ref') : null,
            outerHTML: c.outerHTML
        }));
        
        const divs = [...document.querySelectorAll('div')].filter(d => d.dataset && d.dataset.testid).map(d => ({
            testid: d.dataset.testid,
            classes: d.className
        }));
        
        return {
            canvases,
            divsCount: divs.length,
            divsSample: divs.slice(0, 10),
            bodyTextLength: document.body.innerText.length,
            bodyTextSnippet: document.body.innerText.slice(0, 500)
        };
    });
    
    console.log("Page info:", JSON.stringify(pageInfo, null, 2));
    await browser.close();
}

run().catch(console.error);
