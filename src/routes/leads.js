/**
 * Lead capture routes
 *
 * Mount path: /api/leads
 */
const express = require('express');
const leadRepo = require('../repositories/leadRepository');

const router = express.Router();

// -----------------------------------------------------------------------------
// POST /api/leads
// -----------------------------------------------------------------------------
router.post('/', async (req, res) => {
    try {
        if (!req.tenant?.id) {
            return res.status(400).json({ success: false, error: 'tenant_required' });
        }

        const body = req.body || {};
        const email = body.email || null;
        const phone = body.phone || null;

        if (!email && !phone) {
            return res.status(400).json({
                success: false,
                error: 'contact_required',
                message: 'Email oder Telefonnummer erforderlich.'
            });
        }

        const lead = await leadRepo.createLead(req.tenant.id, body);
        if (!lead) {
            return res.status(500).json({ success: false, error: 'failed_to_create' });
        }

        res.json({ success: true, lead });
    } catch (error) {
        res.status(500).json({ success: false, error: 'failed_to_create' });
    }
});

module.exports = router;
