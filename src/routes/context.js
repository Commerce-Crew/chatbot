/**
 * Context Routes
 */
const express = require('express');
const router = express.Router();
const shopware = require('../services/shopware');
const { log } = require('../utils/logger');
const { resolveContextToken, setContextTokenHeader } = require('../utils/contextToken');

/**
 * Refresh context token (server-side Store API call)
 * Uses Shopware access key from tenant config (not exposed to browser)
 * Forwards browser cookies to Shopware to preserve login state
 */
router.post('/refresh', async (req, res) => {
    try {
        const { token: contextToken, cookieToken } = resolveContextToken(req);
        const cookieHeader = req.headers.cookie || '';

        if (cookieToken) {
            setContextTokenHeader(res, cookieToken);
            log('CONTEXT', 'Refresh (cookie)', {
                token: cookieToken ? `${String(cookieToken).slice(0, 8)}...` : null
            });
            return res.json({
                success: true,
                status: 200,
                context_token: cookieToken
            });
        }

        const result = await shopware.refreshContextToken(contextToken, cookieHeader, req.tenant);
        const token = result.token || contextToken || null;

        setContextTokenHeader(res, token);

        log('CONTEXT', 'Refresh', {
            status: result.status,
            token: token ? `${String(token).slice(0, 8)}...` : null,
            success: result.success,
            cookiePresent: !!cookieHeader
        });

        res.json({
            success: result.success,
            status: result.status,
            context_token: token
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to refresh context token' });
    }
});

module.exports = router;
