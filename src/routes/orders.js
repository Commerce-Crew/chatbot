/**
 * Orders Routes (Store API)
 *
 * - Reading orders requires customer login (sw-context-token)
 * - Reorder endpoints enqueue cart actions for the storefront widget
 *
 * Mount path: /api/orders
 */
const express = require('express');
const router = express.Router();

const { getOrders, getLastOrder, getOrderByNumber } = require('../services/shopware');
const { addCartAction, clearCartAction } = require('../services/cartTracker');
const { log } = require('../utils/logger');
const { resolveContextToken } = require('../utils/contextToken');

// -----------------------------------------------------------------------------
// POST /api/orders
// -----------------------------------------------------------------------------
router.post('/', async (req, res) => {
    const { token: contextToken } = resolveContextToken(req);
    const limit = parseInt(req.body.limit, 10) || 5;

    const result = await getOrders(contextToken, limit, req.tenant);
    res.json(result);
});

// -----------------------------------------------------------------------------
// POST /api/orders/last
// -----------------------------------------------------------------------------
router.post('/last', async (req, res) => {
    const { token: contextToken } = resolveContextToken(req);

    const order = await getLastOrder(contextToken, req.tenant);
    if (!order) {
        return res.status(404).json({
            success: false,
            error: 'not_found',
            message: 'Keine letzte Bestellung gefunden (bitte eingeloggt?).'
        });
    }

    res.json({ success: true, order });
});

// -----------------------------------------------------------------------------
// POST /api/orders/by-number
// -----------------------------------------------------------------------------
router.post('/by-number', async (req, res) => {
    const { token: contextToken } = resolveContextToken(req);
    const orderNumber = req.body.orderNumber || req.body.order_number || '';

    const order = await getOrderByNumber(contextToken, orderNumber, 25, req.tenant);
    if (!order) {
        return res.status(404).json({
            success: false,
            error: 'not_found',
            message: `Bestellung ${orderNumber} nicht gefunden.`
        });
    }

    res.json({ success: true, order });
});

// -----------------------------------------------------------------------------
// POST /api/orders/tracking
// -----------------------------------------------------------------------------
router.post('/tracking', async (req, res) => {
    const { token: contextToken } = resolveContextToken(req);
    const orderNumber = (req.body.orderNumber || req.body.order_number || '').toString().trim();

    let order = null;
    if (orderNumber) {
        order = await getOrderByNumber(contextToken, orderNumber, 25, req.tenant);
    } else {
        order = await getLastOrder(contextToken, req.tenant);
    }

    if (!order) {
        return res.status(404).json({
            success: false,
            error: 'not_found',
            message: orderNumber
                ? `Bestellung ${orderNumber} nicht gefunden (oder nicht eingeloggt).`
                : 'Keine letzte Bestellung gefunden (bitte eingeloggt?).'
        });
    }

    const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];
    const trackingCodes = deliveries.flatMap(d => Array.isArray(d.trackingCodes) ? d.trackingCodes : []);

    res.json({
        success: true,
        orderNumber: order.orderNumber,
        deliveries,
        trackingCodes
    });
});

// -----------------------------------------------------------------------------
// POST /api/orders/reorder
// Stronger reorder logic: select by orderNumber if provided
// -----------------------------------------------------------------------------
router.post('/reorder', async (req, res) => {
    const { token: contextToken } = resolveContextToken(req);
    const userId = req.body.userId || req.body.user_id || null;

    const orderNumber = (req.body.orderNumber || req.body.order_number || '').toString().trim();
    const clearFirst = !!req.body.clearFirst || !!req.body.clear_first;

    let order = null;
    if (orderNumber) {
        order = await getOrderByNumber(contextToken, orderNumber, 25, req.tenant);
    } else {
        order = await getLastOrder(contextToken, req.tenant);
    }

    if (!order) {
        return res.status(404).json({
            success: false,
            error: 'not_found',
            message: orderNumber
                ? `Bestellung ${orderNumber} nicht gefunden (oder nicht eingeloggt).`
                : 'Keine letzte Bestellung gefunden (bitte eingeloggt?).'
        });
    }

    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
        return res.json({
            success: false,
            error: 'empty_order',
            message: 'Diese Bestellung enthält keine Artikel.',
            orderNumber: order.orderNumber
        });
    }

    const actions = [];
    if (clearFirst) {
        actions.push(clearCartAction(userId, req.tenant?.id));
    }

    for (const item of items) {
        if (!item) continue;
        // only reorder product line items that have a productId
        const pid = item.productId;
        if (!pid || !/^[a-f0-9]{32}$/i.test(pid)) {
            log('ORDERS', `Skipping reorder item without productId: ${item.name}`);
            continue;
        }
        actions.push(addCartAction(pid, item.name, item.quantity || 1, userId, req.tenant?.id));
    }

    res.json({
        success: true,
        orderNumber: order.orderNumber,
        itemCount: actions.filter(a => a.type === 'add').length,
        actions
    });
});

module.exports = router;
