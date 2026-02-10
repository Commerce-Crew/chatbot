/**
 * Category Routes
 */
const express = require('express');
const router = express.Router();
const shopware = require('../services/shopware');

router.get('/', async (req, res) => {
    const limit = parseInt(req.query.limit || 50, 10);
    const categories = await shopware.getCategories(limit, req.tenant);
    
    res.json({
        success: true,
        categories,
        count: categories.length
    });
});

module.exports = router;
