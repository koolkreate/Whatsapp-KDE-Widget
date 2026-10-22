'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolation: never touch the real backend/data directory.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-archives-'));
process.env.WA_DATA_DIR = TMP_DIR;

const archivesLib = require('../lib/archives');

const ARCHIVES_FILE = path.join(TMP_DIR, 'archived_chats.json');

test.after(() => {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
    delete process.env.WA_DATA_DIR;
});

test('getArchived returns empty array when file does not exist', () => {
    if (fs.existsSync(ARCHIVES_FILE)) fs.unlinkSync(ARCHIVES_FILE);
    assert.deepEqual(archivesLib.getArchived(), []);
});

test('setArchived adds and removes chat IDs idempotently', () => {
    if (fs.existsSync(ARCHIVES_FILE)) fs.unlinkSync(ARCHIVES_FILE);

    const chatId = '123456789@c.us';
    const added = archivesLib.setArchived(chatId, true);
    assert.ok(added.includes(chatId));

    // Repeating the add must not duplicate the id.
    const addedAgain = archivesLib.setArchived(chatId, true);
    assert.deepEqual(addedAgain, [chatId]);
    assert.equal(archivesLib.isArchived(chatId), true);

    const removed = archivesLib.setArchived(chatId, false);
    assert.ok(!removed.includes(chatId));

    // Repeating the remove is a no-op.
    const removedAgain = archivesLib.setArchived(chatId, false);
    assert.deepEqual(removedAgain, []);
    assert.equal(archivesLib.isArchived(chatId), false);
});

test('setArchived defaults to archiving when flag omitted', () => {
    if (fs.existsSync(ARCHIVES_FILE)) fs.unlinkSync(ARCHIVES_FILE);

    const chatId = 'defaults@c.us';
    const list = archivesLib.setArchived(chatId);
    assert.ok(list.includes(chatId));
});

test('setArchived with empty chatId returns current list unchanged', () => {
    archivesLib.saveArchived(['keep@c.us']);
    const list = archivesLib.setArchived('', true);
    assert.deepEqual(list, ['keep@c.us']);
});

test('saveArchived deduplicates and filters empty values', () => {
    const clean = archivesLib.saveArchived(['abc', 'abc', '', null, 'def']);
    assert.deepEqual(clean, ['abc', 'def']);
    assert.deepEqual(archivesLib.getArchived(), ['abc', 'def']);
});

test('isArchived honours an explicit list argument', () => {
    assert.equal(archivesLib.isArchived('abc', ['abc']), true);
    assert.equal(archivesLib.isArchived('xyz', ['abc']), false);
    assert.equal(archivesLib.isArchived('', ['']), false);
});

test('getArchived returns [] for corrupt JSON and non-array content', () => {
    fs.writeFileSync(ARCHIVES_FILE, 'not json at all', 'utf8');
    assert.deepEqual(archivesLib.getArchived(), []);

    fs.writeFileSync(ARCHIVES_FILE, JSON.stringify({ nope: true }), 'utf8');
    assert.deepEqual(archivesLib.getArchived(), []);
});
