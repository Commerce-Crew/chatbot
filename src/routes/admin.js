/**
 * Admin dashboard (basic-auth, server-rendered)
 */
const express = require('express');
const crypto = require('crypto');
const tenantRepo = require('../repositories/tenantRepository');
const leadRepo = require('../repositories/leadRepository');
const shopRepo = require('../repositories/shopRepository');

const router = express.Router();

function requireEnv(name) {
    const val = process.env[name];
    if (!val) throw new Error(`Missing ${name}`);
    return val;
}

function basicAuth(req, res, next) {
    try {
        const expectedUser = requireEnv('ADMIN_USER');
        const expectedPass = requireEnv('ADMIN_PASS');
        const header = req.headers.authorization || '';

        if (!header.startsWith('Basic ')) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
            return res.status(401).send('Authentication required');
        }

        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const [user, pass] = decoded.split(':');
        if (user !== expectedUser || pass !== expectedPass) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
            return res.status(401).send('Invalid credentials');
        }

        return next();
    } catch (e) {
        return res.status(500).send('Admin auth misconfigured');
    }
}

function htmlLayout(title, body) {
    return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
      th { background: #f5f5f5; }
      input[type="text"], input[type="password"], textarea, select { width: 100%; padding: 8px; }
      label { display: block; font-weight: 600; margin-bottom: 6px; }
      textarea { min-height: 90px; }
      form { max-width: 980px; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
      .col { flex: 1; }
      .actions { display: flex; gap: 8px; }
      .muted { color: #666; font-size: 12px; }
      .btn { display: inline-block; padding: 6px 12px; background: #0b1742; color: #fff; text-decoration: none; border-radius: 4px; border: none; cursor: pointer; }
      .btn.secondary { background: #555; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </body>
</html>
    `.trim();
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
    if (!value) return '';
    if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
        const ms = parseInt(value, 10);
        if (Number.isFinite(ms)) return new Date(ms).toLocaleString();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return new Date(value).toLocaleString();
    }
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d.toLocaleString();
    return String(value);
}

function parseOrigins(raw) {
    return String(raw || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function parseJsonOrNull(raw, fieldName = 'json') {
    const text = String(raw || '').trim();
    if (!text) return { ok: true, value: null };
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (_) {
        return { ok: false, error: `${fieldName} must be valid JSON` };
    }
}

function generateApiKey() {
    return `cc_${crypto.randomBytes(24).toString('hex')}`;
}

async function fetchSalesChannels(shopwareUrl, accessKey) {
    const url = `${shopwareUrl}/store-api/sales-channel`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'sw-access-key': accessKey
        },
        body: JSON.stringify({})
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Shopware error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    const elements = data.elements || [];
    return elements.map(c => ({
        id: c.id,
        name: c.name,
        domains: (c.domains?.elements || c.domains || []).map(d => d.url).filter(Boolean)
    }));
}

router.use(basicAuth);

// ------------------------------------------------------------------
// List tenants
// ------------------------------------------------------------------
router.get('/', async (req, res) => {
    const rows = await tenantRepo.listTenantsWithUsage();
    const tableRows = rows.map(r => `
        <tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.slug)}</td>
          <td>${escapeHtml(r.subdomain || '')}</td>
          <td>${escapeHtml((r.allowed_origins || []).join(', '))}</td>
          <td><code>${escapeHtml(r.api_key || '')}</code></td>
          <td>${escapeHtml(r.api_key_last_used_at || r.last_used_at || '')}</td>
          <td>${escapeHtml(r.api_key_last_used_ip || '')}</td>
          <td>${escapeHtml(String(r.tokens_used || 0))}</td>
          <td>${escapeHtml(String(r.request_count || 0))}</td>
          <td>${escapeHtml(String(r.total_messages || 0))}</td>
          <td>${r.active ? 'Yes' : 'No'}</td>
          <td class="actions">
            <a class="btn secondary" href="/admin/edit/${r.id}">Edit</a>
          </td>
        </tr>
    `).join('');

    const body = `
      <div class="actions">
        <a class="btn" href="/admin/new">Create client</a>
        <a class="btn secondary" href="/admin/shops">Shops</a>
        <a class="btn secondary" href="/admin/leads">Leads</a>
      </div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Slug</th>
            <th>Subdomain</th>
            <th>Allowed Origins</th>
            <th>API Key</th>
            <th>Last Used</th>
            <th>Last IP</th>
            <th>Tokens Used</th>
            <th>Request Count</th>
            <th>Total Messages</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${tableRows || '<tr><td colspan="11">No clients yet</td></tr>'}
        </tbody>
      </table>
    `;

    res.send(htmlLayout('Clients', body));
});

// ------------------------------------------------------------------
// Leads list
// ------------------------------------------------------------------
router.get('/leads', async (req, res) => {
    const tenantId = req.query.tenant_id ? parseInt(req.query.tenant_id, 10) : null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    let leads = [];
    if (tenantId) {
        leads = await leadRepo.listLeads(tenantId, limit, 0);
    }

    const tenantOptions = (await tenantRepo.listTenantsWithUsage())
        .map(t => `<option value="${t.id}" ${t.id === tenantId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
        .join('');

    const rows = leads.map(l => `
        <tr>
          <td>${escapeHtml(String(l.id))}</td>
          <td>${escapeHtml(l.name || '')}</td>
          <td>${escapeHtml(l.email || '')}</td>
          <td>${escapeHtml(l.phone || '')}</td>
          <td>${escapeHtml(l.product_name || '')}</td>
          <td>${escapeHtml(l.source || '')}</td>
          <td>${escapeHtml(l.created_at || '')}</td>
          <td>${escapeHtml((l.message || '').slice(0, 200))}</td>
        </tr>
    `).join('');

    const body = `
      <form method="get" action="/admin/leads">
        <div class="row">
          <div class="col">
            <label>Tenant</label>
            <select name="tenant_id">
              <option value="">Select tenant...</option>
              ${tenantOptions}
            </select>
          </div>
          <div class="col">
            <label>Limit</label>
            <input type="text" name="limit" value="${escapeHtml(String(limit))}">
          </div>
        </div>
        <div class="actions" style="margin-top:8px;">
          <button class="btn" type="submit">Load</button>
          <a class="btn secondary" href="/admin">Back</a>
        </div>
      </form>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Product</th>
            <th>Source</th>
            <th>Created</th>
            <th>Message</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="8">No leads found</td></tr>'}
        </tbody>
      </table>
    `;

    res.send(htmlLayout('Leads', body));
});

// ------------------------------------------------------------------
// Shops list
// ------------------------------------------------------------------
router.get('/shops', async (req, res) => {
    const tenantId = req.query.tenant_id ? parseInt(req.query.tenant_id, 10) : null;
    const shops = await shopRepo.listShops(tenantId);

    const tenantOptions = (await tenantRepo.listTenantsWithUsage())
        .map(t => `<option value="${t.id}" ${t.id === tenantId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
        .join('');

    const rows = shops.map(s => `
        <tr>
          <td>${escapeHtml(String(s.id))}</td>
          <td>${escapeHtml(String(s.tenant_id))}</td>
          <td>${escapeHtml(s.shop_id || '')}</td>
          <td>${escapeHtml(s.name || '')}</td>
          <td>${escapeHtml(s.shopware_url || '')}</td>
          <td>${escapeHtml((s.allowed_origins || []).join(', '))}</td>
          <td>${s.active ? 'Yes' : 'No'}</td>
          <td class="actions">
            <a class="btn secondary" href="/admin/shops/edit/${s.id}">Edit</a>
          </td>
        </tr>
    `).join('');

    const body = `
      <div class="actions">
        <a class="btn" href="/admin/shops/new">Add shop</a>
        <a class="btn secondary" href="/admin/shops/import">Import from Shopware</a>
        <a class="btn secondary" href="/admin">Back</a>
      </div>
      <form method="get" action="/admin/shops" style="margin-top:12px;">
        <div class="row">
          <div class="col">
            <label>Tenant</label>
            <select name="tenant_id">
              <option value="">All tenants</option>
              ${tenantOptions}
            </select>
          </div>
        </div>
        <div class="actions" style="margin-top:8px;">
          <button class="btn" type="submit">Filter</button>
        </div>
      </form>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Tenant</th>
            <th>Shop ID</th>
            <th>Name</th>
            <th>Shopware URL</th>
            <th>Allowed Origins</th>
            <th>Active</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="8">No shops found</td></tr>'}
        </tbody>
      </table>
    `;

    res.send(htmlLayout('Shops', body));
});

// ------------------------------------------------------------------
// New shop
// ------------------------------------------------------------------
router.get('/shops/new', async (req, res) => {
    const tenantOptions = (await tenantRepo.listTenantsWithUsage())
        .map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
        .join('');

    const body = `
      <form method="post" action="/admin/shops/new">
        <div class="row">
          <div class="col">
            <label>Tenant</label>
            <select name="tenant_id" required>
              <option value="">Select tenant...</option>
              ${tenantOptions}
            </select>
          </div>
          <div class="col">
            <label>Shop ID (Sales Channel ID)</label>
            <input type="text" name="shop_id" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Name</label>
            <input type="text" name="name">
          </div>
          <div class="col">
            <label>Allowed origins (comma-separated)</label>
            <input type="text" name="allowed_origins">
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Shopware URL</label>
            <input type="text" name="shopware_url" required>
          </div>
          <div class="col">
            <label>Shopware Access Key</label>
            <input type="text" name="shopware_access_key" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify URL (optional)</label>
            <input type="text" name="dify_url">
          </div>
          <div class="col">
            <label>Dify API Key (optional)</label>
            <input type="text" name="dify_api_key">
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify Agent ID (optional)</label>
            <input type="text" name="dify_agent_id">
          </div>
          <div class="col">
            <label>Dify Instructions (optional)</label>
            <textarea name="dify_instructions" rows="3"></textarea>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify Inputs JSON (optional)</label>
            <textarea name="dify_inputs" rows="3" placeholder='{"key":"value"}'></textarea>
          </div>
          <div class="col">
            <label>Model Config JSON (optional)</label>
            <textarea name="model_config" rows="3" placeholder='{"temperature":0.2}'></textarea>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Active</label>
            <input type="text" name="active" value="true">
            <div class="muted">Use true/false</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn" type="submit">Create</button>
          <a class="btn secondary" href="/admin/shops">Cancel</a>
        </div>
      </form>
    `;
    res.send(htmlLayout('Add shop', body));
});

router.post('/shops/new', async (req, res) => {
    const {
        tenant_id,
        shop_id,
        name,
        allowed_origins,
        shopware_url,
        shopware_access_key,
        dify_url,
        dify_api_key,
        dify_agent_id,
        dify_instructions,
        dify_inputs,
        model_config,
        active
    } = req.body || {};

    const difyInputsParsed = parseJsonOrNull(dify_inputs, 'dify_inputs');
    if (!difyInputsParsed.ok) {
        return res.status(400).send(difyInputsParsed.error);
    }
    const modelConfigParsed = parseJsonOrNull(model_config, 'model_config');
    if (!modelConfigParsed.ok) {
        return res.status(400).send(modelConfigParsed.error);
    }

    const origins = parseOrigins(allowed_origins);
    const isActive = String(active || 'true').toLowerCase() !== 'false';

    await shopRepo.createShop({
        tenantId: parseInt(tenant_id, 10),
        shopId: shop_id,
        name,
        shopwareUrl: shopware_url,
        shopwareAccessKey: shopware_access_key,
        allowedOrigins: origins,
        active: isActive,
        difyUrl: dify_url,
        difyApiKey: dify_api_key,
        difyAgentId: dify_agent_id,
        difyInstructions: dify_instructions,
        difyInputs: difyInputsParsed.value,
        modelConfig: modelConfigParsed.value
    });

    res.redirect('/admin/shops');
});

// ------------------------------------------------------------------
// Edit shop
// ------------------------------------------------------------------
router.get('/shops/edit/:id', async (req, res) => {
    const id = req.params.id;
    const shop = await shopRepo.getShopByDbId(id);
    if (!shop) return res.status(404).send('Not found');

    const tenantOptions = (await tenantRepo.listTenantsWithUsage())
        .map(t => `<option value="${t.id}" ${t.id === shop.tenant_id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
        .join('');

    const body = `
      <form method="post" action="/admin/shops/edit/${shop.id}">
        <div class="row">
          <div class="col">
            <label>Tenant</label>
            <select name="tenant_id" required>
              ${tenantOptions}
            </select>
          </div>
          <div class="col">
            <label>Shop ID (Sales Channel ID)</label>
            <input type="text" name="shop_id" value="${escapeHtml(shop.shop_id)}" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Name</label>
            <input type="text" name="name" value="${escapeHtml(shop.name || '')}">
          </div>
          <div class="col">
            <label>Allowed origins (comma-separated)</label>
            <input type="text" name="allowed_origins" value="${escapeHtml((shop.allowed_origins || []).join(', '))}">
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Shopware URL</label>
            <input type="text" name="shopware_url" value="${escapeHtml(shop.shopware_url)}" required>
          </div>
          <div class="col">
            <label>Shopware Access Key</label>
            <input type="text" name="shopware_access_key" value="${escapeHtml(shop.shopware_access_key)}" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify URL (optional)</label>
            <input type="text" name="dify_url" value="${escapeHtml(shop.dify_url || '')}">
          </div>
          <div class="col">
            <label>Dify API Key (optional)</label>
            <input type="text" name="dify_api_key" value="${escapeHtml(shop.dify_api_key || '')}">
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify Agent ID (optional)</label>
            <input type="text" name="dify_agent_id" value="${escapeHtml(shop.dify_agent_id || '')}">
          </div>
          <div class="col">
            <label>Dify Instructions (optional)</label>
            <textarea name="dify_instructions" rows="3">${escapeHtml(shop.dify_instructions || '')}</textarea>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify Inputs JSON (optional)</label>
            <textarea name="dify_inputs" rows="3">${escapeHtml(JSON.stringify(shop.dify_inputs || {}, null, 2))}</textarea>
          </div>
          <div class="col">
            <label>Model Config JSON (optional)</label>
            <textarea name="model_config" rows="3">${escapeHtml(JSON.stringify(shop.model_config || {}, null, 2))}</textarea>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Active</label>
            <input type="text" name="active" value="${escapeHtml(String(shop.active))}">
            <div class="muted">Use true/false</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn" type="submit">Save</button>
          <a class="btn secondary" href="/admin/shops">Back</a>
        </div>
      </form>
    `;
    res.send(htmlLayout(`Edit shop`, body));
});

router.post('/shops/edit/:id', async (req, res) => {
    const id = req.params.id;
    const {
        tenant_id,
        shop_id,
        name,
        allowed_origins,
        shopware_url,
        shopware_access_key,
        dify_url,
        dify_api_key,
        dify_agent_id,
        dify_instructions,
        dify_inputs,
        model_config,
        active
    } = req.body || {};

    const difyInputsParsed = parseJsonOrNull(dify_inputs, 'dify_inputs');
    if (!difyInputsParsed.ok) {
        return res.status(400).send(difyInputsParsed.error);
    }
    const modelConfigParsed = parseJsonOrNull(model_config, 'model_config');
    if (!modelConfigParsed.ok) {
        return res.status(400).send(modelConfigParsed.error);
    }

    const origins = parseOrigins(allowed_origins);
    const isActive = String(active || 'true').toLowerCase() !== 'false';

    await shopRepo.updateShop(id, {
        tenantId: parseInt(tenant_id, 10),
        shopId: shop_id,
        name,
        shopwareUrl: shopware_url,
        shopwareAccessKey: shopware_access_key,
        allowedOrigins: origins,
        active: isActive,
        difyUrl: dify_url,
        difyApiKey: dify_api_key,
        difyAgentId: dify_agent_id,
        difyInstructions: dify_instructions,
        difyInputs: difyInputsParsed.value,
        modelConfig: modelConfigParsed.value
    });

    res.redirect('/admin/shops');
});

// ------------------------------------------------------------------
// Import shops from Shopware (sales channels)
// ------------------------------------------------------------------
router.get('/shops/import', async (req, res) => {
    const tenantOptions = (await tenantRepo.listTenantsWithUsage())
        .map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`)
        .join('');

    const body = `
      <form method="post" action="/admin/shops/import">
        <div class="row">
          <div class="col">
            <label>Tenant</label>
            <select name="tenant_id" required>
              <option value="">Select tenant...</option>
              ${tenantOptions}
            </select>
          </div>
          <div class="col">
            <label>Shopware URL</label>
            <input type="text" name="shopware_url" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Shopware Access Key</label>
            <input type="text" name="shopware_access_key" required>
          </div>
          <div class="col">
            <label>Also set allowed origins from sales channel domains</label>
            <input type="text" name="use_domains" value="true">
            <div class="muted">Use true/false</div>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify URL (optional)</label>
            <input type="text" name="dify_url">
          </div>
          <div class="col">
            <label>Dify API Key (optional)</label>
            <input type="text" name="dify_api_key">
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify Inputs JSON (optional)</label>
            <textarea name="dify_inputs" rows="3" placeholder='{"key":"value"}'></textarea>
          </div>
          <div class="col">
            <label>Model Config JSON (optional)</label>
            <textarea name="model_config" rows="3" placeholder='{"temperature":0.2}'></textarea>
          </div>
        </div>
        <div class="actions">
          <button class="btn" type="submit">Import</button>
          <a class="btn secondary" href="/admin/shops">Cancel</a>
        </div>
      </form>
    `;
    res.send(htmlLayout('Import shops', body));
});

router.post('/shops/import', async (req, res) => {
    try {
        const {
            tenant_id,
            shopware_url,
            shopware_access_key,
            use_domains,
            dify_url,
            dify_api_key,
            dify_inputs,
            model_config
        } = req.body || {};

        const tenantId = parseInt(tenant_id, 10);
        const includeDomains = String(use_domains || 'true').toLowerCase() !== 'false';
        const channels = await fetchSalesChannels(shopware_url, shopware_access_key);
        const difyInputsParsed = parseJsonOrNull(dify_inputs, 'dify_inputs');
        if (!difyInputsParsed.ok) {
            return res.status(400).send(difyInputsParsed.error);
        }
        const modelConfigParsed = parseJsonOrNull(model_config, 'model_config');
        if (!modelConfigParsed.ok) {
            return res.status(400).send(modelConfigParsed.error);
        }
        const difyInputs = difyInputsParsed.value;
        const modelConfig = modelConfigParsed.value;

        for (const channel of channels) {
            const existing = await shopRepo.getShopById(tenantId, channel.id);
            const origins = includeDomains ? channel.domains : [];
            if (existing) {
                await shopRepo.updateShop(existing.id, {
                    tenantId,
                    shopId: channel.id,
                    name: channel.name,
                    shopwareUrl: shopware_url,
                    shopwareAccessKey: shopware_access_key,
                    allowedOrigins: origins,
                    active: existing.active,
                    difyUrl: dify_url,
                    difyApiKey: dify_api_key,
                    difyInputs,
                    modelConfig
                });
            } else {
                await shopRepo.createShop({
                    tenantId,
                    shopId: channel.id,
                    name: channel.name,
                    shopwareUrl: shopware_url,
                    shopwareAccessKey: shopware_access_key,
                    allowedOrigins: origins,
                    active: true,
                    difyUrl: dify_url,
                    difyApiKey: dify_api_key,
                    difyInputs,
                    modelConfig
                });
            }
        }

        res.redirect('/admin/shops');
    } catch (e) {
        res.status(500).send('Import failed: ' + escapeHtml(e.message));
    }
});

// ------------------------------------------------------------------
// New tenant form
// ------------------------------------------------------------------
router.get('/new', (req, res) => {
    const body = `
      <form method="post" action="/admin/new">
        <div class="row">
          <div class="col">
            <label>Name</label>
            <input type="text" name="name" required>
          </div>
          <div class="col">
            <label>Slug</label>
            <input type="text" name="slug" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Subdomain (optional)</label>
            <input type="text" name="subdomain">
          </div>
          <div class="col">
            <label>Allowed origins (comma-separated)</label>
            <input type="text" name="allowed_origins">
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify URL</label>
            <input type="text" name="dify_url" required>
          </div>
          <div class="col">
            <label>Dify API Key</label>
            <input type="text" name="dify_api_key" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify Agent ID (optional)</label>
            <input type="text" name="dify_agent_id">
          </div>
          <div class="col">
            <label>Dify Instructions (optional)</label>
            <textarea name="dify_instructions" rows="3"></textarea>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Shopware URL</label>
            <input type="text" name="shopware_url" required>
          </div>
          <div class="col">
            <label>Shopware Access Key</label>
            <input type="text" name="shopware_access_key" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Active</label>
            <input type="text" name="active" value="true">
            <div class="muted">Use true/false</div>
          </div>
          <div class="col">
            <label>API Key (auto generated if empty)</label>
            <input type="text" name="api_key">
          </div>
        </div>
        <button class="btn" type="submit">Create</button>
      </form>
    `;
    res.send(htmlLayout('Create client', body));
});

router.post('/new', async (req, res) => {
    const {
        name,
        slug,
        subdomain,
        allowed_origins,
        dify_url,
        dify_api_key,
        dify_agent_id,
        dify_instructions,
        shopware_url,
        shopware_access_key,
        active,
        api_key
    } = req.body || {};

    const key = api_key || generateApiKey();
    const origins = parseOrigins(allowed_origins);
    const isActive = String(active || 'true').toLowerCase() !== 'false';

    await tenantRepo.createTenant({
        name,
        slug,
        subdomain,
        apiKey: key,
        origins,
        active: isActive,
        settings: {
            dify_url,
            dify_api_key,
            dify_agent_id,
            dify_instructions,
            shopware_url,
            shopware_access_key
        }
    });

    res.redirect('/admin');
});

// ------------------------------------------------------------------
// Edit tenant
// ------------------------------------------------------------------
router.get('/edit/:id', async (req, res) => {
    const id = req.params.id;
    const r = await tenantRepo.getTenantWithSettingsById(id);
    if (!r) return res.status(404).send('Not found');
    const stats = await tenantRepo.getTenantStats(id);
    const usage = stats.usage || {};
    const totals = stats.totals || {};
    const cartActions = stats.cart_actions || {};
    const topQuestionsRows = (stats.top_questions || []).map(q => `
        <tr>
          <td>${escapeHtml(q.question || '')}</td>
          <td>${escapeHtml(String(q.count || 0))}</td>
          <td>${escapeHtml(formatDateTime(q.last_asked || ''))}</td>
        </tr>
    `).join('');
    const cartActionRows = Object.entries(cartActions).map(([type, count]) => `
        <tr>
          <td>${escapeHtml(type)}</td>
          <td>${escapeHtml(String(count))}</td>
        </tr>
    `).join('');

    const body = `
      <form method="post" action="/admin/edit/${r.id}">
        <div class="row">
          <div class="col">
            <label>Name</label>
            <input type="text" name="name" value="${escapeHtml(r.name)}" required>
          </div>
          <div class="col">
            <label>Slug</label>
            <input type="text" name="slug" value="${escapeHtml(r.slug)}" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Subdomain (optional)</label>
            <input type="text" name="subdomain" value="${escapeHtml(r.subdomain || '')}">
          </div>
          <div class="col">
            <label>Allowed origins (comma-separated)</label>
            <input type="text" name="allowed_origins" value="${escapeHtml((r.allowed_origins || []).join(', '))}">
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify URL</label>
            <input type="text" name="dify_url" value="${escapeHtml(r.dify_url)}" required>
          </div>
          <div class="col">
            <label>Dify API Key</label>
            <input type="text" name="dify_api_key" value="${escapeHtml(r.dify_api_key)}" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Dify Agent ID (optional)</label>
            <input type="text" name="dify_agent_id" value="${escapeHtml(r.dify_agent_id || '')}">
          </div>
          <div class="col">
            <label>Dify Instructions (optional)</label>
            <textarea name="dify_instructions" rows="3">${escapeHtml(r.dify_instructions || '')}</textarea>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Shopware URL</label>
            <input type="text" name="shopware_url" value="${escapeHtml(r.shopware_url)}" required>
          </div>
          <div class="col">
            <label>Shopware Access Key</label>
            <input type="text" name="shopware_access_key" value="${escapeHtml(r.shopware_access_key)}" required>
          </div>
        </div>
        <div class="row">
          <div class="col">
            <label>Active</label>
            <input type="text" name="active" value="${escapeHtml(String(r.active))}">
            <div class="muted">Use true/false</div>
          </div>
          <div class="col">
            <label>API Key</label>
            <input type="text" name="api_key" value="${escapeHtml(r.api_key || '')}">
          </div>
        </div>
        <div class="actions">
          <button class="btn" type="submit">Save</button>
          <button class="btn secondary" type="submit" name="regenerate_key" value="1">Regenerate API Key</button>
        </div>
      </form>
      <h2 style="margin-top:24px;">Usage & Stats</h2>
      <table>
        <thead>
          <tr>
            <th>Tokens Used</th>
            <th>Request Count</th>
            <th>Last Used</th>
            <th>Last IP</th>
            <th>Total Messages</th>
            <th>Total Sessions</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>${escapeHtml(String(usage.tokens_used || 0))}</td>
            <td>${escapeHtml(String(usage.request_count || 0))}</td>
            <td>${escapeHtml(formatDateTime(usage.last_used_at || r.api_key_last_used_at || ''))}</td>
            <td>${escapeHtml(usage.last_used_ip || r.api_key_last_used_ip || '')}</td>
            <td>${escapeHtml(String(totals.total_messages || 0))}</td>
            <td>${escapeHtml(String(totals.total_sessions || 0))}</td>
            <td>${escapeHtml(String(totals.errors || 0))}</td>
          </tr>
        </tbody>
      </table>
      <h3 style="margin-top:16px;">Chatbot Actions</h3>
      <table>
        <thead>
          <tr>
            <th>Action</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          ${cartActionRows || '<tr><td colspan="2">No actions yet</td></tr>'}
        </tbody>
      </table>
      <h3 style="margin-top:16px;">Top Questions</h3>
      <table>
        <thead>
          <tr>
            <th>Question</th>
            <th>Count</th>
            <th>Last Asked</th>
          </tr>
        </thead>
        <tbody>
          ${topQuestionsRows || '<tr><td colspan="3">No questions yet</td></tr>'}
        </tbody>
      </table>
    `;
    res.send(htmlLayout(`Edit ${escapeHtml(r.name)}`, body));
});

router.post('/edit/:id', async (req, res) => {
    const id = req.params.id;
    const {
        name,
        slug,
        subdomain,
        allowed_origins,
        dify_url,
        dify_api_key,
        dify_agent_id,
        dify_instructions,
        shopware_url,
        shopware_access_key,
        active,
        api_key,
        regenerate_key
    } = req.body || {};

    const origins = parseOrigins(allowed_origins);
    const isActive = String(active || 'true').toLowerCase() !== 'false';
    const nextApiKey = regenerate_key ? generateApiKey() : api_key;

    await tenantRepo.updateTenant(id, {
        name,
        slug,
        subdomain,
        apiKey: nextApiKey,
        origins,
        active: isActive
    });

    await tenantRepo.updateTenantSettings(id, {
        dify_url,
        dify_api_key,
        dify_agent_id,
        dify_instructions,
        shopware_url,
        shopware_access_key
    });

    res.redirect('/admin');
});

module.exports = router;
