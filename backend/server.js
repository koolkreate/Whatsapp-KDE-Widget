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
const express = require('express');
const fs = require('fs');
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
app.get('/api/status', (_req, res) => res.json({ ready: isReady }));

// ── Auth middleware (applies to all routes below this line) ─────────────────
app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.headers['api-key'];
    if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

// ── getAllChats ──────────────────────────────────────────────────────────────
app.post('/api/getAllChats', async (req, res) => {
    try {
        const page = await getValidPage();
        if (!isReady || !page) return res.status(503).json({ error: 'Not ready' });
        const chats = await page.evaluate(() => {

            // ── Method 1: WAWebChatCollection singleton ──────────────────────
            try {
                const mod = window.require('WAWebChatCollection');
                // Try ChatCollection (often the singleton Backbone collection)
                const coll = mod.ChatCollection || mod.ChatCollectionImpl;
                if (coll && typeof coll.getModelsArray === 'function') {
                    return coll.getModelsArray().map(c => ({
                        id: c.id && c.id._serialized || String(c.id),
                        name: c.formattedTitle || c.name || '',
                        formattedTitle: c.formattedTitle || '',
                        isGroup: !!c.isGroup,
                        unreadCount: c.unreadCount || 0,
                        t: c.t || 0,
                        lastMessage: c.lastMessage ? {
                            body: c.lastMessage.body || '',
                            type: c.lastMessage.type || 'chat',
                            t: c.lastMessage.t || 0,
                            fromMe: !!(c.lastMessage.id && c.lastMessage.id.fromMe),
                        } : null,
                    }));
                }
                // Try as a class: look for static methods or a default export
                if (mod.ChatCollection && mod.ChatCollection.prototype &&
                    typeof mod.ChatCollection.prototype.getModelsArray === 'function') {
                    // It's a class — find the global instance via store registry
                }
            } catch (e) { }

            // ── Method 2: WAWebStore or WAWebStoreService ────────────────────
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
                                name: c.formattedTitle || c.name || '',
                                formattedTitle: c.formattedTitle || '',
                                isGroup: !!c.isGroup,
                                unreadCount: c.unreadCount || 0,
                                t: c.t || 0,
                                lastMessage: c.lastMessage ? {
                                    body: c.lastMessage.body || '',
                                    type: c.lastMessage.type || 'chat', t: c.lastMessage.t || 0,
                                    fromMe: !!(c.lastMessage.id && c.lastMessage.id.fromMe),
                                } : null,
                            }));
                        }
                    } catch (_) { }
                }
            } catch (e) { }

            // ── Method 3: React Fiber traversal on chat list ─────────────────
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
                                        name: chat.formattedTitle || chat.name || '',
                                        formattedTitle: chat.formattedTitle || '',
                                        isGroup: !!chat.isGroup,
                                        unreadCount: chat.unreadCount || 0,
                                        t: chat.t || 0,
                                        lastMessage: chat.lastMessage ? {
                                            body: chat.lastMessage.body || '',
                                            type: chat.lastMessage.type || 'chat',
                                            t: chat.lastMessage.t || 0,
                                            fromMe: !!(chat.lastMessage.id && chat.lastMessage.id.fromMe),
                                        } : null,
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

            // ── Method 4: DOM scrape (name-only fallback, no IDs) ────────────
            try {
                const rows = document.querySelectorAll('[data-testid="cell-frame-container"]');
                const results = [];
                rows.forEach(row => {
                    const nameEl = row.querySelector('[data-testid="cell-frame-title"] span') ||
                        row.querySelector('span[title]');
                    const name = nameEl ? (nameEl.title || nameEl.textContent || '') : '';
                    if (name) {
                        results.push({
                            id: 'dom_' + name.replace(/\s+/g, '_'),
                            name: name, formattedTitle: name,
                            isGroup: false, unreadCount: 0, t: 0, lastMessage: null,
                        });
                    }
                });
                return results;
            } catch (e) { }

            return [];
        });
        console.log(`getAllChats: returned ${chats.length} chats`);
        res.json({ response: chats });
    } catch (e) {
        console.error('getAllChats error:', e.message);
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
                        let senderName = '';
                        if (m.sender) {
                            senderName = m.sender.formattedName || m.sender.name || m.sender.id.user || '';
                        }
                        // Collect reactions if present
                        let reactions = [];
                        try {
                            if (m.reactions && m.reactions.length > 0) {
                                reactions = m.reactions.map(r => ({
                                    emoji: r.orphan || r.emoji || '',
                                    sender: r.sender && (r.sender.formattedName || r.sender.name || r.sender.id.user || ''),
                                    fromMe: !!(r.sender && r.sender.id && r.sender.id._serialized === window.Store && window.Store.MaybeMeUser),
                                }));
                            }
                        } catch (_) { }
                        return {
                            id: m.id && m.id._serialized || String(m.id || Math.random()),
                            body: m.body || m.content || '',
                            type: m.type || 'chat',
                            t: m.t || 0,
                            fromMe: !!(m.id && m.id.fromMe),
                            senderName: senderName,
                            reactions: reactions,
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
                                        let senderName = '';
                                        if (msg.sender) {
                                            senderName = msg.sender.formattedName || msg.sender.name || msg.sender.id.user || '';
                                        }
                                        // Collect reactions
                                        let reactions = [];
                                        try {
                                            if (msg.reactions && msg.reactions.length > 0) {
                                                reactions = msg.reactions.map(r => ({
                                                    emoji: r.orphan || r.emoji || '',
                                                    sender: r.sender && (r.sender.formattedName || r.sender.name || r.sender.id.user || ''),
                                                    fromMe: !!(r.sender && r.sender.id && r.sender.id._serialized === window.Store && window.Store.MaybeMeUser),
                                                }));
                                            }
                                        } catch (_) { }
                                        results.push({
                                            id: msg.id._serialized,
                                            body: msg.body || msg.content || '',
                                            type: msg.type || 'chat',
                                            t: msg.t || 0,
                                            fromMe: !!(msg.id && msg.id.fromMe),
                                            senderName: senderName,
                                            reactions: reactions,
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

        console.log(`getChatMessages: returned ${messages.length} messages for chat ${chatId}`);
        res.json({ response: messages });
    } catch (e) {
        console.error('getChatMessages error:', e.message);
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
    const body = req.body;
    const args = body.args || body;
    const chatId = args.to || args.chatId;
    const text = args.content || args.text;

    if (!chatId || !text) return res.status(400).json({ error: 'Missing to/content' });

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });

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
        res.json({ response: 'sent_via_dom' });

    } catch (e) {
        console.error('sendText error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── sendFile ─────────────────────────────────────────────────────────────────
app.post('/api/sendFile', async (req, res) => {
    const body = req.body;
    const args = body.args || body;
    const chatId = args.to || args.chatId;
    const rawPath = args.filePath;
    const caption = args.caption || '';

    if (!chatId || !rawPath) return res.status(400).json({ error: 'Missing chatId or filePath' });

    let filePath = rawPath;
    if (filePath.startsWith('file://')) {
        filePath = filePath.substring(7); // strip file://
    }

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    console.log(`sendFile: sending ${filePath} to ${chatId}`);

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });

        // First select the chat in the UI to make sure it's open
        await forceOpenChat(waPage, chatId);

        // Click the attach menu button to mount file inputs
        await waPage.evaluate(() => {
            const attachBtn = document.querySelector('[data-testid="plus"]') ||
                document.querySelector('[data-icon="plus"]')?.closest('button') ||
                document.querySelector('[aria-label="Attach"]') ||
                document.querySelector('[data-testid="attach-menu-plus"]');
            if (attachBtn) attachBtn.click();
        });

        await new Promise(r => setTimeout(r, 600)); // wait for inputs to mount

        // Find file inputs
        const fileInputs = await waPage.$$('input[type="file"]');
        if (fileInputs.length === 0) {
            throw new Error('No file inputs found in attach menu');
        }

        // Choose which input to use based on file type
        let selectedInput = fileInputs[0];
        const isMedia = /\.(jpe?g|png|gif|mp4|mov|avi|webp)$/i.test(filePath);
        if (fileInputs.length > 1) {
            if (isMedia) {
                for (const input of fileInputs) {
                    const accept = await waPage.evaluate(el => el.accept || '', input);
                    if (accept.includes('image') || accept.includes('video')) {
                        selectedInput = input;
                        break;
                    }
                }
            } else {
                for (const input of fileInputs) {
                    const accept = await waPage.evaluate(el => el.accept || '', input);
                    if (accept.includes('*') || accept === '') {
                        selectedInput = input;
                        break;
                    }
                }
            }
        }

        // Upload the file
        await selectedInput.uploadFile(filePath);

        // Wait for preview screen
        const sendBtnSelector = 'span[data-icon="send"], [data-testid="send"]';
        await waPage.waitForSelector(sendBtnSelector, { timeout: 15000 });

        // Add caption if provided
        if (caption) {
            await waPage.evaluate((text) => {
                const captionInput = document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
                    document.querySelector('div[contenteditable="true"]');
                if (captionInput) {
                    captionInput.focus();
                    document.execCommand('insertText', false, text);
                    captionInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, caption);
            await new Promise(r => setTimeout(r, 200));
        }

        // Click send button
        await waPage.evaluate(() => {
            const sendBtn = document.querySelector('[data-testid="send"]') ||
                document.querySelector('span[data-icon="send"]')?.closest('button') ||
                document.querySelector('button[type="submit"]');
            if (sendBtn) sendBtn.click();
        });

        // Wait for send to complete
        await new Promise(r => setTimeout(r, 2500));

        console.log(`sendFile: successfully sent ${filePath}`);
        res.json({ response: 'sent' });
    } catch (e) {
        console.error('sendFile error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── pasteImage ───────────────────────────────────────────────────────────────
app.post('/api/pasteImage', async (req, res) => {
    const body = req.body;
    const args = body.args || body;
    const chatId = args.to || args.chatId;

    if (!chatId) return res.status(400).json({ error: 'Missing chatId' });

    const outputPath = path.join(__dirname, '..', 'clipboard_pasted.png');

    try {
        const waPage = await getValidPage();
        if (!isReady || !waPage) return res.status(503).json({ error: 'Not ready' });
        // Retrieve clipboard image
        await new Promise((resolve, reject) => {
            // Check Wayland (wl-paste)
            exec('wl-paste --list-types', (err, stdout) => {
                if (!err && (stdout.includes('image/png') || stdout.includes('image/jpeg'))) {
                    const mime = stdout.includes('image/png') ? 'image/png' : 'image/jpeg';
                    exec(`wl-paste -t ${mime} > "${outputPath}"`, (err2) => {
                        if (!err2) return resolve();
                        reject(err2);
                    });
                } else {
                    // Check X11 (xclip)
                    exec('xclip -selection clipboard -t image/png -o > /dev/null', (err3) => {
                        if (!err3) {
                            exec(`xclip -selection clipboard -t image/png -o > "${outputPath}"`, (err4) => {
                                if (!err4) return resolve();
                                reject(err4);
                            });
                        } else {
                            reject(new Error('No image in clipboard'));
                        }
                    });
                }
            });
        });

        // Now call the file upload logic using outputPath
        console.log(`pasteImage: sending clipboard image ${outputPath} to ${chatId}`);

        // First select the chat in the UI to make sure it's open
        await waPage.evaluate(async (cid) => {
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
            if (chatMod) chat = chatMod.get(cid);
            if (chat) {
                if (typeof chat.onSelected === 'function') await chat.onSelected();
                else if (typeof chat.select === 'function') await chat.select();
            } else {
                const chatList = document.querySelector('#pane-side') || document.querySelector('[data-testid="chat-list"]');
                if (chatList) {
                    let chatRow = null;
                    const fiberKey = Object.keys(chatList).find(k => k.startsWith('__reactFiber'));
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
                    if (chatRow) chatRow.click();
                }
            }
        }, chatId);

        await new Promise(r => setTimeout(r, 800)); // wait for chat to load

        // Click attach menu
        await waPage.evaluate(() => {
            const attachBtn = document.querySelector('[data-testid="plus"]') ||
                document.querySelector('[data-icon="plus"]')?.closest('button') ||
                document.querySelector('[aria-label="Attach"]') ||
                document.querySelector('[data-testid="attach-menu-plus"]');
            if (attachBtn) attachBtn.click();
        });

        await new Promise(r => setTimeout(r, 600)); // wait for inputs to mount

        // Find file inputs
        const fileInputs = await waPage.$$('input[type="file"]');
        if (fileInputs.length === 0) {
            throw new Error('No file inputs found in attach menu');
        }

        // Choose the media input
        let selectedInput = fileInputs[0];
        if (fileInputs.length > 1) {
            for (const input of fileInputs) {
                const accept = await waPage.evaluate(el => el.accept || '', input);
                if (accept.includes('image') || accept.includes('video')) {
                    selectedInput = input;
                    break;
                }
            }
        }

        // Upload the file
        await selectedInput.uploadFile(outputPath);

        // Wait for preview screen
        const sendBtnSelector = 'span[data-icon="send"], [data-testid="send"]';
        await waPage.waitForSelector(sendBtnSelector, { timeout: 15000 });

        // Click send button
        await waPage.evaluate(() => {
            const sendBtn = document.querySelector('[data-testid="send"]') ||
                document.querySelector('span[data-icon="send"]')?.closest('button') ||
                document.querySelector('button[type="submit"]');
            if (sendBtn) sendBtn.click();
        });

        // Wait for send to complete
        await new Promise(r => setTimeout(r, 2500));

        console.log(`pasteImage: successfully sent pasted image`);
        res.json({ response: 'sent' });
    } catch (e) {
        if (e.message.includes('No image in clipboard')) {
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



async function launch() {
    console.log('=== WhatsApp KDE Widget Backend ===');
    console.log('Launching Chrome 150…');

    fs.mkdirSync(DATA_DIR, { recursive: true });

    // Clean up SingletonLock if it exists to prevent Chrome startup failures
    const lockPath = path.join(DATA_DIR, 'SingletonLock');
    if (fs.existsSync(lockPath)) {
        try {
            fs.unlinkSync(lockPath);
            console.log('[HEAL] Removed leftover SingletonLock file.');
        } catch (e) {
            console.error('[HEAL] Failed to remove SingletonLock file:', e.message);
        }
    }

    browser = await puppeteer.launch({
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
    });

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

async function waitForAppOrQR() {
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

            // Check if app is ready — very broad set of selectors
            const readyInfo = await waPage.evaluate(() => {
                const checks = {
                    pane_side: !!document.getElementById('pane-side'),
                    chat_list: !!document.querySelector('[data-testid="chat-list"]'),
                    aria_list: !!document.querySelector('[aria-label="Chat list"]'),
                    app: !!document.getElementById('app'),
                    has_webpack: typeof window.webpackChunkwhatsapp_web_client !== 'undefined',
                    has_wapi: typeof window.WAPI !== 'undefined',
                    any_testid: document.querySelector('[data-testid]') !== null,
                };
                return checks;
            });

            if (!isReady && (readyInfo.pane_side || readyInfo.chat_list || readyInfo.aria_list)) {
                clearInterval(qrTimer);
                isReady = true;
                try { fs.unlinkSync(QR_PATH); } catch (_) { }
                console.log('='.repeat(60));
                console.log('[READY] WhatsApp Web authenticated and ready!');
                console.log('[READY] Selectors matched:', JSON.stringify(readyInfo));
                console.log('='.repeat(60));
            } else if (!isReady && readyInfo.has_webpack && readyInfo.any_testid) {
                // Webpack loaded and something's rendered — be optimistic
                console.log('[READY?] Webpack loaded, assuming ready. Info:', JSON.stringify(readyInfo));
                clearInterval(qrTimer);
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
