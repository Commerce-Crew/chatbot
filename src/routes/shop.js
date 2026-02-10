/**
 * Shop info routes
 *
 * Mount path: /api/shop
 */
const express = require('express');
const shopware = require('../services/shopware');
const { resolveContextToken } = require('../utils/contextToken');

const router = express.Router();

function resolveLanguageId(req) {
    return (
        req.headers['sw-language-id'] ||
        req.headers['x-cc-language-id'] ||
        req.body?.language_id ||
        req.body?.languageId ||
        null
    );
}

// -----------------------------------------------------------------------------
// POST /api/shop/info
// -----------------------------------------------------------------------------
router.post('/info', async (req, res) => {
    try {
        const { token: contextToken } = resolveContextToken(req);
        const languageId = resolveLanguageId(req);

        const [shippingMethods, paymentMethods] = await Promise.all([
            shopware.getShippingMethods(contextToken, req.tenant, languageId),
            shopware.getPaymentMethods(contextToken, req.tenant, languageId)
        ]);

        res.json({
            success: true,
            shippingMethods,
            paymentMethods
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load shop info' });
    }
});

module.exports = router;
