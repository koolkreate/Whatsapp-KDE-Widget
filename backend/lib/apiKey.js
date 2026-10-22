'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE_NAME = 'whatsapp-kde-widget.ini';

/**
 * The widget and backend share a small INI file. Keep the path calculation
 * aligned with QML's StandardPaths.GenericConfigLocation.
 */
function configPath() {
    if (process.env.WA_CONFIG_FILE) return process.env.WA_CONFIG_FILE;
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, CONFIG_FILE_NAME);
}

function readKey(file = configPath()) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        const match = text.match(/^\s*apiKey\s*=\s*(.*?)\s*$/m);
        return match ? match[1] : '';
    } catch (err) {
        if (err.code === 'ENOENT') return '';
        throw err;
    }
}

function writeKey(key, file = configPath()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `[General]\napiKey=${key}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) { /* non-POSIX */ }
}

/**
 * Use WA_API_KEY when provided (CI/tests), otherwise reuse the persisted key.
 * A missing key is generated once and written with owner-only permissions so
 * the QML widget can read the same value.
 */
function loadOrCreateKey() {
    const file = configPath();
    const override = (process.env.WA_API_KEY || '').trim();
    const existing = readKey(file);
    const key = override || existing || crypto.randomBytes(32).toString('hex');

    if (existing !== key) {
        writeKey(key, file);
    } else {
        try { fs.chmodSync(file, 0o600); } catch (_) { /* non-POSIX */ }
    }

    return key;
}

module.exports = { CONFIG_FILE_NAME, configPath, readKey, writeKey, loadOrCreateKey };
