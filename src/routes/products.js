/**
 * Products Routes
 *
 * Mount path: /api/products
 *
 * Used both by:
 *  - Dify tool calls (search/product details)
 *  - Storefront widget multimodal pipeline (image -> extract -> search -> confirm)
 */
const express = require('express');
const router = express.Router();

const { searchProducts, getProduct, resolveProductIdentifier } = require('../services/shopware');
const dify = require('../services/dify');
const { createSelection, consumeSelection } = require('../services/selectionTracker');
const { addCartAction } = require('../services/cartTracker');
const { log } = require('../utils/logger');

// -----------------------------------------------------------------------------
// POST /api/products/search
// -----------------------------------------------------------------------------
router.post('/search', async (req, res) => {
    const { query, limit } = req.body || {};
    const products = await searchProducts(query, limit || 10, req.tenant);

    res.json({
        success: true,
        query,
        count: products.length,
        products
    });
});

// -----------------------------------------------------------------------------
// POST /api/products/get
// -----------------------------------------------------------------------------
router.post('/get', async (req, res) => {
    const { productId } = req.body || {};
    if (!productId) return res.status(400).json({ success: false, error: 'productId required' });

    const product = await getProduct(productId, req.tenant);
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

    res.json({ success: true, product });
});

// -----------------------------------------------------------------------------
// POST /api/products/compare
// Compare multiple products (IDs, SKUs, or names)
// -----------------------------------------------------------------------------
router.post('/compare', async (req, res) => {
    const body = req.body || {};
    const identifiers = body.productIds || body.product_ids || body.identifiers || body.ids || [];
    const list = Array.isArray(identifiers) ? identifiers : [identifiers];
    const unique = [...new Set(list.map(v => String(v || '').trim()).filter(Boolean))];

    if (!unique.length) {
        return res.status(400).json({
            success: false,
            error: 'identifiers_required',
            message: 'Provide at least one product identifier.'
        });
    }

    const results = await Promise.all(unique.map(async (identifier) => {
        const resolved = await resolveProductIdentifier(identifier, 5, req.tenant);
        if (!resolved.success || !resolved.product?.id) {
            return { success: false, identifier, error: resolved.error || 'not_found' };
        }
        const product = await getProduct(resolved.product.id, req.tenant);
        if (!product) {
            return { success: false, identifier, error: 'not_found' };
        }
        return { success: true, identifier, product };
    }));

    res.json({
        success: true,
        count: results.filter(r => r.success).length,
        results
    });
});

// -----------------------------------------------------------------------------
// POST /api/products/resolve
// Resolve SKU/name -> UUID + return candidates
// -----------------------------------------------------------------------------
router.post('/resolve', async (req, res) => {
    const identifier = req.body.identifier || req.body.query || req.body.productId || '';
    const limit = parseInt(req.body.limit, 10) || 5;

    const resolved = await resolveProductIdentifier(identifier, limit, req.tenant);
    if (!resolved.success) {
        return res.status(404).json({
            success: false,
            error: resolved.error || 'not_found',
            identifier
        });
    }

    res.json({
        success: true,
        identifier,
        product: resolved.product,
        candidates: resolved.candidates || []
    });
});

// -----------------------------------------------------------------------------
// POST /api/products/from-image
// Middleware multimodal pipeline: image -> extract -> search top3 -> return suggestions
// -----------------------------------------------------------------------------
router.post('/from-image', async (req, res) => {
    try {
        const userId = req.body.userId || req.body.user_id || 'anonymous';
        const message = req.body.message || '';
        const image = req.body.image || null;

        if (!image) {
            return res.status(400).json({ success: false, error: 'image_required' });
        }

        const extracted = await dify.extractProductQueryFromImage(image, userId, message, req.tenant);
        const query = (extracted.query || '').trim();

        if (!query) {
            return res.json({
                success: false,
                error: 'no_query',
                message: 'Kein Produkt im Bild erkannt.',
                extracted
            });
        }

        const suggestions = await searchProducts(query, 3, req.tenant, { reason: 'from_image' });
        if (!suggestions.length) {
            return res.json({
                success: false,
                error: 'no_matches',
                message: 'Keine passenden Produkte gefunden.',
                query
            });
        }

        const selectionId = createSelection(userId, query, extracted.quantity || 1, suggestions, req.tenant?.id);

        res.json({
            success: true,
            selection_id: selectionId,
            query,
            quantity: extracted.quantity || 1,
            confidence: extracted.confidence,
            suggestions
        });
    } catch (e) {
        log('PRODUCTS', 'from-image error:', e.message);
        res.status(500).json({ success: false, error: 'failed' });
    }
});

// -----------------------------------------------------------------------------
// POST /api/products/confirm
// Confirm one of the suggested matches -> enqueue add-to-cart action
// -----------------------------------------------------------------------------
router.post('/confirm', async (req, res) => {
    try {
        const userId = req.body.userId || req.body.user_id || 'anonymous';
        const selectionId = req.body.selection_id || req.body.selectionId;
        const productId = req.body.product_id || req.body.productId;
        const requestedQty = req.body.quantity;

        if (!selectionId || !productId) {
            return res.status(400).json({
                success: false,
                error: 'selection_id and product_id required'
            });
        }

        const selection = consumeSelection(selectionId, userId, req.tenant?.id);
        if (!selection) {
            return res.status(404).json({
                success: false,
                error: 'selection_not_found',
                message: 'Auswahl ist abgelaufen. Bitte erneut versuchen.'
            });
        }

        const suggestions = Array.isArray(selection.suggestions) ? selection.suggestions : [];
        const chosen = suggestions.find(s => s.id === productId) || null;

        if (!chosen) {
            return res.status(400).json({
                success: false,
                error: 'invalid_product',
                message: 'Produkt passt nicht zur Auswahl.'
            });
        }

        const qty = parseInt(requestedQty, 10) || selection.quantity || 1;
        const action = addCartAction(chosen.id, chosen.name, qty, userId, req.tenant?.id);

        res.json({
            success: true,
            action,
            product: chosen
        });
    } catch (e) {
        log('PRODUCTS', 'confirm error:', e.message);
        res.status(500).json({ success: false, error: 'failed' });
    }
});

module.exports = router;
