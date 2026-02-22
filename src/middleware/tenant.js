/**
 * Resolve tenant from API key or origin domain.
 */
const tenantRepo = require('../repositories/tenantRepository');
const shopRepo = require('../repositories/shopRepository');
const { log } = require('../utils/logger');
const config = require('../config');

function extractOrigin(req) {
    const origin = req.headers.origin || '';
    if (origin) return origin;

    const referer = req.headers.referer || '';
    if (referer) {
        try {
            const url = new URL(referer);
            return `${url.protocol}//${url.host}`;
        } catch (_) {
            return '';
        }
    }
    return '';
}

module.exports = async function tenantResolver(req, res, next) {
    try {
        if (req.path === '/health' || req.path.startsWith('/health/')) {
            return next();
        }

        const rawAuth = req.headers['authorization'] || '';
        const bearer = rawAuth.toLowerCase().startsWith('bearer ')
            ? rawAuth.slice(7).trim()
            : '';
        // Headers first, then query (so Dify can pass key in URL if it doesn't send headers)
        const apiKey = req.headers['x-cc-api-key'] || req.headers['x-api-key'] || bearer
            || (req.query && (req.query['x-cc-api-key'] || req.query['api_key'])) || null;
        const origin = extractOrigin(req);
        const shopId = req.headers['x-cc-shop-id'] || req.headers['x-shop-id'] || null;

        let apiKeyUsed = null;
        if (!apiKey) {
            const authHeaders = {
                'x-cc-api-key': !!(req.headers['x-cc-api-key']),
                'x-api-key': !!(req.headers['x-api-key']),
                'authorization': !!(req.headers['authorization']),
                'query.api_key': !!(req.query && (req.query['x-cc-api-key'] || req.query['api_key']))
            };
            log('TENANT', `401 api_key_required path=${req.method} ${req.path}`, {
                authHeadersPresent: authHeaders,
                hint: 'Tool calls from Dify must send x-cc-api-key with the same value as CCChatbot middlewareApiKey.'
            });
            const body = { error: 'api_key_required' };
            if (config.debug) {
                body.hint = 'Send x-cc-api-key header with your tenant API key (same as CCChatbot plugin Middleware API Key).';
            }
            return res.status(401).json(body);
        }

        let tenant = await tenantRepo.getTenantByApiKey(apiKey);
        if (tenant) {
            apiKeyUsed = apiKey;
        }
        if (!tenant) {
            log('TENANT', `403 invalid_api_key path=${req.method} ${req.path}`, {
                keyPresent: true,
                hint: 'API key was sent but is not registered. Check tenant API key in admin or plugin config.'
            });
            return res.status(403).json({ error: 'invalid_api_key' });
        }

        let shop = null;
        if (tenant?.id) {
            shop = await shopRepo.getShopById(tenant.id, shopId);
            if (!shop) {
                shop = await shopRepo.getShopByOrigin(tenant.id, origin);
            }
        }

        const allowedOrigins = Array.isArray(shop?.allowed_origins) && shop.allowed_origins.length
            ? shop.allowed_origins
            : (Array.isArray(tenant.allowed_origins) ? tenant.allowed_origins : []);

        req.tenant = {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            subdomain: tenant.subdomain,
            allowedOrigins,
            apiKeyUsed,
            dify: {
                url: shop?.dify_url || tenant.dify_url,
                apiKey: shop?.dify_api_key || tenant.dify_api_key,
                agentId: shop?.dify_agent_id || tenant.dify_agent_id || null,
                instructions: shop?.dify_instructions || tenant.dify_instructions || '',
                inputs: shop?.dify_inputs || tenant.dify_inputs || null,
                modelConfig: shop?.model_config || tenant.model_config || null
            },
            shopware: {
                url: shop?.shopware_url || tenant.shopware_url,
                accessKey: shop?.shopware_access_key || tenant.shopware_access_key
            }
        };

        if (shop) {
            req.shop = {
                id: shop.id,
                shopId: shop.shop_id,
                name: shop.name,
                allowedOrigins: Array.isArray(shop.allowed_origins) ? shop.allowed_origins : [],
                active: shop.active !== false
            };
        }

        if (apiKeyUsed) {
            const ip = req.ip || req.connection?.remoteAddress || null;
            await tenantRepo.touchApiKeyUsage(tenant.id, apiKeyUsed, ip);
        }

        return next();
    } catch (error) {
        return res.status(500).json({ error: 'tenant_resolution_failed' });
    }
};
