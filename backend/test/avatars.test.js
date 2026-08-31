'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const avatars = require('../lib/avatars');

// ── fnv1a ────────────────────────────────────────────────────────────────────
test('fnv1a is deterministic and hex-encoded', () => {
    const h1 = avatars.fnv1a('abc');
    const h2 = avatars.fnv1a('abc');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]+$/);
});

test('fnv1a differs for different inputs', () => {
    assert.notEqual(avatars.fnv1a('imgA'), avatars.fnv1a('imgB'));
});

// ── avatarPayload ────────────────────────────────────────────────────────────
test('avatarPayload includes data on first sight', () => {
    const p = avatars.avatarPayload('c1', 'DATA1', {});
    assert.equal(p.id, 'c1');
    assert.equal(p.changed, true);
    assert.equal(p.data, 'DATA1');
    assert.ok(p.hash);
});

test('avatarPayload omits data when hash is unchanged', () => {
    const first = avatars.avatarPayload('c1', 'DATA1', {});
    const second = avatars.avatarPayload('c1', 'DATA1', { c1: first.hash });
    assert.equal(second.changed, false);
    assert.equal(second.data, null);
    assert.equal(second.hash, first.hash);
});

test('avatarPayload includes data again when the image changes', () => {
    const first = avatars.avatarPayload('c1', 'DATA1', {});
    const second = avatars.avatarPayload('c1', 'DATA2', { c1: first.hash });
    assert.equal(second.changed, true);
    assert.equal(second.data, 'DATA2');
});

test('avatarPayload handles null/empty base64', () => {
    const p = avatars.avatarPayload('c1', null, {});
    assert.equal(p.changed, false);
    assert.equal(p.data, null);
    assert.equal(p.hash, '');
});

// ── matchAvatarsToChats ──────────────────────────────────────────────────────
test('matchAvatarsToChats maps chats to avatars by normalized name', () => {
    const chats = [
        { id: 'a@x', name: 'Mesoma' },
        { id: 'b@x', name: '  john  DOE ' },
    ];
    const dom = [
        { name: 'mesoma', base64: 'AAAA' },
        { name: 'John Doe', base64: 'BBBB' },
    ];
    const map = avatars.matchAvatarsToChats(chats, dom);
    assert.equal(map.get('a@x'), 'AAAA');
    assert.equal(map.get('b@x'), 'BBBB');
});

test('matchAvatarsToChats ignores chats without a DOM avatar', () => {
    const chats = [{ id: 'a@x', name: 'Lonely' }];
    const map = avatars.matchAvatarsToChats(chats, [{ name: 'other', base64: 'X' }]);
    assert.equal(map.size, 0);
});

test('matchAvatarsToChats skips DOM rows without base64', () => {
    const chats = [{ id: 'a@x', name: 'Mesoma' }];
    const map = avatars.matchAvatarsToChats(chats, [{ name: 'mesoma', base64: null }]);
    assert.equal(map.size, 0);
});

// ── classifyImageSrc ─────────────────────────────────────────────────────────
test('classifyImageSrc categorises image sources', () => {
    assert.equal(avatars.classifyImageSrc('data:image/jpeg;base64,AA'), 'data');
    assert.equal(avatars.classifyImageSrc('blob:https://web.whatsapp.com/x'), 'blob');
    assert.equal(avatars.classifyImageSrc('https://mmg.whatsapp.net/v/x.jpg'), 'https');
    assert.equal(avatars.classifyImageSrc(''), 'empty');
    assert.equal(avatars.classifyImageSrc(null), 'none');
});

// ── extractAvatars (injectable document) ─────────────────────────────────────
function fakeDoc(rows) {
    return { querySelectorAll: function () { return rows; } };
}

test('extractAvatars pulls title + data-uri image per chat row', () => {
    const longB64 = 'QUJD'.repeat(64); // 256 chars, above the placeholder threshold
    const rows = [{
        querySelector: function (sel) {
            if (sel.indexOf('cell-frame-title') !== -1) {
                return { title: '', textContent: 'Mesoma' };
            }
            if (sel.indexOf('img') !== -1) {
                return { getAttribute: function (n) { return n === 'src' ? 'data:image/jpeg;base64,' + longB64 : null; } };
            }
            return null;
        }
    }];
    const out = avatars.extractAvatars(fakeDoc(rows));
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'Mesoma');
    assert.equal(out[0].kind, 'data');
    assert.equal(out[0].base64, longB64);
});

test('extractAvatars captures CDN https avatar urls with kind=https', () => {
    const rows = [{
        querySelector: function (sel) {
            if (sel.indexOf('cell-frame-title') !== -1) {
                return { title: '', textContent: 'Mesoma' };
            }
            if (sel.indexOf('img') !== -1) {
                return { getAttribute: function (n) { return n === 'src' ? 'https://media-lhr11-1.cdn.whatsapp.net/v/t61.24694' : null; } };
            }
            return null;
        }
    }];
    const out = avatars.extractAvatars(fakeDoc(rows));
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'Mesoma');
    assert.equal(out[0].kind, 'https');
    assert.equal(out[0].src, 'https://media-lhr11-1.cdn.whatsapp.net/v/t61.24694');
});

test('extractAvatars skips placeholder gif rows and rows without an image', () => {
    const rows = [
        { querySelector: function () { return null; } },
        { querySelector: function (sel) {
            if (sel.indexOf('cell-frame-title') !== -1) return { title: 'NoPic', textContent: '' };
            return null;
        } },
        { querySelector: function (sel) {
            if (sel.indexOf('cell-frame-title') !== -1) return { title: '', textContent: 'Placeholder' };
            if (sel.indexOf('img') !== -1) return { getAttribute: function (n) { return n === 'src' ? 'data:image/gif;base64,R0lGOD' : null; } };
            return null;
        } },
    ];
    const out = avatars.extractAvatars(fakeDoc(rows));
    assert.equal(out.length, 0);
});

test('extractAvatars tolerates a missing pane', () => {
    assert.deepEqual(avatars.extractAvatars(null), []);
});
