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

async function getTenantByApiKey(apiKey) {
    if (!apiKey) return null;
    const cacheKey = `api:${apiKey}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const result = await db.query(
        `
        SELECT
            t.id,
            t.name,
            t.slug,
            t.subdomain,
            t.api_key,
            t.allowed_origins,
            t.active,
            s.dify_url,
            s.dify_api_key,
            s.dify_agent_id,
            s.dify_instructions,
            s.dify_inputs,
            s.model_config,
            s.shopware_url,
            s.shopware_access_key
        FROM tenants t
        JOIN tenant_settings s ON s.tenant_id = t.id
        WHERE t.active = TRUE
          AND t.api_key = $1
        LIMIT 1
        `,
        [apiKey]
    );

    const row = result.rows[0] || null;
    if (row) cacheSet(cacheKey, row);
    return row;
}

async function getTenantByOrigin(origin) {
    if (!origin) return null;
    const cacheKey = `origin:${origin}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
    const result = await db.query(
        `
        SELECT
            t.id,
            t.name,
            t.slug,
            t.subdomain,
            t.api_key,
            t.allowed_origins,
            t.active,
            s.dify_url,
            s.dify_api_key,
            s.dify_agent_id,
            s.dify_instructions,
            s.dify_inputs,
            s.model_config,
            s.shopware_url,
            s.shopware_access_key
        FROM tenants t
        JOIN tenant_settings s ON s.tenant_id = t.id
        WHERE t.active = TRUE
          AND $1 = ANY(t.allowed_origins)
        LIMIT 1
        `,
        [origin]
    );

    const row = result.rows[0] || null;
    if (row) cacheSet(cacheKey, row);
    return row;
}

async function listTenantsWithUsage() {
    const result = await db.query(
        `
        SELECT
            t.id,
            t.name,
            t.slug,
            t.subdomain,
            t.api_key,
            COALESCE(ul.last_used_at, t.api_key_last_used_at) AS api_key_last_used_at,
            COALESCE(ul.last_used_ip, t.api_key_last_used_ip) AS api_key_last_used_ip,
            t.allowed_origins,
            t.active,
            COALESCE(u.tokens_used, 0) AS tokens_used,
            COALESCE(u.request_count, 0) AS request_count,
            ul.last_used_at,
            COALESCE(a.total_messages, 0) AS total_messages
        FROM tenants t
        LEFT JOIN (
            SELECT tenant_id,
                   SUM(tokens_used)::bigint AS tokens_used,
                   SUM(request_count)::bigint AS request_count
            FROM api_key_usage
            GROUP BY tenant_id
        ) u ON u.tenant_id = t.id
        LEFT JOIN (
            SELECT DISTINCT ON (tenant_id)
                tenant_id,
                last_used_at,
                last_used_ip
            FROM api_key_usage
            WHERE last_used_at IS NOT NULL
            ORDER BY tenant_id, last_used_at DESC
        ) ul ON ul.tenant_id = t.id
        LEFT JOIN (
            SELECT tenant_id, COUNT(*)::int AS total_messages
            FROM analytics_events
            WHERE event_type = 'message_sent'
            GROUP BY tenant_id
        ) a ON a.tenant_id = t.id
        ORDER BY t.id ASC
        `
    );

    return result.rows || [];
}

async function getTenantStats(tenantId) {
    const usageRes = await db.query(
        `
        SELECT
            COALESCE(SUM(tokens_used), 0)::bigint AS tokens_used,
            COALESCE(SUM(request_count), 0)::bigint AS request_count
        FROM api_key_usage
        WHERE tenant_id = $1
        `,
        [tenantId]
    );

    const lastUsedRes = await db.query(
        `
        SELECT last_used_at, last_used_ip
        FROM api_key_usage
        WHERE tenant_id = $1 AND last_used_at IS NOT NULL
        ORDER BY last_used_at DESC
        LIMIT 1
        `,
        [tenantId]
    );

    const totalsRes = await db.query(
        `
        SELECT
            COUNT(*) FILTER (WHERE event_type = 'message_sent') AS total_messages,
            COUNT(DISTINCT session_id) AS total_sessions,
            COUNT(*) FILTER (WHERE event_type = 'message_error') AS errors
        FROM analytics_events
        WHERE tenant_id = $1
        `,
        [tenantId]
    );

    const questionsRes = await db.query(
        `
        SELECT
            LOWER(TRIM(question)) AS normalized,
            MIN(question) AS question,
            COUNT(*)::int AS count,
            MAX(COALESCE(timestamp, server_timestamp)) AS last_asked
        FROM analytics_events
        WHERE tenant_id = $1 AND question IS NOT NULL
        GROUP BY normalized
        ORDER BY count DESC
        LIMIT 15
        `,
        [tenantId]
    );

    const cartActionsRes = await db.query(
        `
        SELECT event_type, COUNT(*)::int AS count
        FROM analytics_events
        WHERE tenant_id = $1 AND event_type IN
            ('cart_add', 'cart_remove', 'cart_update_qty', 'cart_cleared', 'suggestion_confirm')
        GROUP BY event_type
        `,
        [tenantId]
    );

    return {
        usage: {
            tokens_used: usageRes.rows[0]?.tokens_used || 0,
            request_count: usageRes.rows[0]?.request_count || 0,
            last_used_at: lastUsedRes.rows[0]?.last_used_at || null,
            last_used_ip: lastUsedRes.rows[0]?.last_used_ip || null
        },
        totals: {
            total_messages: parseInt(totalsRes.rows[0]?.total_messages || '0', 10),
            total_sessions: parseInt(totalsRes.rows[0]?.total_sessions || '0', 10),
            errors: parseInt(totalsRes.rows[0]?.errors || '0', 10)
        },
        top_questions: questionsRes.rows || [],
        cart_actions: cartActionsRes.rows.reduce((acc, row) => {
            acc[row.event_type] = row.count;
            return acc;
        }, {})
    };
}

async function getTenantWithSettingsById(id) {
    const result = await db.query(
        `
        SELECT t.*, s.*
        FROM tenants t
        JOIN tenant_settings s ON s.tenant_id = t.id
        WHERE t.id = $1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function createTenant({ name, slug, subdomain, apiKey, origins, active, settings }) {
    const tenantRes = await db.query(
        `
        INSERT INTO tenants (name, slug, subdomain, api_key, allowed_origins, active)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        `,
        [name, slug, subdomain || null, apiKey, origins, active]
    );

    const tenantId = tenantRes.rows[0].id;

    await db.query(
        `
        INSERT INTO tenant_settings (
            tenant_id,
            dify_url,
            dify_api_key,
            dify_agent_id,
            dify_instructions,
            dify_inputs,
            model_config,
            shopware_url,
            shopware_access_key
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
            tenantId,
            settings.dify_url,
            settings.dify_api_key,
            settings.dify_agent_id || null,
            settings.dify_instructions || '',
            settings.dify_inputs || null,
            settings.model_config || null,
            settings.shopware_url,
            settings.shopware_access_key
        ]
    );

    cacheClear();
    return tenantId;
}

async function updateTenant(id, { name, slug, subdomain, apiKey, origins, active }) {
    await db.query(
        `
        UPDATE tenants
        SET name=$1, slug=$2, subdomain=$3, api_key=$4, allowed_origins=$5, active=$6
        WHERE id=$7
        `,
        [name, slug, subdomain || null, apiKey, origins, active, id]
    );
    cacheClear();
}

async function updateTenantSettings(tenantId, settings) {
    await db.query(
        `
        UPDATE tenant_settings
        SET dify_url=$1, dify_api_key=$2, dify_agent_id=$3, dify_instructions=$4,
            shopware_url=$5, shopware_access_key=$6
        WHERE tenant_id=$7
        `,
        [
            settings.dify_url,
            settings.dify_api_key,
            settings.dify_agent_id || null,
            settings.dify_instructions || '',
            settings.shopware_url,
            settings.shopware_access_key,
            tenantId
        ]
    );
    cacheClear();
}

async function touchApiKeyUsage(tenantId, apiKey, ip) {
    await db.query(
        `
        UPDATE tenants
        SET api_key_last_used_at = NOW(),
            api_key_last_used_ip = $1
        WHERE id = $2
        `,
        [ip, tenantId]
    );

    await db.query(
        `
        INSERT INTO api_key_usage (tenant_id, api_key, request_count, last_used_at, last_used_ip)
        VALUES ($1, $2, 1, NOW(), $3)
        ON CONFLICT (tenant_id, api_key)
        DO UPDATE SET
            request_count = api_key_usage.request_count + 1,
            last_used_at = NOW(),
            last_used_ip = EXCLUDED.last_used_ip
        `,
        [tenantId, apiKey, ip]
    );
}

async function addTokenUsage(tenantId, apiKey, tokensUsed, ip) {
    await db.query(
        `
        INSERT INTO api_key_usage (tenant_id, api_key, tokens_used, request_count, last_used_at, last_used_ip)
        VALUES ($1, $2, $3, 0, NOW(), $4)
        ON CONFLICT (tenant_id, api_key)
        DO UPDATE SET
            tokens_used = api_key_usage.tokens_used + EXCLUDED.tokens_used,
            last_used_at = NOW(),
            last_used_ip = EXCLUDED.last_used_ip
        `,
        [tenantId, apiKey, tokensUsed, ip]
    );
}

module.exports = {
    getTenantByApiKey,
    getTenantByOrigin,
    listTenantsWithUsage,
    getTenantWithSettingsById,
    createTenant,
    updateTenant,
    updateTenantSettings,
    touchApiKeyUsage,
    addTokenUsage,
    getTenantStats
};
