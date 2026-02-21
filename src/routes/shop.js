/**
 * Shop info routes
 *
 * Mount path: /api/shop
 */
const express = require('express');
const shopware = require('../services/shopware');
const googlePlaces = require('../services/googlePlaces');
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
// Body may include google_place_id to fetch opening hours from Google Places.
// -----------------------------------------------------------------------------
router.post('/info', async (req, res) => {
    try {
        const { token: contextToken } = resolveContextToken(req);
        const languageId = resolveLanguageId(req);
        const googlePlaceId = req.body?.google_place_id ? String(req.body.google_place_id).trim() : null;

        const [shippingMethods, paymentMethods, openingHoursFromGoogle] = await Promise.all([
            shopware.getShippingMethods(contextToken, req.tenant, languageId),
            shopware.getPaymentMethods(contextToken, req.tenant, languageId),
            googlePlaceId ? googlePlaces.fetchOpeningHours(googlePlaceId, req.tenant) : Promise.resolve('')
        ]);

        const payload = {
            success: true,
            shippingMethods,
            paymentMethods
        };
        if (openingHoursFromGoogle) {
            payload.openingHours = openingHoursFromGoogle;
        }

        res.json(payload);
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load shop info' });
    }
});

module.exports = router;
