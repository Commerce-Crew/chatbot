/**
 * Lead repository (Postgres)
 */
const db = require('../db');

function normalizeString(value, maxLen = 500) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (!str) return null;
    return str.length > maxLen ? str.slice(0, maxLen) : str;
}

async function createLead(tenantId, lead) {
    const payload = lead || {};
    const fields = {
        session_id: normalizeString(payload.sessionId || payload.session_id, 200),
        name: normalizeString(payload.name, 200),
        email: normalizeString(payload.email, 200),
        phone: normalizeString(payload.phone, 50),
        message: normalizeString(payload.message, 2000),
        product_id: normalizeString(payload.productId || payload.product_id, 100),
        product_name: normalizeString(payload.productName || payload.product_name, 200),
        source: normalizeString(payload.source, 100),
        metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : null
    };

    const result = await db.query(
        `
        INSERT INTO leads
            (tenant_id, session_id, name, email, phone, message, product_id, product_name, source, metadata)
        VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, tenant_id, session_id, name, email, phone, message, product_id, product_name, source, metadata, created_at
        `,
        [
            tenantId,
            fields.session_id,
            fields.name,
            fields.email,
            fields.phone,
            fields.message,
            fields.product_id,
            fields.product_name,
            fields.source,
            fields.metadata
        ]
    );

    return result.rows[0] || null;
}

async function listLeads(tenantId, limit = 100, offset = 0) {
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
    const off = Math.max(0, parseInt(offset, 10) || 0);
    const result = await db.query(
        `
        SELECT id, tenant_id, session_id, name, email, phone, message, product_id,
               product_name, source, metadata, created_at
        FROM leads
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
        `,
        [tenantId, lim, off]
    );

    return result.rows || [];
}

async function countLeads(tenantId) {
    const result = await db.query(
        `
        SELECT COUNT(*)::int AS count
        FROM leads
        WHERE tenant_id = $1
        `,
        [tenantId]
    );
    return result.rows[0]?.count || 0;
}

module.exports = {
    createLead,
    listLeads,
    countLeads
};
