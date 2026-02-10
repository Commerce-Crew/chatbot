/**
 * Customer Routes
 */
const express = require('express');
const router = express.Router();
const shopware = require('../services/shopware');
const { getCookie } = require('../utils/cookies');

/**
 * Get current customer info
 */
router.get('/', async (req, res) => {
    const cookieToken = getCookie(req, 'sw-context-token');
    const contextToken = cookieToken || req.headers['sw-context-token'] || req.query.token;
    
    const session = await shopware.verifyCustomerSession(contextToken, req.tenant);
    
    res.json({
        success: true,
        loggedIn: session.loggedIn,
        customer: session.customer || null
    });
});

module.exports = router;
