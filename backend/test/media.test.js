'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    parseMediaArgs,
    parseOpenArgs,
    sanitizeMsgId,
    cacheKey,
    createMediaCache,
    getMediaInPage,
    MEDIA_MAX_BYTES,
    DEFAULT_MAX_EDGE,
} = require('../lib/media');

// ── parseMediaArgs ──────────────────────────────────────────────────────────

test('parseMediaArgs accepts args-wrapped and bare bodies', () => {
    const a = parseMediaArgs({ args: { chatId: 'c1', msgId: 'm1', maxEdge: 480 } });
    assert.deepEqual(a, { chatId: 'c1', msgId: 'm1', maxEdge: 480 });
    const b = parseMediaArgs({ chatId: 'c1', msgId: 'm1', maxEdge: 0 });
    assert.deepEqual(b, { chatId: 'c1', msgId: 'm1', maxEdge: 0 });
});

test('parseMediaArgs rejects missing chatId or msgId', () => {
    assert.ok(parseMediaArgs({ args: { msgId: 'm1' } }).error);
    assert.ok(parseMediaArgs({ args: { chatId: 'c1' } }).error);
    assert.ok(parseMediaArgs({}).error);
    assert.ok(parseMediaArgs(null).error);
});

test('parseMediaArgs defaults maxEdge to 480 and keeps explicit 0', () => {
    assert.equal(parseMediaArgs({ chatId: 'c', msgId: 'm' }).maxEdge, DEFAULT_MAX_EDGE);
    assert.equal(parseMediaArgs({ chatId: 'c', msgId: 'm', maxEdge: 0 }).maxEdge, 0);
    assert.equal(parseMediaArgs({ chatId: 'c', msgId: 'm', maxEdge: 'abc' }).maxEdge, DEFAULT_MAX_EDGE);
    assert.equal(parseMediaArgs({ chatId: 'c', msgId: 'm', maxEdge: -5 }).maxEdge, DEFAULT_MAX_EDGE);
    assert.equal(parseMediaArgs({ chatId: 'c', msgId: 'm', maxEdge: '480' }).maxEdge, 480);
});

// ── parseOpenArgs ─────────────────────────────────────────────────────────

test('parseOpenArgs accepts args-wrapped and bare bodies', () => {
    assert.deepEqual(parseOpenArgs({ args: { chatId: 'c1', msgId: 'm1' } }), { chatId: 'c1', msgId: 'm1' });
    assert.deepEqual(parseOpenArgs({ chatId: 'c1', msgId: 'm1' }), { chatId: 'c1', msgId: 'm1' });
});

test('parseOpenArgs rejects missing chatId or msgId', () => {
    assert.ok(parseOpenArgs({ args: { msgId: 'm1' } }).error);
    assert.ok(parseOpenArgs({ args: { chatId: 'c1' } }).error);
    assert.ok(parseOpenArgs({}).error);
    assert.ok(parseOpenArgs(null).error);
});

// ── sanitizeMsgId ─────────────────────────────────────────────────────────

test('sanitizeMsgId keeps safe chars only', () => {
    assert.equal(sanitizeMsgId('ABC_abc-123'), 'ABC_abc-123');
    assert.equal(sanitizeMsgId('true_123@c.us_456'), 'true_123_c.us_456'.replace('.', '_'));
    assert.equal(sanitizeMsgId('a/b\\c:d e'), 'a_b_c_d_e');
    assert.equal(sanitizeMsgId('../../etc/passwd'), 'etc_passwd');
});

test('sanitizeMsgId falls back when nothing safe remains', () => {
    assert.equal(sanitizeMsgId(''), 'media');
    assert.equal(sanitizeMsgId('...'), 'media');
    assert.equal(sanitizeMsgId(null), 'media');
});

test('sanitizeMsgId caps length for file names', () => {
    const long = sanitizeMsgId('x'.repeat(200));
    assert.ok(long.length <= 64);
});

// ── cacheKey ────────────────────────────────────────────────────────────────

test('cacheKey formats chatId|msgId|maxEdge', () => {
    assert.equal(cacheKey('c1', 'm1', 480), 'c1|m1|480');
    assert.equal(cacheKey('c1', 'm1', 0), 'c1|m1|0');
    assert.notEqual(cacheKey('c1', 'm1', 480), cacheKey('c1', 'm1', 0));
});

// ── LRU byte-capped cache ───────────────────────────────────────────────────

test('media cache returns puts and tracks bytes', () => {
    const c = createMediaCache(1024);
    assert.equal(c.get('k1'), undefined);
    c.put('k1', { dataUrl: 'abcd', width: 100, height: 50 });
    const hit = c.get('k1');
    assert.equal(hit.dataUrl, 'abcd');
    assert.equal(hit.width, 100);
    assert.equal(hit.height, 50);
    assert.equal(c.bytes, 4);
});

test('media cache evicts oldest first under the byte cap', () => {
    const c = createMediaCache(10);
    c.put('k1', { dataUrl: '12345', width: 1, height: 1 }); // 5 bytes
    c.put('k2', { dataUrl: '12345', width: 1, height: 1 }); // 10 total
    c.put('k3', { dataUrl: '123', width: 1, height: 1 }); // 13 > 10 → evict k1
    assert.equal(c.get('k1'), undefined);
    assert.ok(c.get('k2'));
    assert.ok(c.get('k3'));
    assert.ok(c.bytes <= 10);
});

test('media cache get refreshes recency so hot keys survive', () => {
    const c = createMediaCache(10);
    c.put('k1', { dataUrl: '12345', width: 1, height: 1 });
    c.put('k2', { dataUrl: '12345', width: 1, height: 1 });
    c.get('k1'); // k1 is now newest; k2 is oldest
    c.put('k3', { dataUrl: '123', width: 1, height: 1 }); // evicts k2
    assert.ok(c.get('k1'));
    assert.equal(c.get('k2'), undefined);
    assert.ok(c.get('k3'));
});

test('media cache default cap is ~30MB', () => {
    assert.equal(MEDIA_MAX_BYTES, 30 * 1024 * 1024);
    assert.equal(createMediaCache().maxBytes, MEDIA_MAX_BYTES);
});

// ── in-page extractor shape ─────────────────────────────────────────────────

test('getMediaInPage is async and fully self-contained', () => {
    assert.equal(getMediaInPage.constructor.name, 'AsyncFunction');
    const src = getMediaInPage.toString();
    assert.ok(!/require\(['"]\.\//.test(src), 'must not reference module-scope files');
    assert.ok(src.indexOf('deriveBits') !== -1, 'HKDF key expansion in-page');
    assert.ok(src.indexOf('AES-CBC') !== -1, 'AES-CBC decrypt in-page');
    assert.ok(src.indexOf('deprecatedMms3Url') !== -1, 'mmg download in-page');
    assert.ok(src.indexOf('createImageBitmap') !== -1);
    assert.ok(src.indexOf('toDataURL') !== -1);
});
