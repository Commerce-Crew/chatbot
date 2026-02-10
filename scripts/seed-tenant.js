/**
 * Seed or update a tenant from env variables.
 *
 * Usage:
 *  TENANT_NAME=Acme TENANT_SLUG=acme TENANT_SUBDOMAIN=acme TENANT_API_KEY=cc_... \
 *  DIFY_URL=... DIFY_API_KEY=... SHOPWARE_URL=... SW_ACCESS_KEY=... \
 *  node scripts/seed-tenant.js
 */
const crypto = require('crypto');
const db = require('../src/db');

function requireEnv(name) {
    const val = process.env[name];
    if (!val) {
        throw new Error(`Missing required env: ${name}`);
    }
    return val;
}

function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/https?:\/\//g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'tenant';
}

function tryHost(url) {
    try {
        return new URL(url).hostname;
    } catch (_) {
        return '';
    }
}

function generateApiKey() {
    return `cc_${crypto.randomBytes(24).toString('hex')}`;
}

async function run() {
    const shopwareUrl = requireEnv('SHOPWARE_URL');
    const shopwareHost = tryHost(shopwareUrl) || 'tenant';

    const name = process.env.TENANT_NAME || shopwareHost;
    const slug = process.env.TENANT_SLUG || slugify(shopwareHost);
    const subdomain = process.env.TENANT_SUBDOMAIN || null;
    const apiKey = process.env.TENANT_API_KEY || generateApiKey();
    const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    const difyUrl = requireEnv('DIFY_URL');
    const difyApiKey = requireEnv('DIFY_API_KEY');
    const difyAgentId = process.env.DIFY_AGENT_ID || null;
    const difyInstructions = process.env.DIFY_INSTRUCTIONS || '';
    const difyInputs = process.env.DIFY_INPUTS ? JSON.parse(process.env.DIFY_INPUTS) : null;
    const modelConfig = process.env.MODEL_CONFIG ? JSON.parse(process.env.MODEL_CONFIG) : null;

    const shopwareAccessKey = requireEnv('SW_ACCESS_KEY');

    const tenantRes = await db.query(
        `
        INSERT INTO tenants (name, slug, subdomain, api_key, allowed_origins)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (slug)
        DO UPDATE SET
            name = EXCLUDED.name,
            subdomain = EXCLUDED.subdomain,
            api_key = EXCLUDED.api_key,
            allowed_origins = EXCLUDED.allowed_origins
        RETURNING id
        `,
        [name, slug, subdomain, apiKey, allowedOrigins]
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (tenant_id)
        DO UPDATE SET
            dify_url = EXCLUDED.dify_url,
            dify_api_key = EXCLUDED.dify_api_key,
            dify_agent_id = EXCLUDED.dify_agent_id,
            dify_instructions = EXCLUDED.dify_instructions,
            dify_inputs = EXCLUDED.dify_inputs,
            model_config = EXCLUDED.model_config,
            shopware_url = EXCLUDED.shopware_url,
            shopware_access_key = EXCLUDED.shopware_access_key
        `,
        [
            tenantId,
            difyUrl,
            difyApiKey,
            difyAgentId,
            difyInstructions,
            difyInputs,
            modelConfig,
            shopwareUrl,
            shopwareAccessKey
        ]
    );

    console.log(`Seeded tenant ${slug} (id=${tenantId})`);
    if (!process.env.TENANT_API_KEY) {
        console.log(`Generated TENANT_API_KEY: ${apiKey}`);
    }
}

run()
    .then(() => db.pool.end())
    .catch((err) => {
        console.error(err.message);
        return db.pool.end().finally(() => process.exit(1));
    });
