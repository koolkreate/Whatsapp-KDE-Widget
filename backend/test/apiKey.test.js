'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const apiKey = require('../lib/apiKey');

const originalConfigFile = process.env.WA_CONFIG_FILE;
const originalApiKey = process.env.WA_API_KEY;

function tempConfig(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-api-key-'));
    const file = path.join(dir, 'whatsapp-kde-widget.ini');
    process.env.WA_CONFIG_FILE = file;
    delete process.env.WA_API_KEY;
    t.after(() => {
        if (originalConfigFile === undefined) delete process.env.WA_CONFIG_FILE;
        else process.env.WA_CONFIG_FILE = originalConfigFile;
        if (originalApiKey === undefined) delete process.env.WA_API_KEY;
        else process.env.WA_API_KEY = originalApiKey;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return file;
}

test('creates a private shared key file when missing', (t) => {
    const file = tempConfig(t);
    const key = apiKey.loadOrCreateKey();

    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(apiKey.readKey(file), key);
    assert.equal(fs.readFileSync(file, 'utf8'), `[General]\napiKey=${key}\n`);
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
});

test('reuses an existing persisted key', (t) => {
    const file = tempConfig(t);
    fs.writeFileSync(file, '[General]\napiKey=existing-key\n', { mode: 0o600 });

    assert.equal(apiKey.loadOrCreateKey(), 'existing-key');
    assert.equal(apiKey.loadOrCreateKey(), 'existing-key');
    assert.equal(apiKey.readKey(file), 'existing-key');
});

test('WA_API_KEY override wins and is persisted for the widget', (t) => {
    const file = tempConfig(t);
    process.env.WA_API_KEY = 'ci-test-key';

    assert.equal(apiKey.loadOrCreateKey(), 'ci-test-key');
    assert.equal(apiKey.readKey(file), 'ci-test-key');
    assert.match(fs.readFileSync(file, 'utf8'), /^\[General\]\napiKey=ci-test-key\n$/);
});

test('tightens permissions on an existing world-readable key file', (t) => {
    if (process.platform === 'win32') t.skip('POSIX permissions only');
    const file = tempConfig(t);
    fs.writeFileSync(file, '[General]\napiKey=existing-key\n');
    fs.chmodSync(file, 0o644);

    assert.equal(apiKey.loadOrCreateKey(), 'existing-key');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
