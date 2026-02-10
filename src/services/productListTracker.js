/**
 * Product List Tracker (from Dify text output)
 *
 * Stores the last parsed product list per user+tenant so numeric replies
 * can be mapped deterministically.
 */
const TTL_MS = 10 * 60 * 1000; // 10 minutes

const listStore = new Map(); // key -> { items, meta, createdAt }
const pendingStore = new Map(); // key -> { productId, productName, quantity, createdAt }

function now() {
    return Date.now();
}

function normalizeUserId(userId) {
    const uid = String(userId || '').trim();
    return uid || 'anonymous';
}

function tenantKey(tenantId) {
    return tenantId ? `t${tenantId}` : 'default';
}

function key(tenantId, userId) {
    return `${tenantKey(tenantId)}:${normalizeUserId(userId)}`;
}

function isExpired(entry) {
    return !entry || (now() - (entry.createdAt || 0)) > TTL_MS;
}

function storeList(tenantId, userId, items, meta = {}) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const k = key(tenantId, userId);
    listStore.set(k, { items, meta: meta || {}, createdAt: now() });
    // New list -> clear any pending confirmation
    pendingStore.delete(k);
    return items;
}

function getList(tenantId, userId) {
    const k = key(tenantId, userId);
    const entry = listStore.get(k);
    if (isExpired(entry)) {
        listStore.delete(k);
        return null;
    }
    return entry;
}

function clearList(tenantId, userId) {
    listStore.delete(key(tenantId, userId));
}

function setPending(tenantId, userId, pending) {
    if (!pending || !pending.productId) return null;
    const k = key(tenantId, userId);
    pendingStore.set(k, { ...pending, createdAt: now() });
    return pending;
}

function getPending(tenantId, userId) {
    const k = key(tenantId, userId);
    const entry = pendingStore.get(k);
    if (isExpired(entry)) {
        pendingStore.delete(k);
        return null;
    }
    return entry;
}

function clearPending(tenantId, userId) {
    pendingStore.delete(key(tenantId, userId));
}

// Periodic cleanup
setInterval(() => {
    for (const [k, v] of listStore.entries()) {
        if (isExpired(v)) listStore.delete(k);
    }
    for (const [k, v] of pendingStore.entries()) {
        if (isExpired(v)) pendingStore.delete(k);
    }
}, 60 * 1000);

module.exports = {
    storeList,
    getList,
    clearList,
    setPending,
    getPending,
    clearPending
};
