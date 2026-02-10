/**
 * Cart Routes
 *
 * IMPORTANT: These endpoints are called by Dify as "tools".
 * They DO NOT mutate the Shopware cart directly.
 * Instead, they enqueue cart actions for the storefront widget to execute
 * via Shopware storefront endpoints.
 *
 * Mount path: /api/cart
 */
const express = require('express');
const router = express.Router();

const { addCartAction, removeCartAction, updateCartQuantityAction, clearCartAction } = require('../services/cartTracker');
const { getCart, resolveProductIdentifier } = require('../services/shopware');
const { log } = require('../utils/logger');
const { resolveContextToken, setContextTokenHeader } = require('../utils/contextToken');

// -----------------------------------------------------------------------------
// POST /api/cart/summary
// -----------------------------------------------------------------------------
router.post('/summary', async (req, res) => {
    try {
        const { token: contextToken } = resolveContextToken(req);
        const cart = await getCart(contextToken, req.tenant);
        const responseToken = cart?.contextToken || contextToken || null;
        const { contextToken: _ct, ...cartPayload } = cart || { items: [], itemCount: 0, total: 0 };

        setContextTokenHeader(res, responseToken);
        log('CART', 'Summary', {
            token: responseToken ? `${String(responseToken).slice(0, 8)}...` : null,
            itemCount: cartPayload?.itemCount || 0,
            total: cartPayload?.total || 0
        });

        res.json({
            success: true,
            cart: cartPayload,
            context_token: responseToken
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to get cart summary'
        });
    }
});

// -----------------------------------------------------------------------------
// POST /api/cart/add
// -----------------------------------------------------------------------------
router.post('/add', async (req, res) => {
    try {
        // Dify tool payloads often use snake_case. Support both snake_case and camelCase.
        const body = req.body || {};
        const productId = body.productId || body.product_id || body.id || null;
        const productName = body.productName || body.product_name || body.name || null;
        const quantity = body.quantity;
        const userId = body.userId || body.user_id || body.user || null;

        log('CART', 'Tool /add called', { productId, productName, quantity, userId });

        if (!productId && !productName) {
            return res.status(400).json({
                success: false,
                error: 'product_id or product_name required',
                message: 'Missing product_id (or productId) and product_name'
            });
        }

        // Resolve SKU/name -> UUID for robustness
        let resolved = await resolveProductIdentifier(productId, 5, req.tenant);
        if ((!resolved.success || !resolved.product?.id) && productName) {
            // fallback: try resolve by name/label
            resolved = await resolveProductIdentifier(productName, 5, req.tenant);
        }
        if (!resolved.success || !resolved.product?.id) {
            return res.status(404).json({
                success: false,
                error: 'product_not_found',
                message: 'Produkt konnte nicht gefunden werden.',
                identifier: productId
            });
        }

        const action = addCartAction(
            resolved.product.id,
            productName || resolved.product.name || 'Produkt',
            quantity || 1,
            userId,
            req.tenant?.id
        );

        res.json({
            success: true,
            action,
            resolvedProduct: resolved.product
        });
    } catch (error) {
        log('CART', 'Add error:', error.message);
        res.status(500).json({ success: false, error: 'Failed to add item' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/cart/remove
// -----------------------------------------------------------------------------
router.post('/remove', async (req, res) => {
    try {
        const body = req.body || {};
        const lineItemId = body.lineItemId || body.line_item_id || null;
        const productId = body.productId || body.product_id || null;
        const productName = body.productName || body.product_name || null;
        const userId = body.userId || body.user_id || body.user || null;
        const { token: contextToken } = resolveContextToken(req);

        let resolvedLineItemId = lineItemId;
        let resolvedProductId = productId;

        if ((!resolvedLineItemId && !resolvedProductId) && productName) {
            const resolved = await resolveProductIdentifier(productName, 5, req.tenant);
            if (resolved?.success && resolved.product?.id) {
                resolvedProductId = resolved.product.id;
            }
        }

        if ((!resolvedLineItemId) && contextToken) {
            try {
                const cart = await getCart(contextToken, req.tenant);
                const items = Array.isArray(cart?.items) ? cart.items : [];
                if (items.length) {
                    const lowerName = String(productName || '').toLowerCase();
                    const match = items.find(i => {
                        if (resolvedProductId && (i.productId === resolvedProductId || i.id === resolvedProductId)) return true;
                        if (lowerName && String(i.name || '').toLowerCase().includes(lowerName)) return true;
                        if (lowerName && lowerName.includes(String(i.name || '').toLowerCase())) return true;
                        return false;
                    });
                    if (match) {
                        resolvedLineItemId = resolvedLineItemId || match.id || null;
                        resolvedProductId = resolvedProductId || match.productId || null;
                    }
                }
            } catch (_) {}
        }

        const action = removeCartAction(resolvedLineItemId, resolvedProductId, productName, userId, req.tenant?.id);

        res.json({ success: true, action });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to remove item' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/cart/update
// -----------------------------------------------------------------------------
router.post('/update', async (req, res) => {
    try {
        const body = req.body || {};
        const lineItemId = body.lineItemId || body.line_item_id || null;
        const productId = body.productId || body.product_id || null;
        const productName = body.productName || body.product_name || null;
        const quantity = body.quantity;
        const userId = body.userId || body.user_id || body.user || null;
        if (!lineItemId && !productId) {
            return res.status(400).json({ success: false, error: 'lineItemId or productId required' });
        }
        const action = updateCartQuantityAction(lineItemId, productId, productName, quantity, userId, req.tenant?.id);

        res.json({ success: true, action });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to update item quantity' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/cart/clear
// -----------------------------------------------------------------------------
router.post('/clear', async (req, res) => {
    try {
        const body = req.body || {};
        const userId = body.userId || body.user_id || body.user || null;
        const action = clearCartAction(userId, req.tenant?.id);

        res.json({ success: true, action });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to clear cart' });
    }
});

module.exports = router;
