'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.WA_DATA_DIR || path.join(__dirname, '..', 'data');
const PINS_FILE = path.join(DATA_DIR, 'pinned_chats.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function getPinned() {
    try {
        ensureDataDir();
        if (!fs.existsSync(PINS_FILE)) return [];
        const raw = fs.readFileSync(PINS_FILE, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data.map(String) : [];
    } catch (e) {
        console.error('getPinned error:', e.message);
        return [];
    }
}

function savePinned(pins) {
    try {
        ensureDataDir();
        const clean = Array.from(new Set((pins || []).filter(Boolean).map(String)));
        fs.writeFileSync(PINS_FILE, JSON.stringify(clean, null, 2), 'utf8');
        return clean;
    } catch (e) {
        console.error('savePinned error:', e.message);
        return getPinned();
    }
}

function togglePin(chatId) {
    if (!chatId) return getPinned();
    const cid = String(chatId);
    let pins = getPinned();
    if (pins.includes(cid)) {
        pins = pins.filter(id => id !== cid);
    } else {
        pins.push(cid);
    }
    return savePinned(pins);
}

function isPinned(chatId, pinnedList) {
    if (!chatId) return false;
    const list = Array.isArray(pinnedList) ? pinnedList : getPinned();
    return list.includes(String(chatId));
}

module.exports = {
    getPinned,
    savePinned,
    togglePin,
    isPinned,
};
