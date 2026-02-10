/**
 * Cart Action Tracker (FIFO)
 *
 * - Stores pending cart actions per userId (queue)
 * - Supports multiple actions (reorder flows)
 * - TTL + bounded queue sizes for scalability
 */
const { log } = require('../utils/logger');

const ACTION_TTL_MS = 2 * 60 * 1000; // 2 minutes
const MAX_QUEUE_PER_USER = 25;

const actionQueues = new Map(); // tenantKey:userId -> { actions: [], updatedAt }
const LATEST_KEY = '__latest__';

function now() {
    return Date.now();
}

function normalizeUserId(userId) {
    return (userId && String(userId).trim()) ? String(userId).trim() : null;
}

function cleanupQueue(q) {
    const ts = now();
    const actions = (q?.actions || []).filter(a => a && (ts - (a.timestamp || ts)) < ACTION_TTL_MS);
    return { actions, updatedAt: q?.updatedAt || ts };
}

function tenantKey(tenantId) {
    return tenantId ? `t${tenantId}` : 'default';
}

function queueKey(tenantId, userId) {
    return `${tenantKey(tenantId)}:${userId || LATEST_KEY}`;
}

function getQueue(tenantId, userId) {
    const key = queueKey(tenantId, userId);
    const existing = actionQueues.get(key) || { actions: [], updatedAt: now() };
    const cleaned = cleanupQueue(existing);
    actionQueues.set(key, cleaned);
    return cleaned;
}

function setOrDeleteQueue(key, queue) {
    if (!queue || !Array.isArray(queue.actions) || !queue.actions.length) {
        actionQueues.delete(key);
        return;
    }
    actionQueues.set(key, queue);
}

function pruneLatestMirrorsForUser(tenantId, userId) {
    if (!userId) return;
    const latestKey = queueKey(tenantId, null);
    const latest = actionQueues.get(latestKey);
    if (!latest) return;
    const cleaned = cleanupQueue(latest);
    cleaned.actions = cleaned.actions.filter(a => a?.userId !== userId);
    cleaned.updatedAt = now();
    setOrDeleteQueue(latestKey, cleaned);
}

function consumeLatestActions(tenantId, predicate = null) {
    const latestKey = queueKey(tenantId, null);
    const latest = actionQueues.get(latestKey);
    if (!latest) return [];

    const cleaned = cleanupQueue(latest);
    if (!cleaned.actions.length) {
        actionQueues.delete(latestKey);
        return [];
    }

    if (typeof predicate !== 'function') {
        const actions = cleaned.actions;
        actionQueues.delete(latestKey);
        return actions;
    }

    const selected = [];
    const remaining = [];
    for (const action of cleaned.actions) {
        if (predicate(action)) selected.push(action);
        else remaining.push(action);
    }

    cleaned.actions = remaining;
    cleaned.updatedAt = now();
    setOrDeleteQueue(latestKey, cleaned);
    return selected;
}

function enqueueMirroredAction(tenantId, userId, action) {
    const uid = normalizeUserId(userId);
    if (uid) {
        enqueueAction(tenantId, uid, action);
        enqueueAction(tenantId, null, { ...action, userId: uid });
        return;
    }
    enqueueAction(tenantId, null, { ...action, userId: null });
}

function enqueueAction(tenantId, userId, action) {
    const key = queueKey(tenantId, userId);
    const q = getQueue(tenantId, userId);
    q.actions.push(action);

    // Bound memory growth
    if (q.actions.length > MAX_QUEUE_PER_USER) {
        q.actions = q.actions.slice(-MAX_QUEUE_PER_USER);
    }

    q.updatedAt = now();
    actionQueues.set(key, q);
    return action;
}

function enqueueMany(userId, actions, tenantId = null) {
    if (!Array.isArray(actions) || actions.length === 0) return [];
    const queued = [];
    for (const a of actions) {
        if (!a || typeof a !== 'object') continue;
        queued.push(enqueueAction(tenantId, userId, {
            ...a,
            timestamp: a.timestamp || now()
        }));
    }
    return queued;
}

// -----------------------------------------------------------------------------
// Public API (used by tool endpoints)
// -----------------------------------------------------------------------------
function addCartAction(productId, productName, quantity, userId, tenantId = null) {
    const uid = normalizeUserId(userId);
    const action = {
        type: 'add',
        productId,
        productName: productName || 'Produkt',
        quantity: parseInt(quantity, 10) || 1,
        timestamp: now()
    };

    enqueueMirroredAction(tenantId, uid, action);

    log('CART', `Queued(add): ${action.productName} x${action.quantity} for ${uid || 'unknown'} (tenant=${tenantId || 'default'})`);
    return action;
}

function clearCartAction(userId, tenantId = null) {
    const uid = normalizeUserId(userId);
    const action = { type: 'clear', timestamp: now() };

    enqueueMirroredAction(tenantId, uid, action);

    log('CART', `Queued(clear) for ${uid || 'unknown'} (tenant=${tenantId || 'default'})`);
    return action;
}

function removeCartAction(lineItemId, productId, productName, userId, tenantId = null) {
    const uid = normalizeUserId(userId);
    const action = {
        type: 'remove',
        lineItemId: lineItemId || null,
        productId: productId || null,
        productName: productName || 'Artikel',
        timestamp: now()
    };

    enqueueMirroredAction(tenantId, uid, action);

    log('CART', `Queued(remove): ${action.productName} for ${uid || 'unknown'} (tenant=${tenantId || 'default'})`);
    return action;
}

function updateCartQuantityAction(lineItemId, productId, productName, quantity, userId, tenantId = null) {
    const uid = normalizeUserId(userId);
    const action = {
        type: 'update',
        lineItemId: lineItemId || null,
        productId: productId || null,
        productName: productName || 'Artikel',
        quantity: parseInt(quantity, 10) || 1,
        timestamp: now()
    };

    enqueueMirroredAction(tenantId, uid, action);

    log('CART', `Queued(update): ${action.productName} -> x${action.quantity} for ${uid || 'unknown'} (tenant=${tenantId || 'default'})`);
    return action;
}

/**
 * Get and consume pending cart actions (FIFO)
 */
function getCartActions(userId, tenantId = null) {
    const uid = normalizeUserId(userId);
    const userQueue = uid ? getQueue(tenantId, uid) : null;

    let actions = [];
    if (userQueue && userQueue.actions.length) {
        actions = userQueue.actions;
        actionQueues.delete(queueKey(tenantId, uid));
        pruneLatestMirrorsForUser(tenantId, uid);
        return actions;
    }

    // fallback: consume only matching latest actions for this user.
    if (uid) {
        actions = consumeLatestActions(tenantId, action => !action?.userId || action.userId === uid);
        if (actions.length) {
            return actions;
        }
        // last-resort compatibility fallback: consume latest regardless of user id.
        // this keeps cart actions working when tool calls omit/mismatch userId.
        actions = consumeLatestActions(tenantId);
        if (actions.length) {
            return actions;
        }
    } else {
        actions = consumeLatestActions(tenantId);
        if (actions.length) {
            return actions;
        }
    }

    return [];
}

/**
 * Backwards compatible (returns first action if any)
 */
function getCartAction(userId, tenantId = null) {
    const actions = getCartActions(userId, tenantId);
    return actions.length ? actions[0] : null;
}

/**
 * Parse cart action from assistant response text (legacy fallback)
 */
function parseCartActionFromText(text) {
    if (!text || typeof text !== 'string') return null;

    // Pattern: [ADD_TO_CART:productId:productName:quantity]
    const addMatch = text.match(/\[ADD_TO_CART:([a-f0-9]{32}):([^:]+):(\d+)\]/i);
    if (addMatch) {
        return {
            type: 'add',
            productId: addMatch[1],
            productName: addMatch[2],
            quantity: parseInt(addMatch[3], 10) || 1
        };
    }

    // Pattern: [CLEAR_CART]
    if (/\[CLEAR_CART\]/i.test(text)) {
        return { type: 'clear' };
    }

    // Pattern: [REMOVE_FROM_CART:lineItemId:productName]
    const removeMatch = text.match(/\[REMOVE_FROM_CART:([a-f0-9]{32}):([^\]]+)\]/i);
    if (removeMatch) {
        return {
            type: 'remove',
            lineItemId: removeMatch[1],
            productName: removeMatch[2]
        };
    }

    // Pattern: [UPDATE_CART_QTY:lineItemId:productName:quantity]
    const updateMatch = text.match(/\[UPDATE_CART_QTY:([a-f0-9]{32}):([^:]+):(\d+)\]/i);
    if (updateMatch) {
        return {
            type: 'update',
            lineItemId: updateMatch[1],
            productName: updateMatch[2],
            quantity: parseInt(updateMatch[3], 10) || 1
        };
    }

    return null;
}

// Cleanup old actions periodically
setInterval(() => {
    const ts = now();
    for (const [key, q] of actionQueues.entries()) {
        const cleaned = cleanupQueue(q);
        if (!cleaned.actions.length) {
            actionQueues.delete(key);
            continue;
        }
        if (ts - cleaned.updatedAt > ACTION_TTL_MS) {
            actionQueues.delete(key);
            continue;
        }
        actionQueues.set(key, cleaned);
    }
}, 60 * 1000);

module.exports = {
    addCartAction,
    clearCartAction,
    removeCartAction,
    updateCartQuantityAction,
    getCartAction,
    getCartActions,
    parseCartActionFromText,
    enqueueMany
};
