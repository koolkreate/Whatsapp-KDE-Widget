'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve the repository-bundled Chrome without assuming where the repo was
 * checked out. CHROME_BIN wins; otherwise scan chrome/<version>/chrome-linux64.
 * Returns undefined so puppeteer-core can use its own configured browser.
 */
module.exports = function chromePath() {
    if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

    const chromeRoot = path.join(__dirname, '..', 'chrome');
    try {
        for (const version of fs.readdirSync(chromeRoot)) {
            const candidate = path.join(chromeRoot, version, 'chrome-linux64', 'chrome');
            if (fs.existsSync(candidate)) return candidate;
        }
    } catch (e) {
        // No bundled Chrome in this checkout.
    }
    return undefined;
};
