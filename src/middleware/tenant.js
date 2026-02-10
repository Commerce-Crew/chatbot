/**
 * Resolve tenant from API key or origin domain.
 */
const tenantRepo = require('../repositories/tenantRepository');
const shopRepo = require('../repositories/shopRepository');

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
        const apiKey = req.headers['x-cc-api-key'] || req.headers['x-api-key'] || bearer || null;
        const origin = extractOrigin(req);
        const shopId = req.headers['x-cc-shop-id'] || req.headers['x-shop-id'] || null;

        let apiKeyUsed = null;
        if (!apiKey) {
            return res.status(401).json({ error: 'api_key_required' });
        }

        let tenant = await tenantRepo.getTenantByApiKey(apiKey);
        if (tenant) {
            apiKeyUsed = apiKey;
        }
        if (!tenant) {
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
