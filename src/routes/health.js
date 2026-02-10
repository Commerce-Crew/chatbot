/**
 * Health Route
 *
 * Simple health endpoint to verify the middleware is reachable.
 */

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
    res.json({
        status: 'ok',
        version: '5.3.0',
        service: 'dentalkiosk-chatbot-middleware',
        timestamp: new Date().toISOString(),
        requestId: req.requestId || null
    });
});

module.exports = router;
