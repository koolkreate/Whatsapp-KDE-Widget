'use strict';

/*
 * mockBackend.js — dependency-free mock of the WhatsApp widget backend.
 *
 * Implements the exact API contract main.qml depends on (see TESTING.md):
 * /api/status, /api/getAllChats, /api/getChatMessages (limit + since +
 * beforeId pagination), /api/waitMessages (long-poll), /api/getMedia,
 * /api/getAvatars, /api/getPinnedChats and success stubs for the write
 * endpoints. Serves a canned dataset with 45 messages (for pagination), a
 * captioned photo, an inline-base64 photo and timed incoming-message
 * injections so the agent test workflow can verify scroll stability.
 *
 * Run: node test/mockBackend.js [port]   (default 8003)
 */

const http = require('http');

const PORT = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 8003;

// A real 1x1 transparent PNG so the QML Image elements decode it.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = 'data:image/png;base64,' + PNG_1PX;

// Deterministic 64-bar waveform like WhatsApp's own msg.waveform.
function mockWaveform() {
    const out = [];
    for (let i = 0; i < 64; i++) {
        out.push(Math.max(0, Math.min(100, Math.round(50 + 48 * Math.sin(i / 3)))));
    }
    return out;
}

// Tiny valid WAV (silence) so the widget's MediaPlayer gets decodable
// bytes for audio getMedia responses. 0.5s 8kHz mono 16-bit ≈ 8KB.
function silentWavDataUrl() {
    const rate = 8000;
    const n = 4000;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    return 'data:audio/wav;base64,' + buf.toString('base64');
}
const WAV_DATA_URL = silentWavDataUrl();

// Canned voice-note file the driver sends through the real sendFile path
// (the microphone itself can't exist headless). Written once at startup.
const VOICE_FIXTURE_PATH = '/tmp/widvoice_fixture.ogg';
try {
    require('fs').writeFileSync(
        VOICE_FIXTURE_PATH,
        Buffer.from(WAV_DATA_URL.split(',')[1], 'base64'));
} catch (e) {}

// Ledger of files the widget asked us to send, for send-path assertions.
const sentFiles = [];

function findMsgById(msgId) {
    for (const id of Object.keys(state.chats)) {
        const msgs = state.chats[id].msgs;
        for (let i = 0; i < msgs.length; i++) {
            if (String(msgs[i].id) === String(msgId)) return msgs[i];
        }
    }
    return null;
}

const CHAT_A = 'mock_chat_a@s.whatsapp.net';
const CHAT_B = 'mock_chat_b@s.whatsapp.net';

// ── Canned dataset ───────────────────────────────────────────────────────────

function buildMessages() {
    const msgs = [];
    const t0 = 1750000000;
    for (let i = 1; i <= 43; i++) {
        msgs.push({
            id: 'mock_msg_' + i,
            body: i % 7 === 0
                ? 'Message number ' + i + ' with a slightly longer body so bubbles wrap around and vary in height.'
                : 'Message number ' + i,
            type: 'chat',
            t: t0 + i * 60,
            fromMe: i % 3 === 0,
            senderName: i % 3 === 0 ? '' : 'Kwame',
            reactions: [],
        });
    }
    // Reacted fixtures (AC-001/002/003): three reacted messages alongside
    // the unreacted majority above. Assigned in place so message order,
    // ids, timestamps and the total count are unchanged.
    //  - mock_msg_5: own reaction only (toggle-off target).
    //  - mock_msg_6: others-only reaction (click must ADD own, not remove).
    //  - mock_msg_7: multi-emoji (aggregation order/count target).
    const reactedFixtures = {
        mock_msg_5: [{ emoji: '👍', sender: '', fromMe: true }],
        mock_msg_6: [{ emoji: '❤️', sender: 'Kwame', fromMe: false }],
        mock_msg_7: [
            { emoji: '❤️', sender: 'Kwame', fromMe: false },
            { emoji: '👍', sender: 'Ama', fromMe: false },
            { emoji: '👍', sender: '', fromMe: true },
        ],
    };
    for (const m of msgs) {
        if (reactedFixtures[m.id]) m.reactions = reactedFixtures[m.id];
    }
    // Captioned photo — caption arrives in its own field with an empty
    // body (the real WhatsApp shape). The bubble must render it below the
    // image. No thumbUrl: the widget must fetch one via /api/getMedia.
    msgs.push({
        id: 'mock_msg_img_1',
        body: '',
        caption: 'Check out this sunset pic 🌅',
        type: 'image',
        t: t0 + 44 * 60,
        fromMe: false,
        senderName: 'Ama',
        reactions: [],
    });
    // Inline-base64 photo without caption (raw body renders directly).
    msgs.push({
        id: 'mock_msg_img_2',
        body: PNG_1PX,
        type: 'chat',
        t: t0 + 45 * 60,
        fromMe: true,
        senderName: '',
        reactions: [],
    });
    // Voice notes: empty body, separate waveform + duration (the real
    // WhatsApp shape). Two of them so exclusivity can be tested.
    msgs.push({
        id: 'mock_msg_ptt_1',
        body: '',
        type: 'ptt',
        t: t0 + 46 * 60,
        fromMe: false,
        senderName: 'Ama',
        waveform: mockWaveform(),
        duration: 18,
        reactions: [],
    });
    msgs.push({
        id: 'mock_msg_ptt_2',
        body: '',
        type: 'ptt',
        t: t0 + 47 * 60,
        fromMe: true,
        senderName: '',
        waveform: mockWaveform(),
        duration: 7,
        reactions: [],
    });
    return msgs;
}
const state = {
    chats: {
        [CHAT_A]: { id: CHAT_A, name: 'Ama Test', isGroup: false, unreadCount: 2, t: 0, msgs: buildMessages() },
        [CHAT_B]: {
            id: CHAT_B, name: 'Family Group', isGroup: true, unreadCount: 0, t: 0,
            msgs: [
                { id: 'mock_b_1', body: 'Dinner at 7?', type: 'chat', t: 1750009000, fromMe: false, senderName: 'Dad', reactions: [] },
                { id: 'mock_b_2', body: 'Yes please 🍽️', type: 'chat', t: 1750009060, fromMe: false, senderName: 'Mum', reactions: [] },
                { id: 'mock_b_3', body: '', type: 'ptt', t: 1750009120, fromMe: false, senderName: 'Dad', waveform: mockWaveform(), duration: 12, reactions: [] },
            ],
        },
    },
};

const MOCK_SCALE = Number(process.env.MOCK_SCALE || 0);
if (MOCK_SCALE > 2) {
    for (let i = 3; i <= MOCK_SCALE; i++) {
        const gid = 'mock_scale_' + i + '@g.us';
        const t = 1750000000 + i * 100;
        state.chats[gid] = {
            id: gid, name: 'Scale Group ' + i, isGroup: true,
            unreadCount: i % 5, t: t,
            msgs: [
                {
                    id: 'mock_scale_msg_' + i, body: 'Chatter number ' + i,
                    type: 'chat', t: t, fromMe: false,
                    senderName: 'Member' + i, reactions: [],
                },
            ],
        };
    }
}

function touchTimestamps() {
    for (const id of Object.keys(state.chats)) {
        const c = state.chats[id];
        const last = c.msgs[c.msgs.length - 1];
        c.t = last ? last.t : 0;
    }
}
touchTimestamps();

let chatsCalls = 0;
let avatarCalls = 0;

// Prod sig (backend/server.js computeMsgSig) is
// `len:lastId:lastT:rxCount:rxMarkers` where rxMarkers is `emoji:1|0`
// (1=fromMe) joined by `,` in message/reaction order, so a reaction-only
// edit changes the sig (e.g. `2:m2:200:0:` → `2:m2:200:1:👍:0`).
// This mirrors that scheme as far as the mock's data allows.
// Intentional divergence: prod also accepts raw WA shapes
// ({orphan, sent_by_me}); the mock only ever stores Node-shape
// {emoji, sender, fromMe}, so only that shape is read here.
function reactionMarker(r) {
    if (!r || typeof r !== 'object') return null;
    const emoji = r.emoji != null ? String(r.emoji) : '';
    if (!emoji) return null;
    return emoji + ':' + (r.fromMe ? '1' : '0');
}

function chatSig(c) {
    const list = c ? c.msgs : [];
    const n = list.length;
    const last = list[n - 1];
    let rxCount = 0;
    const rxParts = [];
    for (const m of list) {
        const reactions = (m && Array.isArray(m.reactions)) ? m.reactions : [];
        for (const r of reactions) {
            const mk = reactionMarker(r);
            if (mk) { rxCount++; rxParts.push(mk); }
        }
    }
    return n + ':' + (last ? last.id : '') + ':' + ((last && last.t) || 0) + ':' + rxCount + ':' + rxParts.join(',');
}

// Reaction-touched rows a `since` poll must still deliver (prod analog:
// prod diffs the fresh scrape against its per-chat cache snapshot; the
// mock keeps no per-client cache, so it tracks a process-wide dirty set
// instead — a touched row is redelivered on every since-poll until the
// mock restarts. Documented divergence, harmless for tests.)
const reactionDirty = {};
function markReactionDirty(msg) {
    if (msg && msg.id != null) reactionDirty[String(msg.id)] = true;
}

// `since`-filter that also surfaces reaction-only edits: rows excluded by
// `since` but touched by sendReaction are appended in dataset order, so a
// reaction-only poll never drops them. Pagination (beforeId/limit)
// callers never pass `since` and are unaffected.
function filterSinceWithReactions(chatMsgs, since) {
    const base = filterSince(chatMsgs, since);
    if (!since) return base;
    const known = {};
    for (const m of base) known[String(m.id)] = true;
    const touched = [];
    for (const m of chatMsgs) {
        if (!known[String(m.id)] && reactionDirty[String(m.id)]) touched.push(m);
    }
    return base.concat(touched);
}

// Timed incoming-message injections (used by the scroll-stability checks).
function injectMessage(chatId, label) {
    const c = state.chats[chatId];
    if (!c) return;
    const last = c.msgs[c.msgs.length - 1];
    c.msgs.push({
        id: 'mock_injected_' + label,
        body: 'Incoming "' + label + '" — should not teleport your scroll',
        type: 'chat',
        t: (last ? last.t : 0) + 60,
        fromMe: false,
        senderName: 'Ama',
        reactions: [],
    });
    c.t = c.msgs[c.msgs.length - 1].t;
    console.log('[mockBackend] injected', label, 'into', chatId);
}

// ── Message filtering (mirrors backend/lib/messages.js behaviour) ────────────

function filterSince(msgs, since) {
    if (!since) return msgs;
    for (let i = 0; i < msgs.length; i++) {
        if (String(msgs[i].id) === String(since.id)) return msgs.slice(i + 1);
    }
    return msgs.filter(m => (m.t || 0) > (Number(since.t) || 0));
}

function paginate(msgs, args) {
    const limit = Math.max(1, Math.min(Number(args.limit) > 0 ? Number(args.limit) : 20, 200));
    if (args.beforeId != null && args.beforeId !== '') {
        let idx = -1;
        for (let i = 0; i < msgs.length; i++) {
            if (String(msgs[i].id) === String(args.beforeId)) { idx = i; break; }
        }
        if (idx < 0 && args.beforeT) {
            const bt = Number(args.beforeT) || 0;
            for (let j = 0; j < msgs.length; j++) {
                if ((msgs[j].t || 0) >= bt) { idx = j; break; }
            }
        }
        if (idx < 0) return { page: [], hasMore: false };
        const start = Math.max(0, idx - limit);
        return { page: msgs.slice(start, idx), hasMore: start > 0 };
    }
    const start = Math.max(0, msgs.length - limit);
    return { page: msgs.slice(start), hasMore: start > 0 };
}

// ── Endpoint dispatch ────────────────────────────────────────────────────────

function listChats() {
    return Object.values(state.chats).map(c => {
        const last = c.msgs.length ? c.msgs[c.msgs.length - 1] : null;
        return {
            id: c.id, name: c.name, isGroup: c.isGroup,
            unreadCount: c.unreadCount, t: c.t,
            lastMessage: last ? {
                body: last.body || '', caption: last.caption || '',
                type: last.type || 'chat', t: last.t || 0,
                fromMe: !!last.fromMe, senderName: last.senderName || '',
            } : null,
        };
    });
}

function handle(body) {
    const args = (body && body.args) || body || {};
    switch (args._path) {
        case 'status':
            return { ready: true };
        case 'widtest':
            console.log('WIDTEST ' + JSON.stringify(args.entry || null));
            return { response: { ok: true } };
        case 'getAllChats': {
            chatsCalls++;
            const list = listChats();
            const after = Number(process.env.MOCK_RENAME_AFTER_CALLS || 0);
            if (after > 0 && chatsCalls > after) {
                for (const c of list) {
                    if (c.id === CHAT_B) {
                        c.name = c.name + ' — renamed!';
                        c.lastMessage = { body: 'New topic: holidays', t: c.t };
                    }
                }
            }
            const bumpAfter = Number(process.env.MOCK_BUMP_AFTER_CALLS || 0);
            if (bumpAfter > 0 && chatsCalls > bumpAfter) {
                for (const c of list) {
                    if (c.id === CHAT_B) {
                        c.t = 9999999999;
                        if (c.lastMessage) c.lastMessage.t = 9999999999;
                    }
                }
            }
            if (process.env.MOCK_ROTATE === '1' && list.length > 1) {
                const pick = list[chatsCalls % list.length];
                pick.t = 9000000000 + chatsCalls;
                pick.unreadCount = (pick.unreadCount || 0) + 1;
                if (pick.lastMessage) {
                    pick.lastMessage.t = pick.t;
                    pick.lastMessage.body = 'Update #' + chatsCalls;
                }
            }
            return { response: list };
        }
        case 'getAvatars': {
            if (process.env.MOCK_AVATARS_EMPTY === '1') return { response: [] };
            avatarCalls++;
            const rotate = process.env.MOCK_AVATAR_ROTATE === '1';
            const req = args.chats || [];
            return {
                response: req.map((c, i) => ({
                    id: c.id,
                    hash: 'mockhash' + (rotate ? (avatarCalls + i) % 3 : (i % 3)),
                    changed: true,
                })),
            };
        }
        case 'getPinnedChats':
            return { response: [] };
        case 'getChatMessages': {
            const c = state.chats[args.chatId];
            if (!c) return { response: [], hasMore: false, sig: '0::0:0:' };
            if (args.beforeId) console.log('[mock] prepend beforeId=' + args.beforeId);
            if (args.since) {
                return { response: filterSinceWithReactions(c.msgs, args.since), hasMore: false, sig: chatSig(c) };
            }
            const p = paginate(c.msgs, args);
            // Paginating a real backend takes hundreds of ms (WA scrape +
            // network); answer prepends after a beat so rapid back-to-back
            // swaps don't collapse into a single frame — a condition the
            // real backend never produces and scroll-restore can't observe.
            if (args.beforeId != null && args.beforeId !== '') {
                return { response: p.page, hasMore: p.hasMore, sig: chatSig(c), _delayMs: 250 };
            }
            return { response: p.page, hasMore: p.hasMore, sig: chatSig(c) };
        }
        case 'waitMessages': {
            // Long poll: respond after a short delay; `changed` when the
            // caller's sig no longer matches the dataset.
            const c = state.chats[args.chatId];
            const sig = c ? chatSig(c) : '0::0:0:';
            return { changed: !!(c && args.sig && args.sig !== sig), sig: sig, _delayMs: 700 };
        }
        case 'getMedia': {
            const target = findMsgById(args.msgId);
            if (target && (target.type === 'audio' || target.type === 'ptt')) {
                return { response: { dataUrl: WAV_DATA_URL, width: 0, height: 0 } };
            }
            return { response: { dataUrl: PNG_DATA_URL, width: 1, height: 1 } };
        }
        case 'sendText':
        case 'togglePinChat':
        case 'sendReaction': {
            // Actually mutate reactions[] like prod instead of no-op:
            // add an own entry on send, remove the own entry when
            // remove=true (AC-002/AC-003). Unknown msgId or blank emoji
            // is a no-op returning ok, mirroring prod's tolerant shape.
            // Returns prod's {response, method} shape while keeping the
            // legacy {response:{ok:true}} body existing consumers rely
            // on: the only in-repo sender (widget main.qml sendReaction)
            // checks HTTP 200 and never reads the body, and no test or
            // driver script parses it (verified Oct 2026).
            const emoji = args.reaction != null ? String(args.reaction).trim() : '';
            const msg = emoji ? findMsgById(args.msgId) : null;
            if (msg) {
                if (!Array.isArray(msg.reactions)) msg.reactions = [];
                if (args.remove) {
                    msg.reactions = msg.reactions.filter(
                        r => !(r && r.fromMe && String(r.emoji) === emoji));
                } else if (!msg.reactions.some(
                    r => r && r.fromMe && String(r.emoji) === emoji)) {
                    msg.reactions.push({ emoji: emoji, sender: '', fromMe: true });
                }
                markReactionDirty(msg);
            }
            return { response: { ok: true }, method: 'M-mock' };
        }
        case 'pasteImage':
        case 'openExternally':
        case 'restart':
        case 'logout':
            return { response: { ok: true } };
        case 'sendFile': {
            let info = { path: String((args.to || args.chatId || '')), file: String(args.filePath || args.path || '') };
            try {
                const fs = require('fs');
                const st = fs.statSync(info.file);
                info.exists = true;
                info.size = st.size;
            } catch (e) { info.exists = false; info.size = 0; }
            sentFiles.push(info);
            return { response: { ok: true } };
        }
        case 'testSentFiles':
            return { response: sentFiles };
        case 'testInject': {
            injectMessage(args.chatId || CHAT_A, args.label || 'x');
            const c = state.chats[args.chatId || CHAT_A];
            return { response: { ok: true, sig: c ? chatSig(c) : '0::0:0:' } };
        }
        default:
            return { error: 'unknown-path:' + (args._path || '?') };
    }
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    const url = req.url || '';
    if (req.method === 'GET' && url.indexOf('/api/avatar/') === 0) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from(PNG_1PX, 'base64'));
        return;
    }
    if (req.method === 'GET' && url.indexOf('/api/qr') === 0) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.from(PNG_1PX, 'base64'));
        return;
    }

    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
        body.args = body.args || {};
        // The request path is forwarded into args so `handle` can dispatch.
        body.args._path = url.replace(/^\/api\//, '').split('?')[0];

        const out = handle(body);
        const delay = out && out._delayMs ? out._delayMs : 0;
        setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
        }, delay);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('[mockBackend] listening on http://127.0.0.1:' + PORT);
});

// Injections are on-demand only (POST /api/testInject): the driver fires
// one exactly when a step has armed, so scroll assertions never depend on
// wall-clock phasing. No timed injections — they used to land mid-arm and
// flake every timing-sensitive step.
setTimeout(() => { console.log('[mockBackend] on-demand injection mode'); }, 1000);

