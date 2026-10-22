'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.WA_DATA_DIR || path.join(__dirname, '..', 'data');
const ARCHIVES_FILE = path.join(DATA_DIR, 'archived_chats.json');

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

function getArchived() {
    try {
        ensureDataDir();
        if (!fs.existsSync(ARCHIVES_FILE)) return [];
        const raw = fs.readFileSync(ARCHIVES_FILE, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data)
            ? Array.from(new Set(data.filter(Boolean).map(String)))
            : [];
    } catch (e) {
        console.error('getArchived error:', e.message);
        return [];
    }
}

function saveArchived(list) {
    try {
        ensureDataDir();
        const clean = Array.from(new Set((list || []).filter(Boolean).map(String)));
        const tmpFile = ARCHIVES_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(clean, null, 2), 'utf8');
        fs.renameSync(tmpFile, ARCHIVES_FILE);
        return clean;
    } catch (e) {
        console.error('saveArchived error:', e.message);
        try { fs.unlinkSync(ARCHIVES_FILE + '.tmp'); } catch (_) { }
        return getArchived();
    }
}

function setArchived(chatId, archived) {
    if (!chatId) return getArchived();
    const cid = String(chatId);
    let archivedIds = getArchived();
    const shouldArchive = archived === undefined ? true : !!archived;
    if (shouldArchive) {
        if (!archivedIds.includes(cid)) archivedIds.push(cid);
    } else {
        archivedIds = archivedIds.filter(id => id !== cid);
    }
    return saveArchived(archivedIds);
}

function isArchived(chatId, archivedList) {
    if (!chatId) return false;
    const list = Array.isArray(archivedList) ? archivedList : getArchived();
    return list.includes(String(chatId));
}

module.exports = {
    getArchived,
    saveArchived,
    setArchived,
    isArchived,
};
