/**
 * File Upload Routes
 * Note: Files are now sent as base64 in the chat request
 * This endpoint is kept for compatibility
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { log } = require('../utils/logger');
const config = require('../config');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSize }
});

router.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    log('FILES', `Received: ${req.file.originalname} (${req.file.size} bytes)`);
    
    // Convert to base64 for frontend to use
    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    
    res.json({
        success: true,
        id: 'inline-' + Date.now(),
        name: req.file.originalname,
        type: req.file.mimetype,
        size: req.file.size,
        base64
    });
});

module.exports = router;
