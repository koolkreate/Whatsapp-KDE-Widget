'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pinsLib = require('../lib/pins');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PINS_FILE = path.join(DATA_DIR, 'pinned_chats.json');

test('getPinned returns empty array when file does not exist', () => {
    if (fs.existsSync(PINS_FILE)) fs.unlinkSync(PINS_FILE);
    assert.deepEqual(pinsLib.getPinned(), []);
});

test('togglePin adds and removes chat IDs', () => {
    if (fs.existsSync(PINS_FILE)) fs.unlinkSync(PINS_FILE);

    const chatId = '123456789@c.us';
    const added = pinsLib.togglePin(chatId);
    assert.ok(added.includes(chatId));

    const isP = pinsLib.isPinned(chatId);
    assert.equal(isP, true);

    const removed = pinsLib.togglePin(chatId);
    assert.ok(!removed.includes(chatId));
    assert.equal(pinsLib.isPinned(chatId), false);
});

test('savePinned deduplicates and filters empty values', () => {
    const clean = pinsLib.savePinned(['abc', 'abc', '', null, 'def']);
    assert.deepEqual(clean, ['abc', 'def']);
    assert.deepEqual(pinsLib.getPinned(), ['abc', 'def']);
});
