/**
 * Selection Tracker (for multimodal product suggestions)
 *
 * Stores "top-3 matches" for a limited time and allows confirmation.
 */
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_SELECTIONS = 2000;

const selections = new Map(); // selectionId -> { tenantId, userId, query, quantity, suggestions, createdAt }

function now() {
    return Date.now();
}

function normalizeUserId(userId) {
    return (userId && String(userId).trim()) ? String(userId).trim() : 'anonymous';
}

function cleanup() {
    const ts = now();
    for (const [id, item] of selections.entries()) {
        if (!item || (ts - (item.createdAt || ts)) > TTL_MS) {
            selections.delete(id);
        }
    }
    // bound memory
    if (selections.size > MAX_SELECTIONS) {
        const sorted = Array.from(selections.entries())
            .sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
        const drop = sorted.slice(0, Math.ceil(selections.size * 0.25));
        for (const [id] of drop) selections.delete(id);
    }
}

function createSelection(userId, query, quantity, suggestions, tenantId = null) {
    cleanup();
    const selectionId = crypto.randomUUID();
    selections.set(selectionId, {
        tenantId: tenantId || null,
        userId: normalizeUserId(userId),
        query: query || '',
        quantity: parseInt(quantity, 10) || 1,
        suggestions: Array.isArray(suggestions) ? suggestions.slice(0, 3) : [],
        createdAt: now()
    });
    return selectionId;
}

function getSelection(selectionId) {
    cleanup();
    return selections.get(selectionId) || null;
}

function consumeSelection(selectionId, userId, tenantId = null) {
    cleanup();
    const item = selections.get(selectionId);
    if (!item) return null;

    const uid = normalizeUserId(userId);
    if (item.userId && uid && item.userId !== uid) {
        return null;
    }
    if (item.tenantId && tenantId && item.tenantId !== tenantId) {
        return null;
    }

    selections.delete(selectionId);
    return item;
}

setInterval(cleanup, 60 * 1000);

module.exports = {
    createSelection,
    getSelection,
    consumeSelection
};
