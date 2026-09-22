/**
 * WhatsApp KDE Widget — Minimal Backend Server
 * 
 * Uses puppeteer-core directly (already installed as a dep of wa-automate)
 * so we bypass the broken wa-automate initializer entirely.
 * 
 * Flow:
 *  1. Launch Chrome 150 with a persistent user-data-dir (for session caching)
 *  2. Navigate to web.whatsapp.com
 *  3. Emit QR code as PNG whenever it appears (saves to qr.png)
 *  4. Wait for the app to be "ready" (chat pane loaded)
 *  5. Expose REST API for getAllChats and sendText
 */

'use strict';

const puppeteer = require('./node_modules/puppeteer-core');
const replyLib = require('./lib/reply');
const avatarsLib = require('./lib/avatars');
const messagesLib = require('./lib/messages');
const mediaLib = require('./lib/media');
const pinsLib = require('./lib/pins');
const chatPreviewLib = require('./lib/chatPreview');
const { waitForSigChange } = require('./lib/longPoll');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

const PORT = 8002;
const API_KEY = 'KDE_WHATSAPP_SECRET_KEY';
const QR_PATH = path.join(__dirname, '..', 'qr.png');
const DATA_DIR = path.join(__dirname, '_IGNORE_whatsapp-kde-session');
const CHROME = path.join(__dirname, '..', 'chrome', 'linux-150.0.7871.24', 'chrome-linux64', 'chrome');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// ── State ───────────────────────────────────────────────────────────────────
let waPage = null;  // puppeteer Page
let isReady = false; // WA app loaded & authenticated
let browser = null;
let currentOpenChatId = null;
// Per-chat message cache: the widget polls getChatMessages every 5s and also
// refetches after each send. Caching for a few seconds collapses those into
// one real DOM/webpack scrape and lets the widget skip re-rendering when
// nothing changed (via the returned `sig`).
const MSG_CACHE_TTL_MS = 3000;
const MSG_CACHE_MAX = 200; // only ever return the most recent N messages
const msgCache = new Map(); // chatId -> { t, sig, messages }
// Avatar bytes keyed by content hash; served via GET /api/avatar/<hash> so the
// widget can use them as plain <img> sources (browser/QML caches the rest).
const avatarStore = new Map();

async function getValidPage() {
    if (!browser || typeof browser.isConnected !== 'function' || !browser.isConnected()) {
        console.log('[HEAL] Browser is not connected, launching...');
        isReady = false;
        await launch();
        for (let i = 0; i < 20; i++) {
            if (isReady) break;
            await new Promise(r => setTimeout(r, 500));
        }
        return waPage;
    }
    
    try {
        await waPage.url();
    } catch (e) {
        console.log('[HEAL] waPage is detached or invalid. Error:', e.message);
        try {
            const pages = await browser.pages();
            if (pages.length > 0) {
                waPage = pages[0];
                console.log('[HEAL] Successfully re-acquired waPage from browser.pages()');
            } else {
                console.log('[HEAL] No pages found in browser, creating new page...');
                waPage = await browser.newPage();
                await waPage.setUserAgent(UA);
                await waPage.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                });
                isReady = false;
                await waPage.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
                waitForAppOrQR();
                for (let i = 0; i < 20; i++) {
                    if (isReady) break;
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        } catch (err) {
            console.log('[HEAL] Failed to re-acquire page, relaunching browser...', err.message);
            isReady = false;
            await launch();
            for (let i = 0; i < 20; i++) {
                if (isReady) break;
                await new Promise(r => setTimeout(r, 500));
            }
        }
    }
    return waPage;
}


// ── Lost-auth detection ──────────────────────────────────────────────────────
// True when the page is showing the WhatsApp login/QR screen instead of an
// authenticated chat list. Used by getAllChats to catch sessions that WhatsApp
// has logged out (the widget then resets the flow via POST /api/logout).
async function pageIsLoggedOut(waPage) {
    try {
        return await waPage.evaluate(() => {
            const tids = Array.from(document.querySelectorAll('[data-testid]'))
                .map(el => el.getAttribute('data-testid') || '');
            return tids.some(t => t.indexOf('link-device') === 0 || t.indexOf('link_device') === 0);
        });
    } catch (_) { return false; }
}


// ── Webpack module helper (injected once into the page) ──────────────────────
// WhatsApp Web uses webpack - window.Store doesn't exist, we must use require()
const STORE_INJECT_JS = `
(function() {
  if (window._WA_STORE_INJECTED) return;
  try {
    // Walk all loaded webpack modules to find the ones we need
    const findModule = (check) => {
      let result;
      const req = window.webpackChunkwhatsapp_web_client;
      if (!req) return null;
      req.push([[''], {}, (e) => {
        const mods = e.m;
        for (let k in mods) {
          try {
            const m = e(k);
            if (m && check(m)) { result = m; break; }
          } catch(_) {}
        }
      }]);
      return result || null;
    };

    window._WA = {
      Chat: findModule(m => m.default && m.default.getModelsArray && m.default.prototype && m.default.prototype.sendSeen),
      Message: findModule(m => m.default && m.default.getModelsArray && !m.default.prototype.sendSeen && m.default.prototype.body !== undefined),
    };
    window._WA_STORE_INJECTED = true;
    console.log('[WA-BACKEND] Store injection done. Chat:', !!window._WA.Chat);
  } catch(e) {
    console.log('[WA-BACKEND] Store injection error:', e.message);
  }
})()
`;

// ── Status endpoint (NO auth required — health check) ───────────────────────
app.get('/api/status', (_req, res) => {
    let hasQr = false;
    try { hasQr = fs.existsSync(QR_PATH); } catch (_) { hasQr = false; }
    res.json({ ready: isReady, hasQr });
});

// ── Auth middleware (applies to all routes below this line) ─────────────────
app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.headers['api-key'] || req.query.key;
    if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

// ── getAllChats: page-side extraction (self-contained) ──────────────────────
// Runs inside the WhatsApp page. Must not reference module scope — it is
// serialized into the page via toString (see the route below), matching the
// lib/avatars.js pattern. The two helpers are injected the same way.
function getAllChatsInPage(extractLastMessage, extractChatListRows) {

    // ── Contact collection for chat-name resolution ──────────────────────
    // LID-migrated 1-1 chats carry the raw phone number in formattedTitle
    // while the saved contact name lives on chat.contact / the contact
    // collection. Located once, used by resolveChatName below.
    let nameColl = null;
    try {
        if (typeof window.require !== 'undefined') {
            const contactMod = window.require('WAWebContactCollection');
            const cc = contactMod.ContactCollection || contactMod.ContactCollectionImpl;
            if (cc && typeof cc.get === 'function') nameColl = cc;
        }
    } catch (e) { }

    // Prefer the chat's own title unless it is empty or number-like; then
    // prefer the saved contact name (chat.contact, else collection lookup
    // by chat id). Never throws and never blanks: worst case the raw title
    // survives, so unsaved contacts keep showing their number.
    function looksLikeNumber(s) {
        var t = String(s == null ? '' : s).trim();
        if (t.length < 5) return false;
        if (/[a-zA-Z]/.test(t)) return false;
        var digits = t.replace(/\D/g, '');
        return digits.length >= 5;
    }
    function contactDisplayName(contact) {
        if (!contact) return '';
        var n = null;
        try {
            n = contact.name || contact.pushname || contact.verifiedName ||
                contact.formattedName || contact.shortName || '';
        } catch (e) { n = ''; }
        return n || '';
    }
    function resolveChatName(chat, rawName) {
        try {
            var name = String(rawName == null ? '' : rawName);
            if (name && !looksLikeNumber(name)) return name;
            var contact = null;
            try { contact = (chat && chat.contact) || null; } catch (e) { contact = null; }
            if (!contact && nameColl) {
                try {
                    var cid = chat && chat.id;
                    var key = (cid && cid._serialized) || cid;
                    if (key) contact = nameColl.get(String(key));
                } catch (e) { contact = null; }
            }
            var resolved = contactDisplayName(contact);
            return resolved || name;
        } catch (e) {
            return String(rawName == null ? '' : rawName);
        }
    }

    // ── Method 1: WAWebChatCollection singleton ──────────────────────────
    try {
        const mod = window.require('WAWebChatCollection');
        // Try ChatCollection (often the singleton Backbone collection)
        const coll = mod.ChatCollection || mod.ChatCollectionImpl;
        if (coll && typeof coll.getModelsArray === 'function') {
            return coll.getModelsArray().map(c => ({
                id: c.id && c.id._serialized || String(c.id),
                name: resolveChatName(c, c.formattedTitle || c.name || ''),
                formattedTitle: c.formattedTitle || '',
                isGroup: !!c.isGroup,
                isPinned: !!(c.pin || c.isPinned),
                unreadCount: c.unreadCount || 0,
                t: c.t || 0,
                lastMessage: extractLastMessage(c),
            }));
        }
    } catch (e) { }

    // ── Method 2: WAWebStore or WAWebStoreService ────────────────────────
    try {
        const storeNames = ['WAWebStore', 'WAWebStoreService',
            'WAWebChatListBus', 'WAWebOrderedChatListBus'];
        for (const name of storeNames) {
            try {
                const m = window.require(name);
                const d = m && (m.default || m);
                if (d && typeof d.getModelsArray === 'function') {
                    return d.getModelsArray().map(c => ({
                        id: c.id && c.id._serialized || String(c.id),
                        name: resolveChatName(c, c.formattedTitle || c.name || ''),
                        formattedTitle: c.formattedTitle || '',
                        isGroup: !!c.isGroup,
                        isPinned: !!(c.pin || c.isPinned),
                        unreadCount: c.unreadCount || 0,
                        t: c.t || 0,
                        lastMessage: extractLastMessage(c),
                    }));
                }
            } catch (_) { }
        }
    } catch (e) { }

    // ── Method 3: React Fiber traversal on chat list ─────────────────────
    try {
        const chatList = document.querySelector('#pane-side') ||
            document.querySelector('[data-testid="chat-list"]');
        if (chatList) {
            // Find React fiber key
            const fiberKey = Object.keys(chatList).find(k =>
                k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (fiberKey) {
                // Walk fiber tree to find chat model data
                const results = [];
                let fiber = chatList[fiberKey];
                const seen = new Set();
                let depth = 0;
                function walk(f) {
                    if (!f || depth > 200 || seen.has(f)) return;
                    seen.add(f);
                    depth++;
                    // Look for memoizedProps containing chat-like data
                    const props = f.memoizedProps;
                    if (props) {
                        const chat = props.chat || props.model;
                        if (chat && chat.id && chat.id._serialized &&
                            !seen.has(chat.id._serialized)) {
                            seen.add(chat.id._serialized);
                            results.push({
                                id: chat.id._serialized,
                                name: resolveChatName(chat, chat.formattedTitle || chat.name || ''),
                                formattedTitle: chat.formattedTitle || '',
                                isGroup: !!chat.isGroup,
                                isPinned: !!(chat.pin || chat.isPinned),
                                unreadCount: chat.unreadCount || 0,
                                t: chat.t || 0,
                                lastMessage: extractLastMessage(chat),
                            });
                        }
                    }
                    if (results.length >= 50) return; // cap
                    walk(f.child);
                    walk(f.sibling);
                }
                walk(fiber);
                if (results.length > 0) return results;
            }
        }
    } catch (e) { }

    // ── Method 4: DOM scrape (ID-less fallback: name + subtitle) ─────────
    try {
        const rows = extractChatListRows(document);
        const results = rows.map(r => ({
            id: 'dom_' + r.name.replace(/\s+/g, '_'),
            name: r.name, formattedTitle: r.name,
            isGroup: false, unreadCount: 0, t: 0,
            lastMessage: r.body ? {
                body: r.body, type: 'chat', t: 0,
                fromMe: false, isRevoked: false, senderName: '',
            } : null,
        }));
        if (results.length > 0) return results;
    } catch (e) { }

    return [];
}

// ── getAllChats ──────────────────────────────────────────────────────────────
app.post('/api/getAllChats', async (req, res) => {
    try {
        const page = await getValidPage();
        if (!isReady || !page) return res.status(503).json({ error: 'Not ready' });

        // Lost-auth guard: if the page shows the login/QR screen the session is
        // dead even though we believed we were ready. Drop back to the QR flow
        // and tell the widget (which triggers its auto-logout recovery).
        if (await pageIsLoggedOut(page)) {
            console.log('[AUTH] Login screen detected while marked ready — session lost.');
            isReady = false;
            currentOpenChatId = null;
            msgCache.clear();
            try { fs.unlinkSync(QR_PATH); } catch (_) { }
            waitForAppOrQR();
            return res.status(401).json({ error: 'Logged out', code: 'AUTH_LOST' });
        }
        // NOTE: this puppeteer-core build does not serialize function
        // arguments into page.evaluate (they arrive undefined and every
        // extraction method dies silently). Inject the self-contained page
        // helpers via toString instead — same pattern as lib/avatars.js.
        const chats = await page.evaluate(new Function(
            'return (' + getAllChatsInPage.toString() + ')(' +
                chatPreviewLib.extractLastMessage.toString() + ',' +
                chatPreviewLib.extractChatListRows.toString() + ');'));
        for (const c of chats) {
            if (!c.isGroup && chatPreviewLib.isGroupChat(c)) c.isGroup = true;
        }
        const withPreview = chats.filter(c => c.lastMessage && c.lastMessage.body).length;
        console.log(`getAllChats: returned ${chats.length} chats (${withPreview} with preview)`);
        res.json({ response: chats });
    } catch (e) {
        console.error('getAllChats error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── getPinnedChats ───────────────────────────────────────────────────────────
app.all('/api/getPinnedChats', (_req, res) => {
    try {
        const pinned = pinsLib.getPinned();
        res.json({ response: pinned });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── togglePinChat ───────────────────────────────────────────────────────────
app.post('/api/togglePinChat', (req, res) => {
    const body = req.body || {};
    const args = body.args || body;
    const chatId = args.chatId || args.id;
    if (!chatId) return res.status(400).json({ error: 'Missing chatId' });
    try {
        const updated = pinsLib.togglePin(chatId);
        res.json({ response: updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Helper to open a chat via DOM search ───────────────────────────────────
async function forceOpenChat(waPage, chatId) {
    if (currentOpenChatId === chatId) {
        // Chat is already open! Avoid redundant GUI clicks to make operations instant.
        return;
    }

    // Try programmatic open first
    try {
        const opened = await waPage.evaluate(async (cid) => {
            let chatMod = null;
            const names = ['WAWebChatCollection', 'WAWebStore', 'Store'];
            for (const name of names) {
                try {
                    const m = window.require(name);
                    const coll = m.ChatCollection || m.ChatCollectionImpl || (m.default && m.default.Chat);
                    if (coll && typeof coll.get === 'function') {
                        chatMod = coll; break;
                    }
                } catch (e) { }
            }
            
            let Cmd = null;
            try {
                Cmd = window.require("WAWebCmd").Cmd;
            } catch (e) { }

            if (chatMod && Cmd) {
                const chat = chatMod.get(cid) || (typeof chatMod.find === 'function' ? await chatMod.find(cid) : null);
                if (chat) {
                    await Cmd.openChatAt({ chat: chat });
                    return true;
                }
            }
            return false;
        }, chatId);

        if (opened) {
            currentOpenChatId = chatId;
            console.log(`forceOpenChat: opened chat ${chatId} programmatically`);
            return;
        }
    } catch (e) {
        console.log('forceOpenChat programmatic open failed, falling back to GUI search:', e.message);
    }

    try {
        const chatName = await waPage.evaluate((cid) => {
            let chatMod = null;
            const names = ['WAWebChatCollection', 'WAWebStore', 'Store'];
            for (const name of names) {
                try {
                    const m = window.require(name);
                    const coll = m.ChatCollection || m.ChatCollectionImpl || (m.default && m.default.Chat);
                    if (coll && typeof coll.get === 'function') {
                        chatMod = coll; break;
                    }
                } catch (e) { }
            }
            if (chatMod) {
                const chat = chatMod.get(cid);
                if (chat) return chat.name || chat.formattedTitle;
            }
            return null;
        }, chatId);

        // Fall back to phone number/user ID if the display name is empty or not found
        const searchTerm = chatName || chatId.split('@')[0];

        if (searchTerm) {
            console.log(`forceOpenChat: searching for "${searchTerm}" to open chat ${chatId}`);
            const searchInputSelector = '#side input[type="text"], [data-testid="chat-list-search"] input, [data-testid="chat-list-search-container"] input';
            
            // Wait for search box to be visible
            await waPage.waitForSelector(searchInputSelector, { visible: true, timeout: 5000 });
            
            // Click input (retry if detached)
            for (let attempt = 1; attempt <= 4; attempt++) {
                try {
                    await waPage.focus(searchInputSelector);
                    await waPage.click(searchInputSelector);
                    break;
                } catch (err) {
                    if (attempt === 4) throw err;
                    await new Promise(r => setTimeout(r, 200));
                }
            }
            await new Promise(r => setTimeout(r, 150));
            
            // clear input
            await waPage.keyboard.down('Control');
            await waPage.keyboard.press('a');
            await waPage.keyboard.up('Control');
            await waPage.keyboard.press('Backspace');
            
            // Type search term (name or phone number)
            await waPage.type(searchInputSelector, searchTerm, { delay: 10 });
            await new Promise(r => setTimeout(r, 1000)); // wait for result list to update
            
            // Click result (retry if detached)
            const firstResultSelector = '#pane-side [data-testid="cell-frame-container"], #pane-side div[role="listitem"]';
            await waPage.waitForSelector(firstResultSelector, { visible: true, timeout: 5000 });
            await waPage.evaluate((selector) => {
                const el = document.querySelector(selector);
                if (el) {
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }
            }, firstResultSelector);
            await new Promise(r => setTimeout(r, 1000));
            
            // Clear search box to restore sidebar state
            const clearSearchSelector = '[aria-label="Cancel search"], button[data-testid="clear-search-btn-active"]';
            const clearBtn = await waPage.$(clearSearchSelector);
            if (clearBtn) {
                await clearBtn.click();
            } else {
                await waPage.keyboard.press('Escape');
            }
            await new Promise(r => setTimeout(r, 300));
            
            // Successfully opened! Save state.
            currentOpenChatId = chatId;
        }
    } catch (e) {
        currentOpenChatId = null; // reset state on failure
        console.error('forceOpenChat error:', e.message);
    }
}


// ── getChatMessages ──────────────────────────────────────────────────────────
app.post('/api/getChatMessages', async (req, res) => {
    const body = req.body;
    const args = body.args || body;
    const chatId = args.chatId || args.to;

    if (!chatId) return res.status(400).json({ error: 'Missing chatId' });

    try {
        const page = await getValidPage();
        if (!isReady || !page) return res.status(503).json({ error: 'Not ready' });

        const isAlreadyOpen = (currentOpenChatId === chatId);
        await forceOpenChat(page, chatId);

        const messages = await page.evaluate(async (cid, alreadyOpen) => {

            // ── Step 1: Find Chat collection and select the chat ───────────────
            let chatMod = null;
            try {
                if (typeof window.require !== 'undefined') {
                    const chatNames = ['WAWebChatCollection', 'WAWebStore', 'Store'];
                    for (const name of chatNames) {
                        try {
                            const m = window.require(name);
                            const coll = m.ChatCollection || m.ChatCollectionImpl || (m.default && m.default.Chat);
                            if (coll && typeof coll.get === 'function') {
                                chatMod = coll;
                                break;
                            }
                        } catch (e) { }
                    }
                }
            } catch (e) { }

            let chat = null;
            if (chatMod) {
                chat = chatMod.get(cid);
            }

            // ── Contact collection for sender resolution ─────────────────────
            // Current WA builds leave msg.sender null; the sender's LID sits
            // in msg.author and resolves to a display name through here.
            let contactColl = null;
            try {
                if (typeof window.require !== 'undefined') {
                    const contactMod = window.require('WAWebContactCollection');
                    const cc = contactMod.ContactCollection || contactMod.ContactCollectionImpl;
                    if (cc && typeof cc.get === 'function') contactColl = cc;
                }
            } catch (e) { }

            // One sender-name rule for every extraction site below: legacy
            // sender model first, then author-LID contact lookup, then the
            // phone-number fallback. Never throws (the page must not die).
            function resolveSenderName(sender, author) {
                try {
                    if (sender && typeof sender === 'object') {
                        const direct = sender.formattedTitle || sender.pushname || sender.formattedName ||
                            sender.name || sender.shortName || sender.notifyName ||
                            ((sender.id && sender.id.user) || '');
                        if (direct) return direct;
                    }
                    let authorId = '';
                    if (typeof author === 'string') authorId = author;
                    else if (author && typeof author === 'object') {
                        authorId = author._serialized || author.user || '';
                    }
                    authorId = String(authorId || '');
                    if (authorId && contactColl) {
                        try {
                            const contact = contactColl.get(authorId);
                            if (contact) {
                                const named = contact.pushname || contact.verifiedName ||
                                    contact.formattedName || contact.name || contact.shortName || '';
                                if (named) return named;
                            }
                        } catch (e) { }
                    }
                    if (authorId) {
                        const at = authorId.indexOf('@');
                        const domain = at !== -1 ? authorId.substring(at + 1) : '';
                        if (domain === 'c.us' || domain === 's.whatsapp.net') {
                            return authorId.substring(0, at);
                        }
                    }
                } catch (e) { }
                return '';
            }

            // Select the chat to make sure messages are loaded
            let selectedViaDOM = false;
            if (!alreadyOpen) {
                try {
                    const chatList = document.querySelector('#pane-side') || document.querySelector('[data-testid="chat-list"]');
                    if (chatList) {
                        let chatRow = null;
                        const fiberKey = Object.keys(chatList).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
                        if (fiberKey) {
                            let fiber = chatList[fiberKey];
                            const seen = new Set();
                            let depth = 0;
                            function walk(f) {
                                if (!f || chatRow || depth > 200 || seen.has(f)) return;
                                seen.add(f); depth++;
                                if (f.memoizedProps && (f.memoizedProps.chat || f.memoizedProps.model)) {
                                    const c = f.memoizedProps.chat || f.memoizedProps.model;
                                    if (c.id && c.id._serialized === cid) {
                                        chatRow = f.stateNode;
                                    }
                                }
                                walk(f.child); walk(f.sibling);
                            }
                            walk(fiber);
                        }
                        if (chatRow && typeof chatRow.click === 'function') {
                            chatRow.click();
                            selectedViaDOM = true;
                            await new Promise(r => setTimeout(r, 1200)); // wait for pane to load
                        }
                    }
                } catch (e) { }

                if (!selectedViaDOM && chat) {
                    try {
                        if (typeof chat.onSelected === 'function') {
                            await chat.onSelected();
                        } else if (typeof chat.select === 'function') {
                            await chat.select();
                        }
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (e) { }
                }
            }

            // ── Step 2: Wait briefly for chat rendering ────────────────────────
            if (!alreadyOpen) {
                // Wait a brief moment for the chat to load and render in DOM/memory
                await new Promise(r => setTimeout(r, 200));
            }

            // ── Step 3: Collect messages from all available sources ────────────
            let msgs = [];

            // Method A: chat.msgs Backbone collection (most comprehensive)
            if (chat && chat.msgs && typeof chat.msgs.getModelsArray === 'function') {
                try {
                    msgs = chat.msgs.getModelsArray().map(m => {
                        const senderName = resolveSenderName(m.sender, m.author || m.participant);
                        // Collect reactions if present.
                                // WA's reaction model exposes the emoji under `orphan`
                                // (aggregation key) or `emoji`; `sent_by_me` and the
                                // MaybeMeUser comparison give a reliable `fromMe`.
                                let reactions = [];
                                try {
                                    if (m.reactions && m.reactions.length > 0) {
                                        const me = window.Store && window.Store.MaybeMeUser ? String(window.Store.MaybeMeUser) : '';
                                        reactions = m.reactions.map(r => {
                                            const emoji = r.orphan || r.emoji || r.reactionText || '';
                                            let fromMe = !!r.sent_by_me;
                                            try {
                                                const sid = r.sender && r.sender.id && r.sender.id._serialized;
                                                if (me && sid) fromMe = fromMe || String(sid) === me;
                                            } catch (_) { }
                                            return {
                                                emoji: emoji,
                                                sender: resolveSenderName(r.sender, null),
                                                fromMe: fromMe,
                                            };
                                        }).filter(r => r.emoji);
                            }
                        } catch (_) { }
                        // Extract quoted (replied-to) message if present
                        let quotedMsg = null;
                        try {
                            const qm = m.quotedMsg || (m.quotedStanzaInfo && m.quotedStanzaInfo.quotedMsg);
                            if (qm) {
                                let qSender = resolveSenderName(qm.sender, qm.author);
                                if (!qSender && m.quotedParticipant) qSender = m.quotedParticipant.user || String(m.quotedParticipant) || '';
                                quotedMsg = {
                                    body: qm.body || qm.content || qm.caption || '',
                                    type: qm.type || 'chat',
                                    senderName: qSender,
                                };
                            }
                        } catch (_) { }
                        return {
                            id: m.id && m.id._serialized || String(m.id || Math.random()),
                            body: m.body || m.content || '',
                            caption: m.caption || '',
                            waveform: Array.isArray(m.waveform) ? Array.from(m.waveform).slice(0, 128) : [],
                            duration: Number(m.duration) > 0 ? Math.floor(Number(m.duration)) : 0,
                            type: m.type || 'chat',
                            t: m.t || 0,
                            fromMe: !!(m.id && m.id.fromMe),
                            senderName: senderName,
                            reactions: reactions,
                            quotedMsg: quotedMsg,
                        };
                    });
                } catch (e) {
                    console.log('Method A failed:', e.message);
                }
            }

            // Method B: React Fiber on the main message panel (when Backbone not available)
            if (msgs.length <= 1) {
                try {
                    const mainPane = document.querySelector('#main');
                    if (mainPane) {
                        const fiberKey = Object.keys(mainPane).find(k =>
                            k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
                        if (fiberKey) {
                            const results = [];
                            let fiber = mainPane[fiberKey];
                            const seen = new Set();
                            let depth = 0;
                            function walk(f) {
                                if (!f || depth > 500 || seen.has(f)) return;
                                seen.add(f); depth++;
                                const props = f.memoizedProps;
                                if (props) {
                                        const msg = props.message || props.msg;
                                        if (msg && msg.id && msg.id._serialized && !seen.has(msg.id._serialized)) {
                                            seen.add(msg.id._serialized);
                                            const senderName = resolveSenderName(msg.sender, msg.author || msg.participant);
                                        // Collect reactions (same rules as Method A).
                                        let reactions = [];
                                        try {
                                            if (msg.reactions && msg.reactions.length > 0) {
                                                const me = window.Store && window.Store.MaybeMeUser ? String(window.Store.MaybeMeUser) : '';
                                                reactions = msg.reactions.map(r => {
                                                    const emoji = r.orphan || r.emoji || r.reactionText || '';
                                                    let fromMe = !!r.sent_by_me;
                                                    try {
                                                        const sid = r.sender && r.sender.id && r.sender.id._serialized;
                                                        if (me && sid) fromMe = fromMe || String(sid) === me;
                                                    } catch (_) { }
                                                    return {
                                                        emoji: emoji,
                                                        sender: resolveSenderName(r.sender, null),
                                                        fromMe: fromMe,
                                                    };
                                                }).filter(r => r.emoji);
                                            }
                                        } catch (_) { }
                                        // Extract quoted message if present
                                        let quotedMsg = null;
                                        try {
                                            const qm = msg.quotedMsg || (msg.quotedStanzaInfo && msg.quotedStanzaInfo.quotedMsg);
                                            if (qm) {
                                                let qSender = resolveSenderName(qm.sender, qm.author);
                                                if (!qSender && msg.quotedParticipant) qSender = msg.quotedParticipant.user || String(msg.quotedParticipant) || '';
                                                quotedMsg = {
                                                    body: qm.body || qm.content || qm.caption || '',
                                                    type: qm.type || 'chat',
                                                    senderName: qSender,
                                                };
                                            }
                                        } catch (_) { }
                                        results.push({
                                            id: msg.id._serialized,
                                            body: msg.body || msg.content || '',
                                            caption: msg.caption || '',
                                            waveform: Array.isArray(msg.waveform) ? Array.from(msg.waveform).slice(0, 128) : [],
                                            duration: Number(msg.duration) > 0 ? Math.floor(Number(msg.duration)) : 0,
                                            type: msg.type || 'chat',
                                            t: msg.t || 0,
                                            fromMe: !!(msg.id && msg.id.fromMe),
                                            senderName: senderName,
                                            reactions: reactions,
                                            quotedMsg: quotedMsg,
                                        });
                                    }
                                }
                                walk(f.child); walk(f.sibling);
                            }
                            walk(fiber);
                            if (results.length > msgs.length) {
                                results.sort((a, b) => a.t - b.t);
                                msgs = results;
                            }
                        }
                    }
                } catch (e) {
                    console.log('Method B failed:', e.message);
                }
            }

            // Method C: DOM scraping of main pane (final fallback)
            if (msgs.length <= 1) {
                try {
                    const messageEls = document.querySelectorAll('#main [data-pre-plain-text], #main .message-in, #main .message-out');
                    if (messageEls.length > 0) {
                        const results = [];
                        messageEls.forEach((el, index) => {
                            const preText = el.getAttribute('data-pre-plain-text') || '';
                            const textEl = el.querySelector('.copyable-text span') || el.querySelector('span');
                            const text = textEl ? textEl.textContent : '';
                            const isOut = el.classList.contains('message-out') || el.closest('.message-out') !== null;
                            if (text) {
                                results.push({
                                    id: 'dom_msg_' + index,
                                    body: text,
                                    type: 'chat',
                                    t: Math.floor(Date.now() / 1000) - (messageEls.length - index) * 60,
                                    fromMe: isOut,
                                    senderName: preText ? preText.split(']').pop().replace(':', '').trim() : (isOut ? 'Me' : ''),
                                    reactions: [],
                                    quotedMsg: null,
                                });
                            }
                        });
                        if (results.length > msgs.length) {
                            msgs = results;
                        }
                    }
                } catch (e) {
                    console.log('Method C failed:', e.message);
                }
            }

            console.log(`getChatMessages: ${msgs.length} messages collected for ${cid}`);
            return msgs;
        }, chatId, isAlreadyOpen);

        // Serve from cache when the previous scrape is younger than the TTL.
        const since = messagesLib.parseSince(args.since);
        const wantsBefore = args.beforeId != null && args.beforeId !== '';
        const limitGiven = Number(args.limit) > 0;
        const pageArgs = (wantsBefore || limitGiven)
            ? { limit: args.limit, beforeId: wantsBefore ? args.beforeId : undefined, beforeT: args.beforeT }
            : null;
        const cached = msgCache.get(chatId);
        if (cached && (Date.now() - cached.t) < MSG_CACHE_TTL_MS) {
            if (pageArgs && !since) {
                const p = messagesLib.paginateMessages(cached.messages, pageArgs);
                return res.json({ response: p.page, sig: cached.sig, hasMore: p.hasMore });
            }
            const out = since ? messagesLib.filterMessagesSince(cached.messages, since) : cached.messages;
            return res.json({ response: out, sig: cached.sig });
        }

        console.log(`getChatMessages: returned ${messages.length} messages for chat ${chatId}`);

        // Cap payload size and compute a cheap change signature.
        if (messages.length > MSG_CACHE_MAX) messages = messages.slice(-MSG_CACHE_MAX);
        const lastMsg = messages.length ? messages[messages.length - 1] : {};
        const sig = messages.length + ':' + (lastMsg.id || '') + ':' + (lastMsg.t || 0);
        msgCache.set(chatId, { t: Date.now(), sig: sig, messages: messages });
        if (pageArgs && !since) {
            const p = messagesLib.paginateMessages(messages, pageArgs);
            return res.json({ response: p.page, sig: sig, hasMore: p.hasMore });
        }
        const out = since ? messagesLib.filterMessagesSince(messages, since) : messages;
        res.json({ response: out, sig: sig });
    } catch (e) {
        console.error('getChatMessages error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── waitMessages (long-poll) ────────────────────────────────────────────────
// Resolves as soon as the chat's message signature changes (new message,
// reaction, etc.) or after a timeout, so the widget gets near-instant
// updates instead of blind 5s polling.
app.post('/api/waitMessages', async (req, res) => {
    const args = req.body.args || req.body;
    const chatId = args.chatId || args.to;
    const knownSig = args.sig == null ? '' : String(args.sig);

    if (!chatId) return res.status(400).json({ error: 'Missing chatId' });

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });

        const out = await waitForSigChange({
            getSig: async function () {
                const cached = msgCache.get(chatId);
                if (cached && (Date.now() - cached.t) < MSG_CACHE_TTL_MS) return cached.sig;
                // Cheap probe: signature only, no full message extraction.
                return await waPage.evaluate((cid) => {
                    try {
                        if (typeof window.require === 'undefined') return '';
                        const names = ['WAWebChatCollection', 'WAWebStore', 'Store'];
                        let coll = null;
                        for (const n of names) {
                            try {
                                const m = window.require(n);
                                const c = m.ChatCollection || m.ChatCollectionImpl || (m.default && m.default.Chat);
                                if (c && typeof c.get === 'function') { coll = c; break; }
                            } catch (e) { }
                        }
                        if (!coll) return '';
                        const chat = coll.get(cid);
                        if (!chat || !chat.msgs) return '';
                        const arr = typeof chat.msgs.getModelsArray === 'function' ? chat.msgs.getModelsArray() : [];
                        const last = arr.length ? arr[arr.length - 1] : {};
                        const lid = last.id && last.id._serialized || last.id || '';
                        return arr.length + ':' + lid + ':' + (last.t || 0);
                    } catch (e) { return ''; }
                }, chatId);
            },
            knownSig: knownSig,
            intervalMs: 1000,
            timeoutMs: 20000
        });
        res.json(out);
    } catch (e) {
        console.error('waitMessages error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── getAvatars (profile pictures) ───────────────────────────────────────────
// Scrapes the small avatars WhatsApp already renders in the chat list, matches
// them to chats by display name, and only ships bytes whose hash changed.
app.post('/api/getAvatars', async (req, res) => {
    const args = req.body.args || req.body;
    const chats = Array.isArray(args.chats) ? args.chats : [];
    const prevHashes = args.hashes || {};

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });

        // extractAvatars(doc) is injectable for tests; run it against the
        // live page's document here.
        const extractSrc = avatarsLib.extractAvatars.toString();
        const domEntries = await waPage.evaluate(new Function('return (' + extractSrc + ')(document);'));

        // Resolve CDN/blob URLs to bytes inside the page (session cookies
        // apply there). Bounded per call to keep latency acceptable; remaining
        // entries are picked up on the next poll cycle.
        const FETCH_LIMIT = 40;
        let fetched = 0;
        const domAvatars = [];
        for (let i = 0; i < domEntries.length; i++) {
            const e = domEntries[i];
            if (e.kind === 'data') {
                domAvatars.push({ name: e.name, base64: e.base64 });
            } else if ((e.kind === 'https' || e.kind === 'blob') && fetched < FETCH_LIMIT) {
                const fetchSrc = avatarsLib.fetchImageAsBase64.toString();
                const b64 = await waPage.evaluate(new Function('return (' + fetchSrc + ')(' + JSON.stringify(e.src) + ');'));
                if (b64) {
                    domAvatars.push({ name: e.name, base64: b64 });
                    fetched++;
                }
            }
        }

        const matched = avatarsLib.matchAvatarsToChats(chats, domAvatars);
        const out = chats.map(function (c) {
            const p = avatarsLib.avatarPayload(c.id, matched.get(c.id), prevHashes);
            if (p.data) avatarStore.set(p.hash, p.data);
            return { id: p.id, hash: p.hash, changed: p.changed, data: p.data };
        });
        console.log(`getAvatars: ${out.filter(a => a.changed).length} changed of ${out.length}`);
        res.json({ response: out });
    } catch (e) {
        console.error('getAvatars error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── avatar bytes (GET, key via query so it works as an <img> source) ────────
app.get('/api/avatar/:hash', (req, res) => {
    const data = avatarStore.get(req.params.hash);
    if (!data) return res.status(404).json({ error: 'Unknown avatar' });
    const buf = Buffer.from(data, 'base64');
    const isPng = data.slice(0, 8) === 'iVBORw0K';
    res.set('Content-Type', isPng ? 'image/png' : 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400, immutable');
    res.send(buf);
});

// ── getMedia (on-demand image bytes, downscaled in-page) ───────────────────
// POST /api/getMedia { chatId, msgId, maxEdge } →
//   { response: { dataUrl, width, height } }.
// maxEdge=480 caps the longest edge at 480px; maxEdge=0 is full resolution.
// Served from a ~30MB server-side LRU (key chatId|msgId|maxEdge).
// Errors: 400 missing params, 404 msg not loaded, 502 download failed,
// 503 backend not ready. In-page fn is toString-injected (this
// puppeteer-core build does not forward page.evaluate args), so it must
// stay fully self-contained — see lib/media.js getMediaInPage.
// ── Shared media fetch (used by /api/getMedia + /api/openExternally) ───────
// Returns { dataUrl, width, height } (full-res when maxEdge=0), using the
// server-side LRU to avoid re-downloads. Throws an Error with .status set
// (503 not ready, 404 msg not loaded, 502 download failed) so routes can
// map it directly to HTTP. Cache behaviour matches the original getMedia.
async function getMediaDataUrl(chatId, msgId, maxEdge) {
    const page = await getValidPage();
    if (!isReady || !page) {
        const e = new Error('Not ready');
        e.status = 503;
        throw e;
    }

    const key = mediaLib.cacheKey(chatId, msgId, maxEdge);
    const hit = mediaLib.mediaCache.get(key);
    if (hit && hit.dataUrl) {
        return { dataUrl: hit.dataUrl, width: hit.width, height: hit.height };
    }

    // Inject args as a JSON literal — page.evaluate args arrive
    // undefined in this build, so the in-page fn takes none.
    const payload = JSON.stringify({ chatId: chatId, msgId: msgId, maxEdge: maxEdge });
    const src = '(' + mediaLib.getMediaInPage.toString() + ')(' + payload + ');';
    let result;
    try {
        result = await Promise.race([
            page.evaluate(new Function('return ' + src)),
            new Promise(function (_, reject) {
                setTimeout(function () { reject(new Error('getMedia timed out')); }, 30000);
            }),
        ]);
    } catch (e) {
        const err = new Error('Media download failed');
        err.status = 502;
        err.detail = String((e && e.message) || e);
        throw err;
    }

    if (!result || result.error) {
        const detail = result && result.error ? String(result.error) : 'empty result';
        const err = new Error(detail.indexOf('NOT_FOUND') === 0
            ? 'Message not loaded: ' + detail
            : 'Media download failed: ' + detail);
        err.status = detail.indexOf('NOT_FOUND') === 0 ? 404 : 502;
        err.detail = detail;
        throw err;
    }
    if (!result.dataUrl) {
        const err = new Error('Media download failed: empty result');
        err.status = 502;
        err.detail = 'empty result';
        throw err;
    }

    mediaLib.mediaCache.put(key, {
        dataUrl: result.dataUrl,
        width: result.width,
        height: result.height,
    });
    return { dataUrl: result.dataUrl, width: result.width, height: result.height };
}

function mediaHttpStatus(e) {
    const s = e && e.status;
    if (s === 503 || s === 404 || s === 502 || s === 400) return s;
    if (e && /timed out/.test(String(e.message || ''))) return 502;
    return 500;
}

app.post('/api/getMedia', async (req, res) => {
    const parsed = mediaLib.parseMediaArgs(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    try {
        const out = await getMediaDataUrl(parsed.chatId, parsed.msgId, parsed.maxEdge);
        res.json({ response: { dataUrl: out.dataUrl, width: out.width, height: out.height } });
    } catch (e) {
        const msg = String((e && e.message) || e);
        const status = mediaHttpStatus(e);
        if (status !== 500) return res.status(status).json({ error: msg });
        console.error('getMedia error:', msg);
        res.status(500).json({ error: msg });
    }
});

// ── openExternally: full-res media → temp file → system viewer via xdg-open ─
// POST /api/openExternally { chatId, msgId } → { response: { path } }.
// Full-res (maxEdge 0) via the shared helper (LRU hit avoids re-download).
// Errors: 400 missing params; 404/502/503 passthrough from media fetch;
// 500 with detail when temp-file write or xdg-open spawn fails.
app.post('/api/openExternally', async (req, res) => {
    const parsed = mediaLib.parseOpenArgs(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    let data;
    try {
        data = await getMediaDataUrl(parsed.chatId, parsed.msgId, 0);
    } catch (e) {
        const msg = String((e && e.message) || e);
        const status = mediaHttpStatus(e);
        if (status !== 500) return res.status(status).json({ error: msg });
        console.error('openExternally error:', msg);
        return res.status(500).json({ error: msg });
    }

    const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/.exec(String(data.dataUrl || ''));
    if (!m) {
        return res.status(500).json({ error: 'Unexpected media encoding', detail: 'expected dataUrl' });
    }
    const extFor = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4' };
    const ext = extFor[String(m[1]).toLowerCase().split(';')[0]] || 'bin';
    let buf;
    try {
        buf = Buffer.from(m[2], 'base64');
    } catch (e) {
        return res.status(500).json({ error: 'Could not decode media', detail: String((e && e.message) || e) });
    }
    const safe = mediaLib.sanitizeMsgId(parsed.msgId);
    const file = path.join(os.tmpdir(), 'whatsapp-kde-media-' + safe + '.' + ext);
    try {
        fs.writeFileSync(file, buf);
    } catch (e) {
        return res.status(500).json({ error: 'Could not write temp file', detail: String((e && e.message) || e) });
    }
    try {
        const { spawn } = require('child_process');
        const child = spawn('xdg-open', [file], { detached: true, stdio: 'ignore' });
        child.on('error', (err) => console.error('openExternally spawn error:', err.message));
        child.unref();
    } catch (e) {
        return res.status(500).json({ error: 'Could not open system viewer', detail: String((e && e.message) || e) });
    }
    res.json({ response: { path: file } });
});

// ── QR code bytes (GET, key via query so QML Image can pass ?key=) ──────────
app.get('/api/qr', (req, res) => {
    try {
        if (!fs.existsSync(QR_PATH)) return res.status(404).json({ error: 'No QR available' });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.set('Pragma', 'no-cache');
        return res.sendFile(QR_PATH);
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ── debug: inspect chat-list DOM for avatar scraping ────────────────────────
app.post('/api/debugChatListDom', async (_req, res) => {
    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });
        const info = await waPage.evaluate(() => {
            const out = { rows: 0, imgs: 0, srcKinds: {}, titles: [], samples: [] };
            const rows = document.querySelectorAll('[data-testid="cell-frame-container"]');
            out.rows = rows.length;
            const paneImgs = document.querySelectorAll('#pane-side img');
            out.paneImgs = paneImgs.length;
            const seen = {};
            rows.forEach(function (row, i) {
                const t = row.querySelector('[data-testid="cell-frame-title"] span') || row.querySelector('span[title]');
                const title = t ? (t.title || t.textContent || '') : '';
                const img = row.querySelector('img');
                const src = img ? (img.getAttribute('src') || '') : null;
                const kind = src == null ? 'none' : (src.indexOf('data:') === 0 ? 'data' : (src.indexOf('blob:') === 0 ? 'blob' : (src === '' ? 'empty' : 'other')));
                seen[kind] = (seen[kind] || 0) + 1;
                if (i < 5 && out.titles.length < 5) {
                    out.titles.push(title);
                    out.samples.push({ title: title, srcKind: kind, srcPrefix: src ? String(src).slice(0, 40) : src });
                }
            });
            out.srcKinds = seen;
            return out;
        });
        // Run the serialized extractor outside the closure above (Node side).
        const extractSrc = avatarsLib.extractAvatars.toString();
        let extracted = null;
        try {
            extracted = await waPage.evaluate(new Function('return (' + extractSrc + ')(document);'));
        } catch (e) {
            extracted = { error: e.message };
        }
        info.extractCount = Array.isArray(extracted) ? extracted.length : -3;
        info.extractError = Array.isArray(extracted) ? null : (extracted && extracted.error || String(extracted));
        info.extractSample = Array.isArray(extracted) ? extracted.slice(0, 3).map(function (e2) {
            return { name: e2.name, kind: e2.kind, srcPrefix: e2.src ? String(e2.src).slice(0, 40) : undefined, b64Len: e2.base64 ? e2.base64.length : undefined };
        }) : [];
        res.json({ response: info });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── sendReaction ──────────────────────────────────────────────────────────────
app.post('/api/sendReaction', async (req, res) => {
    const body = req.body;
    const args = body.args || body;
    const chatId = args.chatId || args.to;
    const msgId = args.msgId;       // e.g. true_XXXXXXXXXX@c.us_XXXXXX
    const reaction = args.reaction;     // emoji string, e.g. "❤️"
    const remove = args.remove || false; // true to remove reaction

    if (!chatId || !msgId || !reaction) {
        return res.status(400).json({ error: 'Missing chatId, msgId, or reaction' });
    }

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });
        const result = await waPage.evaluate(async (cid, mid, emoji, isRemove) => {
            // ── Method 1: Use WhatsApp Web internal sendReaction ──────────────
            try {
                // Try finding the sendReaction module via webpack
                let reactionMod = null;
                if (typeof window.webpackChunkwhatsapp_web_client !== 'undefined') {
                    window.webpackChunkwhatsapp_web_client.push([['_react'], {}, function (e) {
                        for (let k in e.m) {
                            try {
                                const m = e(k);
                                if (m && m.default && m.default.toString &&
                                    m.default.toString().includes('sendReaction')) {
                                    reactionMod = m.default;
                                    break;
                                }
                                // Check named exports
                                if (m && m.sendReaction) {
                                    reactionMod = m.sendReaction;
                                    break;
                                }
                            } catch (_) { }
                        }
                    }]);
                }

                // Find the Message collection to get the message object
                let msgMod = null;
                try {
                    if (typeof window.require !== 'undefined') {
                        const names = ['WAWebMessageCollection', 'WAWebStore', 'Store'];
                        for (const name of names) {
                            try {
                                const m = window.require(name);
                                const coll = m.MessageCollection || m.MsgCollection || (m.default && (m.default.Message || m.default.Msg));
                                if (coll && typeof coll.get === 'function') {
                                    msgMod = coll;
                                    break;
                                }
                            } catch (e) { }
                        }
                    }
                } catch (e) { }

                let msg = null;
                if (msgMod) msg = msgMod.get(mid);

                // Also try accessing via the Chat's messages
                if (!msg) {
                    let chatMod = null;
                    try {
                        if (typeof window.require !== 'undefined') {
                            const names = ['WAWebChatCollection', 'WAWebStore', 'Store'];
                            for (const name of names) {
                                try {
                                    const m = window.require(name);
                                    const coll = m.ChatCollection || m.ChatCollectionImpl || (m.default && m.default.Chat);
                                    if (coll && typeof coll.get === 'function') {
                                        chatMod = coll;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                    } catch (e) { }
                    if (chatMod) {
                        const chat = chatMod.get(cid);
                        if (chat && chat.msgs) {
                            msg = chat.msgs.get(mid);
                        }
                    }
                }

                if (msg) {
                    if (typeof msg.sendReaction === 'function') {
                        await msg.sendReaction(emoji, isRemove);
                        return 'reacted';
                    }
                    // Try the reaction module
                    if (reactionMod && typeof reactionMod === 'function') {
                        await reactionMod(msg, emoji, isRemove);
                        return 'reacted';
                    }
                }
            } catch (e) {
                console.log('sendReaction Method 1 failed:', e.message);
            }

            // ── Method 2: DOM interaction ─────────────────────────────────────
            // Find the message element in the DOM and click the reaction button
            try {
                // Find the message element by its data-id attribute (WhatsApp sets data-id on message divs)
                const msgSelector = `div[data-id="${mid}"]`;
                let msgEl = document.querySelector(msgSelector);

                if (!msgEl) {
                    // Try finding by id prefix match
                    const allMessages = document.querySelectorAll('#main [data-pre-plain-text]');
                    for (const el of allMessages) {
                        const dataId = el.getAttribute('data-id') || '';
                        if (dataId.includes(mid) || mid.includes(dataId)) {
                            msgEl = el;
                            break;
                        }
                    }
                }

                if (msgEl) {
                    // Hover over the message to reveal the reaction button
                    msgEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 300));

                    // Click the reaction button (a smiley/emoji icon that appears on hover)
                    const reactionBtn = msgEl.querySelector('[data-icon="smiley"]') ||
                        msgEl.querySelector('[aria-label="React"]') ||
                        msgEl.querySelector('[data-testid="react"]') ||
                        msgEl.querySelector('span[data-icon="smiley"]');

                    if (reactionBtn) {
                        reactionBtn.click();
                        await new Promise(r => setTimeout(r, 200));

                        // Now the emoji picker is open. Type the emoji character and press enter
                        // Or find the emoji in the picker grid
                        const emojiSpan = document.querySelector(`[data-emoji="${emoji}"]`) ||
                            document.querySelector(`[aria-label*="${emoji}"]`);
                        if (emojiSpan) {
                            emojiSpan.click();
                        } else {
                            // Fallback: Type the emoji into the search box
                            const searchInput = document.querySelector('[data-testid="emoji-search"] input') ||
                                document.querySelector('input[placeholder*="Search"]');
                            if (searchInput) {
                                searchInput.value = '';
                                // Use execCommand to insert the emoji
                                searchInput.focus();
                                document.execCommand('insertText', false, emoji);
                                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                                await new Promise(r => setTimeout(r, 300));
                                // Click the first emoji result
                                const firstEmoji = document.querySelector('[data-testid="emoji"]') ||
                                    document.querySelector('[role="button"][tabindex="0"]');
                                if (firstEmoji) {
                                    firstEmoji.click();
                                }
                            }
                        }
                        return 'reacted_via_dom';
                    }
                }
            } catch (e) {
                console.log('sendReaction Method 2 failed:', e.message);
            }

            // ── Method 3: Direct Store.react mutation ─────────────────────────
            try {
                // Use the WhatsApp webpack module for reacting
                if (typeof window.require !== 'undefined') {
                    const Store = window.require('WAWebStore');
                    if (Store && Store.Msg && Store.Msg.react) {
                        await Store.Msg.react(mid, emoji);
                        return 'reacted';
                    }
                }
            } catch (e) {
                console.log('sendReaction Method 3 failed:', e.message);
            }

            throw new Error('Could not send reaction via any method');
        }, chatId, msgId, reaction, remove);

        console.log(`sendReaction: reacted to ${msgId} with ${reaction}`);
        res.json({ response: result || 'reacted' });
    } catch (e) {
        console.error('sendReaction error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── sendText ─────────────────────────────────────────────────────────────────
app.post('/api/sendText', async (req, res) => {
    const n = replyLib.normalizeSendMsgArgs(req.body);
    const vErr = replyLib.validateSendArgs(n);
    if (vErr) return res.status(400).json({ error: vErr });
    const { chatId, text, replyToId } = n;

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });

        // ── Reply (quoted message) branch ──────────────────────────────────────
        if (replyLib.isReply(n)) {
            let replyDone = false;

            // 0. Preferred: send the quoted reply through WhatsApp's own
            //    webpack modules (no GUI context-menu simulation needed).
            try {
                const nat = await waPage.evaluate(replyLib.sendNativeReply,
                    { chatId: chatId, text: text, msgId: replyToId });
                if (nat && nat.sent) {
                    if (nat.quoted === false) {
                        console.warn('sendText: native reply sent but quote could not be verified');
                    }
                    console.log(`sendText: replied to ${replyToId} via webpack (${text.length} chars)`);
                    msgCache.delete(chatId);
                    return res.json({ response: 'sent_reply' });
                }
                console.log(`sendText: native reply unavailable (${nat && nat.reason}), trying GUI path`);
            } catch (e) {
                console.error('sendText: native reply attempt failed:', e.message);
            }

            try {
                await forceOpenChat(waPage, chatId);
                console.log(`sendText: sending REPLY to ${chatId} quoting ${replyToId}`);

                // 1. Locate the message and open WhatsApp's context menu on it.
                const probe = await waPage.evaluate(replyLib.probeReplyMessage, { msgId: replyToId });
                if (probe && probe.found) {
                    await new Promise(r => setTimeout(r, 400));

                    // 2. Click the native "Reply" menu item.
                    const clicked = await waPage.evaluate(replyLib.clickReplyMenuItem, {});
                    if (clicked && clicked.clicked) {
                        await new Promise(r => setTimeout(r, 450));

                        // 3. Type the reply text and send (same input path as DOM send).
                        const inputSel = '#main div[contenteditable="true"][data-tab="10"], #main div[contenteditable="true"]';
                        await waPage.waitForSelector(inputSel, { visible: true, timeout: 5000 });
                        await waPage.focus(inputSel);
                        await waPage.type(inputSel, text, { delay: 5 });
                        await new Promise(r => setTimeout(r, 200));
                        const sendSel = '#main span[data-icon="send"], #main [data-testid="send"]';
                        const sendBtn = await waPage.$(sendSel);
                        if (sendBtn) await waPage.click(sendSel);
                        else await waPage.keyboard.press('Enter');
                        await new Promise(r => setTimeout(r, 500));
                        console.log(`sendText: replied to ${replyToId} with ${text.length} chars`);
                        replyDone = true;
                    }
                }
            } catch (e) {
                console.error('sendText: reply attempt failed:', e.message);
            }

            // Never silently downgrade a requested reply to a plain (unquoted)
            // message — that is exactly what made "reply" behave wrongly. If the
            // target message or the context menu cannot be resolved, fail loudly
            // (HTTP 422) and leave the pending reply intact for the caller.
            if (!replyDone) {
                console.error(`sendText: could not perform reply for ${replyToId}; NOT sending plain text.`);
                return res.status(422).json({
                    error: 'Reply target message was not found or the reply UI could not be opened (the quoted message may be scrolled out of the DOM). No message was sent; retry.'
                });
            }
            msgCache.delete(chatId);
            return res.json({ response: 'sent_reply' });
        }

        // ── Method 1: Webpack internal send module (Try first without GUI open for instant delivery) ──
        let sent = false;
        try {
            sent = await waPage.evaluate(async (id, msg) => {
                try {
                    if (typeof window.require !== 'undefined') {
                        let sendMod = null;
                        const sendNames = ['WAWebSendTextMsgChatAction', 'WAWebSendTextMsgAction', 'WAWebChatSend', 'SendTextMsgToChat'];
                        for (const name of sendNames) {
                            try {
                                const m = window.require(name);
                                if (m && (m.sendTextMsgToChat || (m.default && m.default.sendTextMsgToChat))) {
                                    sendMod = m.sendTextMsgToChat || m.default.sendTextMsgToChat;
                                    break;
                                }
                            } catch (e) { }
                        }

                        let chatMod = null;
                        const chatNames = ['WAWebChatCollection', 'WAWebStore', 'Store'];
                        for (const name of chatNames) {
                            try {
                                const m = window.require(name);
                                const coll = m.ChatCollection || m.ChatCollectionImpl || (m.default && m.default.Chat);
                                if (coll && typeof coll.get === 'function') {
                                    chatMod = coll;
                                    break;
                                }
                            } catch (e) { }
                        }

                        if (sendMod && chatMod) {
                            const chat = chatMod.get(id) || (typeof chatMod.find === 'function' ? await chatMod.find(id) : null);
                            if (chat) {
                                const p = sendMod(chat, msg);
                                if (p && typeof p.then === 'function') {
                                    await Promise.race([
                                        p,
                                        new Promise((_, reject) => setTimeout(() => reject(new Error('Webpack send timeout')), 3000))
                                    ]);
                                }
                                return true;
                            }
                        }
                    }
                } catch (e) {
                    console.log('Webpack send failed:', e.message);
                }
                return false;
            }, chatId, text);
        } catch (e) {
            console.log('Webpack send evaluation error:', e.message);
        }

        if (sent) {
            console.log(`sendText: sent ${text.length} chars to ${chatId} via webpack`);
            msgCache.delete(chatId);
            return res.json({ response: 'sent' });
        }

        // If webpack send failed, fall back to opening the chat in GUI and typing
        await forceOpenChat(waPage, chatId);

        // ── Method 2: Native Puppeteer DOM typing and sending (Fallback) ──
        console.log(`sendText: falling back to Puppeteer DOM interaction for ${chatId}`);
        const inputSelector = '#main div[contenteditable="true"][data-tab="10"], #main div[contenteditable="true"], #main p.selectable-text.copyable-text';
        
        await waPage.waitForSelector(inputSelector, { visible: true, timeout: 5000 });
        
        // Focus and clear input if needed
        await waPage.focus(inputSelector);
        
        // Type the text using native Puppeteer keyboard
        await waPage.type(inputSelector, text, { delay: 5 });
        await new Promise(r => setTimeout(r, 200));

        // Click send button or press enter
        const sendBtnSelector = '#main span[data-icon="send"], #main [data-testid="send"]';
        const sendBtn = await waPage.$(sendBtnSelector);
        if (sendBtn) {
            await waPage.click(sendBtnSelector);
        } else {
            await waPage.keyboard.press('Enter');
        }
        
        await new Promise(r => setTimeout(r, 500));
        console.log(`sendText: sent ${text.length} chars to ${chatId} via Puppeteer DOM`);
        msgCache.delete(chatId);
        res.json({ response: 'sent_via_dom' });

    } catch (e) {
        console.error('sendText error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Helper to normalize local file paths (handles file://, URI encoding, spaces) ─
function normalizeLocalPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return null;
    let p = rawPath.trim();
    if (p.startsWith('file://')) {
        try {
            const parsed = new URL(p);
            p = decodeURIComponent(parsed.pathname);
        } catch (_) {
            p = decodeURIComponent(p.replace(/^file:\/\//, ''));
        }
    } else {
        try {
            p = decodeURIComponent(p);
        } catch (_) { }
    }
    return p;
}

// ── Environment helper for clipboard tools ──────────────────────────────────
function getEnvForClipboard() {
    const env = { ...process.env };
    if (!env.WAYLAND_DISPLAY && fs.existsSync('/run/user/' + process.getuid() + '/wayland-0')) {
        env.WAYLAND_DISPLAY = 'wayland-0';
    }
    if (!env.XDG_RUNTIME_DIR) {
        env.XDG_RUNTIME_DIR = '/run/user/' + process.getuid();
    }
    if (!env.DISPLAY) {
        env.DISPLAY = ':0';
    }
    return env;
}

// ── Helper to extract image/media from clipboard ─────────────────────────────
async function extractClipboardMedia(outputPath) {
    const env = getEnvForClipboard();

    // 1. Try Wayland (wl-paste)
    const wlResult = await new Promise((resolve) => {
        exec('wl-paste --list-types', { env }, (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const types = stdout.split('\n').map(s => s.trim()).filter(Boolean);

            // Check for raw image mime
            const imgType = types.find(t => t.startsWith('image/'));
            if (imgType) {
                exec(`wl-paste -t "${imgType}" > "${outputPath}"`, { env }, (err2) => {
                    if (!err2 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                        return resolve({ type: 'image_file', path: outputPath });
                    }
                    resolve(null);
                });
                return;
            }

            // Check for text/uri-list (e.g. copied file in Dolphin / file manager)
            if (types.includes('text/uri-list')) {
                exec('wl-paste -t text/uri-list', { env }, (err2, uriOut) => {
                    if (!err2 && uriOut) {
                        const lines = uriOut.split('\n').map(s => s.trim()).filter(Boolean);
                        for (const line of lines) {
                            const p = normalizeLocalPath(line);
                            if (p && fs.existsSync(p) && /\.(jpe?g|png|gif|mp4|mov|avi|webp|bmp)$/i.test(p)) {
                                return resolve({ type: 'image_file', path: p });
                            }
                        }
                    }
                    resolve(null);
                });
                return;
            }

            resolve(null);
        });
    });

    if (wlResult) return wlResult;

    // 2. Try X11 (xclip)
    const xclipResult = await new Promise((resolve) => {
        exec('xclip -selection clipboard -t TARGETS -o', { env }, (err, stdout) => {
            if (err || !stdout) {
                exec(`xclip -selection clipboard -t image/png -o > "${outputPath}"`, { env }, (err2) => {
                    if (!err2 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                        return resolve({ type: 'image_file', path: outputPath });
                    }
                    resolve(null);
                });
                return;
            }

            const targets = stdout.split('\n').map(s => s.trim()).filter(Boolean);
            const imgTarget = targets.find(t => t.startsWith('image/') || t === 'image/png' || t === 'image/jpeg');
            if (imgTarget) {
                exec(`xclip -selection clipboard -t "${imgTarget}" -o > "${outputPath}"`, { env }, (err2) => {
                    if (!err2 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
                        return resolve({ type: 'image_file', path: outputPath });
                    }
                    resolve(null);
                });
                return;
            }

            if (targets.includes('text/uri-list')) {
                exec('xclip -selection clipboard -t text/uri-list -o', { env }, (err2, uriOut) => {
                    if (!err2 && uriOut) {
                        const lines = uriOut.split('\n').map(s => s.trim()).filter(Boolean);
                        for (const line of lines) {
                            const p = normalizeLocalPath(line);
                            if (p && fs.existsSync(p) && /\.(jpe?g|png|gif|mp4|mov|avi|webp|bmp)$/i.test(p)) {
                                return resolve({ type: 'image_file', path: p });
                            }
                        }
                    }
                    resolve(null);
                });
                return;
            }

            resolve(null);
        });
    });

    return xclipResult;
}

// ── Shared Media / File Sender ───────────────────────────────────────────────
async function sendMediaFile(waPage, chatId, filePath, caption = '') {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    console.log(`sendMediaFile: preparing to send ${filePath} to ${chatId}`);

    // Ensure chat is open
    await forceOpenChat(waPage, chatId);
    await new Promise(r => setTimeout(r, 400));

    // Find any existing file input or click attach button to mount
    let fileInputs = await waPage.$$('input[type="file"]');
    if (fileInputs.length === 0) {
        await waPage.evaluate(() => {
            const attachBtn = document.querySelector('[aria-label="Attach"]') ||
                document.querySelector('[data-icon="plus-rounded"]') ||
                document.querySelector('[data-icon="plus"]')?.closest('button') ||
                document.querySelector('[data-testid="plus"]') ||
                document.querySelector('[data-testid="attach-menu-plus"]');
            if (attachBtn) attachBtn.click();
        });
        await new Promise(r => setTimeout(r, 600));
        fileInputs = await waPage.$$('input[type="file"]');
    }

    if (fileInputs.length === 0) {
        await waPage.evaluate(() => {
            const attachBtn = document.querySelector('[aria-label="Attach"]') ||
                document.querySelector('[data-icon="plus-rounded"]') ||
                document.querySelector('[data-icon="plus"]')?.closest('button') ||
                document.querySelector('[data-testid="plus"]');
            if (attachBtn) attachBtn.click();
        });
        await new Promise(r => setTimeout(r, 800));
        fileInputs = await waPage.$$('input[type="file"]');
    }

    if (fileInputs.length === 0) {
        throw new Error('Could not find file input in attach menu');
    }

    // Determine appropriate input. WhatsApp mounts several hidden inputs:
    // photos/videos (accept includes video) and stickers (image/webp only).
    // Pasting an image must go out as a PHOTO, never as a sticker, so we
    // prefer the photo/video input and explicitly avoid webp-only inputs.
    const isMedia = /\.(jpe?g|png|gif|mp4|mov|avi|webp|bmp)$/i.test(filePath);
    const isImage = /\.(jpe?g|png|gif|bmp)$/i.test(filePath);
    const inputAccepts = [];
    for (const input of fileInputs) {
        const accept = await waPage.evaluate(el => el.accept || '', input);
        inputAccepts.push({ input: input, accept: accept });
    }

    let selectedInput = null;
    if (isImage || isMedia) {
        // 1) Photo/video input: its accept string is the only one listing video.
        for (const it of inputAccepts) {
            if (it.accept.includes('video')) { selectedInput = it.input; break; }
        }
        // 2) A generic image input that is NOT the sticker picker.
        if (!selectedInput) {
            for (const it of inputAccepts) {
                if (it.accept.includes('image') && !it.accept.includes('webp')) { selectedInput = it.input; break; }
            }
        }
    }
    if (!selectedInput) {
        for (const it of inputAccepts) {
            if (isMedia && (it.accept.includes('image') || it.accept.includes('video'))) { selectedInput = it.input; break; }
        }
    }
    if (!selectedInput) {
        for (const it of inputAccepts) {
            if (!isMedia && (it.accept.includes('*') || it.accept === '')) { selectedInput = it.input; break; }
        }
    }
    if (!selectedInput) {
        selectedInput = inputAccepts.length > 0 ? inputAccepts[0].input : fileInputs[0];
    }

    // Upload the file
    await selectedInput.uploadFile(filePath);

    // Wait for the preview stage / send button
    const previewSendSelectors = [
        '[data-testid="send"]',
        'div[role="button"][aria-label="Send"]',
        'span[data-icon="send"]',
        'span[data-icon="send-light"]',
        'span[data-icon="send-inverted"]',
        '[data-testid="media-send-button"]',
        'button[aria-label="Send"]',
        'button[type="submit"]'
    ];
    const previewSelectorCombined = previewSendSelectors.join(', ');

    let sendBtnFound = false;
    for (let i = 0; i < 30; i++) {
        const hasBtn = await waPage.evaluate((sel) => {
            return !!document.querySelector(sel);
        }, previewSelectorCombined);
        if (hasBtn) {
            sendBtnFound = true;
            break;
        }
        await new Promise(r => setTimeout(r, 300));
    }

    if (!sendBtnFound) {
        console.warn('sendMediaFile: Send button selector not detected within 9s, attempting fallback send...');
    }

    // Add caption if provided
    if (caption) {
        await waPage.evaluate((text) => {
            const captionInput = document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
                document.querySelector('div[contenteditable="true"][data-testid="media-caption-input"]') ||
                document.querySelector('div[contenteditable="true"]');
            if (captionInput) {
                captionInput.focus();
                document.execCommand('insertText', false, text);
                captionInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, caption);
        await new Promise(r => setTimeout(r, 200));
    }

    // Click send or press Enter
    const clicked = await waPage.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (btn) {
            btn.click();
            return true;
        }
        return false;
    }, previewSelectorCombined);

    if (!clicked) {
        await waPage.keyboard.press('Enter');
    }

    // Wait for send to complete
    await new Promise(r => setTimeout(r, 2500));
    console.log(`sendMediaFile: successfully processed ${filePath}`);
    return true;
}

// ── sendFile ─────────────────────────────────────────────────────────────────
app.post('/api/sendFile', async (req, res) => {
    const body = req.body;
    const args = body.args || body;
    const chatId = args.to || args.chatId;
    const rawPath = args.filePath;
    const caption = args.caption || '';

    if (!chatId || !rawPath) return res.status(400).json({ error: 'Missing chatId or filePath' });

    const filePath = normalizeLocalPath(rawPath);
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: `File not found: ${filePath || rawPath}` });
    }

    console.log(`sendFile: sending ${filePath} to ${chatId}`);

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });

        await sendMediaFile(waPage, chatId, filePath, caption);
        msgCache.delete(chatId);
        res.json({ response: 'sent' });
    } catch (e) {
        console.error('sendFile error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── pasteImage ───────────────────────────────────────────────────────────────
// Default behaviour: SAVE the clipboard image and return its path so the
// widget can attach it as a draft (the user sends it explicitly with the
// send button). Passing args.send = true restores the legacy "send at once".
app.post('/api/pasteImage', async (req, res) => {
    const body = req.body;
    const args = body.args || body;
    const chatId = args.to || args.chatId;
    const autoSend = args.send === true;

    const outputPath = path.join(__dirname, '..', 'clipboard_pasted.png');

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });

        const media = await extractClipboardMedia(outputPath);
        if (!media || !media.path) {
            console.log('pasteImage: no image or media found in clipboard');
            return res.json({ response: 'no_image' });
        }

        if (!autoSend) {
            console.log(`pasteImage: clipboard media saved as draft: ${media.path}`);
            return res.json({ response: 'saved', path: media.path });
        }

        if (!chatId) return res.status(400).json({ error: 'Missing chatId' });

        console.log(`pasteImage: sending clipboard media ${media.path} to ${chatId}`);
        await sendMediaFile(waPage, chatId, media.path);
        console.log(`pasteImage: successfully sent pasted image`);
        res.json({ response: 'sent' });
    } catch (e) {
        if (e.message.includes('No image in clipboard') || e.message.includes('no_image')) {
            console.log('pasteImage: no image in clipboard');
            res.json({ response: 'no_image' });
        } else {
            console.error('pasteImage error:', e.message);
            res.status(500).json({ error: e.message });
        }
    }
});

// ── Diagnose (debug) ─────────────────────────────────────────────────────────
app.post('/api/diagnose', async (req, res) => {
    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });
        const info = await waPage.evaluate(() => {
            const result = {
                hasRequire: typeof window.require !== 'undefined',
                hasWebpack: typeof window.webpackChunkwhatsapp_web_client !== 'undefined',
                hasWAPI: typeof window.WAPI !== 'undefined',
                url: location.href,
                modules: {},
                chatCountViaRequire: 0,
                chatCountViaWebpack: 0,
            };

            // Try window.require() with common WA module IDs
            if (result.hasRequire) {
                const tryIds = ['WAWebChatCollection', 'WAWebChat', 'ChatStore',
                    'chat', 'Chat', 'Wap', 'Store', 'default'];
                for (const id of tryIds) {
                    try {
                        const m = window.require(id);
                        result.modules[id] = {
                            keys: m ? Object.keys(m).slice(0, 10) : [],
                            hasGetModels: !!(m && typeof m.getModelsArray === 'function'),
                            len: m && m.getModelsArray ? m.getModelsArray().length : 'n/a',
                        };
                    } catch (e) {
                        result.modules[id] = { error: e.message.substring(0, 60) };
                    }
                }
            }

            // Try webpack chunk push with loose predicate
            if (result.hasWebpack) {
                try {
                    let count = 0;
                    let found = [];
                    window.webpackChunkwhatsapp_web_client.push([['_d2'], {}, function (e) {
                        for (let k in e.m) {
                            try {
                                const m = e(k);
                                if (!m) continue;
                                const d = m.default || m;
                                if (typeof d.getModelsArray === 'function') {
                                    count++;
                                    const arr = d.getModelsArray();
                                    found.push({
                                        key: k, len: arr.length,
                                        keys: Object.keys(d).slice(0, 6)
                                    });
                                }
                            } catch (_) { }
                        }
                    }]);
                    result.chatCountViaWebpack = count;
                    result.foundModules = found;
                } catch (ex) {
                    result.webpackError = ex.message;
                }
            }

            return result;
        });
        res.json(info);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Eval (debug) ─────────────────────────────────────────────────────────────
app.post('/api/eval', async (req, res) => {
    try {
        const waPage = await getValidPage();
        if (!waPage) return res.status(503).json({ error: 'No page' });
        const { code } = req.body.args || req.body;
        // Evaluate the code string as a function block
        const result = await waPage.evaluate((codeStr) => {
            return (new Function(codeStr))();
        }, code);
        res.json({ response: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Restart ──────────────────────────────────────────────────────────────────
app.post('/api/restart', async (req, res) => {
    try {
        console.log('[API] Received restart request from client.');
        isReady = false; // Mark not ready immediately to block other API calls during shutdown
        res.json({ response: 'restarting' });

        const scriptPath = path.join(__dirname, '..', 'manage.sh');
        const { spawn } = require('child_process');
        
        // Spawn detached process that sleeps briefly to let response complete,
        // then runs manage.sh stop-backend and manage.sh start-backend.
        const child = spawn('bash', [
            '-c',
            `sleep 0.5 && "${scriptPath}" stop-backend && "${scriptPath}" start-backend`
        ], {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();
    } catch (e) {
        console.error('Restart API error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Logout / auth reset ──────────────────────────────────────────────────────
// Drops the backend back to the QR login flow: clears in-memory session state,
// deletes any stale QR file, reloads WhatsApp Web (a fresh QR appears if the
// session is really dead; the app re-readies itself if it wasn't), and
// restarts the QR watcher. Called by the widget's auto-logout recovery.
app.post('/api/logout', async (_req, res) => {
    try {
        console.log('[AUTH] Logout requested — resetting to QR login flow.');
        isReady = false;
        currentOpenChatId = null;
        msgCache.clear();
        avatarStore.clear();
        mediaLib.mediaCache.clear();
        try { fs.unlinkSync(QR_PATH); } catch (_) { }
        if (waPage) {
            try {
                await waPage.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (e) {
                console.log('[AUTH] Page reload failed:', e.message);
            }
        }
        waitForAppOrQR();
        res.json({ response: 'logged_out' });
    } catch (e) {
        console.error('logout error:', e.message);
        res.status(500).json({ error: e.message });
    }
});



async function launch() {
    console.log('=== WhatsApp KDE Widget Backend ===');
    console.log('Launching Chrome 150…');

    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Clean up stale Singleton files (Lock/Socket/Cookie) so Chrome can start.
    // A lock left by a dead (or half-dead) instance otherwise aborts the launch
    // with "Failed to create SingletonLock: File exists (17)".
    const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    const clearSingletons = () => {
        for (const f of SINGLETON_FILES) {
            const p = path.join(DATA_DIR, f);
            try {
                if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    console.log('[HEAL] Removed leftover ' + f + ' file.');
                }
            } catch (e) {
                console.error('[HEAL] Failed to remove ' + f + ':', e.message);
            }
        }
    };
    clearSingletons();

    const launchOpts = {
        executablePath: CHROME,
        headless: true,
        userDataDir: DATA_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--window-size=1280,800',
        ],
        defaultViewport: { width: 1280, height: 800 },
    };

    try {
        browser = await puppeteer.launch(launchOpts);
    } catch (e) {
        // Chrome refused to start — usually a profile lock held by a half-dead
        // instance that lost its CDP connection. Kill anything bound to this
        // profile dir, clear the locks again, and retry exactly once.
        console.error('[HEAL] Chrome launch failed:', e.message);
        console.log('[HEAL] Killing stale chrome bound to this profile and retrying once…');
        try { exec('pkill -f "' + DATA_DIR + '"'); } catch (_) { }
        await new Promise(r => setTimeout(r, 2500));
        clearSingletons();
        browser = await puppeteer.launch(launchOpts);
    }

    const pages = await browser.pages();
    waPage = pages[0] || await browser.newPage();

    waPage.on('console', msg => {
        console.log(`[BROWSER CONSOLE] ${msg.text()}`);
    });

    // Spoof UA so WhatsApp doesn't see Chrome/104
    await waPage.setUserAgent(UA);
    await waPage.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    console.log('Navigating to WhatsApp Web…');
    await waPage.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

    console.log('Waiting for QR or app…');
    waitForAppOrQR();
}

let qrWatcherRunning = false; // guards against duplicate QR/ready watchers

async function waitForAppOrQR() {
    if (qrWatcherRunning) return; // already watching — don't spawn a second interval
    qrWatcherRunning = true;
    let qrPolled = false;
    let tick = 0;

    const qrTimer = setInterval(async () => {
        if (!waPage) return;
        tick++;
        try {
            // Every 5 ticks (10s), log what's in the DOM for debugging
            if (tick % 5 === 0) {
                const domInfo = await waPage.evaluate(() => {
                    const testids = [...document.querySelectorAll('[data-testid]')]
                        .map(el => el.getAttribute('data-testid')).slice(0, 20);
                    const bodyText = document.body ? document.body.innerText.substring(0, 200) : '';
                    return { url: location.href, testids, bodyText };
                }).catch(() => ({ url: 'unknown', testids: [], bodyText: '' }));
                console.log(`[POLL ${tick}] URL: ${domInfo.url}`);
                console.log(`[POLL ${tick}] data-testid attrs:`, domInfo.testids.join(', ') || 'none');
            }

            // Expired QR: WhatsApp stops rotating the canvas once it expires
            // and shows a refresh button instead. Scanning the stale canvas
            // makes the phone say "Couldn't link device, please try again
            // later" — so click refresh, drop the stale file (the widget falls
            // back to "Waiting for QR code…"), and grab the fresh canvas next
            // tick.
            const expired = await waPage.evaluate(() => {
                const btn = document.querySelector('[data-testid="link_device_qr_expired_refresh_button"]')
                    || document.querySelector('[data-testid="refresh-large"]');
                if (btn) { btn.click(); return true; }
                return false;
            });
            if (expired && !isReady) {
                try { fs.unlinkSync(QR_PATH); } catch (_) { }
                console.log('[QR] Expired QR detected — clicked refresh; waiting for fresh code.');
                return;
            }

            // Check for QR canvas
            const qrDataUrl = await waPage.evaluate(() => {
                const canvas = document.querySelector('canvas[aria-label]') ||
                    document.querySelector('div[data-testid="qrcode"] canvas') ||
                    document.querySelector('canvas');
                return canvas ? canvas.toDataURL('image/png') : null;
            });
            if (qrDataUrl && !isReady) {
                const b64 = qrDataUrl.replace('data:image/png;base64,', '');
                fs.writeFileSync(QR_PATH, Buffer.from(b64, 'base64'));
                if (!qrPolled) {
                    qrPolled = true;
                    console.log('='.repeat(60));
                    console.log('[QR CODE] Saved to: ' + QR_PATH);
                    console.log('Open the file and scan it with your WhatsApp app!');
                    console.log('='.repeat(60));
                }
                return;
            }

            // Check if app is ready — very broad set of selectors.
            // NOTE: the login/QR screen also renders data-testids
            // (link-device-qr-code etc.), so we must exclude it before
            // declaring "ready" — otherwise the backend marks itself
            // authenticated while WhatsApp is actually logged out.
            const readyInfo = await waPage.evaluate(() => {
                const tids = Array.from(document.querySelectorAll('[data-testid]'))
                    .map(el => el.getAttribute('data-testid') || '');
                const checks = {
                    pane_side: !!document.getElementById('pane-side'),
                    chat_list: !!document.querySelector('[data-testid="chat-list"]'),
                    aria_list: !!document.querySelector('[aria-label="Chat list"]'),
                    app: !!document.getElementById('app'),
                    has_webpack: typeof window.webpackChunkwhatsapp_web_client !== 'undefined',
                    has_wapi: typeof window.WAPI !== 'undefined',
                    any_testid: tids.length > 0,
                    login_screen: tids.some(t => t.indexOf('link-device') === 0 || t.indexOf('link_device') === 0),
                };
                return checks;
            });

            if (!isReady && !readyInfo.login_screen && (readyInfo.pane_side || readyInfo.chat_list || readyInfo.aria_list)) {
                clearInterval(qrTimer);
                qrWatcherRunning = false;
                isReady = true;
                try { fs.unlinkSync(QR_PATH); } catch (_) { }
                console.log('='.repeat(60));
                console.log('[READY] WhatsApp Web authenticated and ready!');
                console.log('[READY] Selectors matched:', JSON.stringify(readyInfo));
                console.log('='.repeat(60));
            } else if (!isReady && !readyInfo.login_screen && readyInfo.has_webpack && readyInfo.any_testid) {
                // Webpack loaded and something's rendered (and it is NOT the
                // login screen) — be optimistic.
                console.log('[READY?] Webpack loaded, assuming ready. Info:', JSON.stringify(readyInfo));
                clearInterval(qrTimer);
                qrWatcherRunning = false;
                isReady = true;
                try { fs.unlinkSync(QR_PATH); } catch (_) { }
            }
        } catch (e) {
            if (tick % 5 === 0) console.log('[POLL error]', e.message.substring(0, 80));
        }
    }, 2000);
}

// ── Start API server first, then launch browser ───────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
    console.log(`API listening on http://127.0.0.1:${PORT}`);
    launch().catch(err => {
        console.error('Fatal launch error:', err);
        process.exit(1);
    });
});

// ── Screenshot (debug) ───────────────────────────────────────────────────────
app.post('/api/screenshot', async (req, res) => {
    try {
        const waPage = await getValidPage();
        if (!waPage) return res.status(503).json({ error: 'No page' });
        const buf = await waPage.screenshot({ type: 'png', fullPage: false });
        res.setHeader('Content-Type', 'image/png');
        res.send(buf);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', () => { console.log('\nShutting down…'); browser && browser.close(); process.exit(0); });
process.on('SIGTERM', () => { browser && browser.close(); process.exit(0); });
