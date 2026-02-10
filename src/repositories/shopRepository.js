const db = require('../db');

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key -> { value, expiresAt }

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }
    return entry.value;
}

function cacheSet(key, value, ttlMs = CACHE_TTL_MS) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
}

function cacheClear() {
    cache.clear();
}

async function getShopById(tenantId, shopId) {
    if (!tenantId || !shopId) return null;
    const cacheKey = `id:${tenantId}:${shopId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const result = await db.query(
        `
        SELECT *
        FROM tenant_shops
        WHERE tenant_id = $1 AND shop_id = $2 AND active = TRUE
        LIMIT 1
        `,
        [tenantId, shopId]
    );
    const row = result.rows[0] || null;
    if (row) cacheSet(cacheKey, row);
    return row;
}

async function getShopByOrigin(tenantId, origin) {
    if (!tenantId || !origin) return null;
    const cacheKey = `origin:${tenantId}:${origin}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const result = await db.query(
        `
        SELECT *
        FROM tenant_shops
        WHERE tenant_id = $1
          AND active = TRUE
          AND $2 = ANY(allowed_origins)
        LIMIT 1
        `,
        [tenantId, origin]
    );
    const row = result.rows[0] || null;
    if (row) cacheSet(cacheKey, row);
    return row;
}

async function listShops(tenantId) {
    const params = [];
    let where = '';
    if (tenantId) {
        params.push(tenantId);
        where = 'WHERE tenant_id = $1';
    }
    const result = await db.query(
        `
        SELECT *
        FROM tenant_shops
        ${where}
        ORDER BY tenant_id ASC, id ASC
        `,
        params
    );
    return result.rows || [];
}

async function createShop({
    tenantId,
    shopId,
    name,
    shopwareUrl,
    shopwareAccessKey,
    allowedOrigins,
    active,
    difyUrl,
    difyApiKey,
    difyAgentId,
    difyInstructions,
    difyInputs,
    modelConfig
}) {
    const result = await db.query(
        `
        INSERT INTO tenant_shops
            (tenant_id, shop_id, name, shopware_url, shopware_access_key, dify_url, dify_api_key,
             dify_agent_id, dify_instructions, dify_inputs, model_config, allowed_origins, active)
        VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id
        `,
        [
            tenantId,
            shopId,
            name || null,
            shopwareUrl,
            shopwareAccessKey,
            difyUrl || null,
            difyApiKey || null,
            difyAgentId || null,
            difyInstructions || null,
            difyInputs || null,
            modelConfig || null,
            allowedOrigins || [],
            active !== false
        ]
    );
    cacheClear();
    return result.rows[0]?.id || null;
}

async function updateShop(id, {
    tenantId,
    shopId,
    name,
    shopwareUrl,
    shopwareAccessKey,
    allowedOrigins,
    active,
    difyUrl,
    difyApiKey,
    difyAgentId,
    difyInstructions,
    difyInputs,
    modelConfig
}) {
    await db.query(
        `
        UPDATE tenant_shops
        SET tenant_id=$1, shop_id=$2, name=$3, shopware_url=$4, shopware_access_key=$5,
            dify_url=$6, dify_api_key=$7, dify_agent_id=$8, dify_instructions=$9,
            dify_inputs=$10, model_config=$11, allowed_origins=$12, active=$13
        WHERE id=$14
        `,
        [
            tenantId,
            shopId,
            name || null,
            shopwareUrl,
            shopwareAccessKey,
            difyUrl || null,
            difyApiKey || null,
            difyAgentId || null,
            difyInstructions || null,
            difyInputs || null,
            modelConfig || null,
            allowedOrigins || [],
            active !== false,
            id
        ]
    );
    cacheClear();
}

async function getShopByDbId(id) {
    const result = await db.query(
        `
        SELECT *
        FROM tenant_shops
        WHERE id = $1
        LIMIT 1
        `,
        [id]
    );
    return result.rows[0] || null;
}

module.exports = {
    getShopById,
    getShopByOrigin,
    listShops,
    createShop,
    updateShop,
    getShopByDbId
};
