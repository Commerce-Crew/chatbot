/**
 * Shopware Store API Service
 */
const { log } = require('../utils/logger');

function getShopwareConfig(tenant) {
    return tenant?.shopware || {
        url: '',
        accessKey: ''
    };
}

function getHeaders(tenant, options = {}) {
    const sw = getShopwareConfig(tenant);
    const headers = {
        'Content-Type': 'application/json',
        'sw-access-key': sw.accessKey
    };
    if (options.contextToken) {
        headers['sw-context-token'] = options.contextToken;
    }
    if (options.languageId) {
        headers['sw-language-id'] = options.languageId;
    }
    return headers;
}

// -----------------------------------------------------------------------------
// Lightweight TTL cache (in-memory)
// -----------------------------------------------------------------------------
const cache = new Map(); // key -> { value, expiresAt }

function cacheGet(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
        cache.delete(key);
        return null;
    }
    return item.value;
}

function cacheSet(key, value, ttlMs) {
    cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

async function refreshContextToken(contextToken, cookieHeader, tenant = null) {
    try {
        const sw = getShopwareConfig(tenant);
        const headers = {
            ...getHeaders(tenant),
            'Content-Type': 'application/json'
        };
        if (contextToken) {
            headers['sw-context-token'] = contextToken;
        }
        if (cookieHeader) {
            headers['cookie'] = cookieHeader;
        }

        const tryRequest = async (method) => {
            const resp = await fetchWithTimeout(`${sw.url}/store-api/context`, {
                method,
                headers,
                body: JSON.stringify({})
            }, 20000);

            const headerToken = resp.headers.get('sw-context-token') || null;
            let bodyToken = null;
            let body = null;
            if (resp.ok) {
                body = await resp.json().catch(() => null);
                bodyToken = body?.token || body?.contextToken || body?.context_token || null;
            } else {
                try { body = await resp.text(); } catch (_) {}
            }

            return {
                ok: resp.ok,
                status: resp.status,
                token: headerToken || bodyToken || null,
                body
            };
        };

        let result = await tryRequest('POST');
        if (result.status === 405) {
            log('SHOPWARE', 'Context refresh: POST not allowed, retrying PATCH');
            result = await tryRequest('PATCH');
        }

        return {
            success: result.ok,
            status: result.status,
            token: result.token,
            body: result.body
        };
    } catch (error) {
        log('SHOPWARE', 'Context refresh error', error.message);
        return { success: false, status: 0, token: null, body: null };
    }
}

function stripHtml(text) {
    return String(text || '').replace(/<[^>]*>/g, '').trim();
}

/**
 * Search products
 */
async function searchProducts(query, limit = 10, tenant = null, options = {}) {
    const q = String(query || '').trim();
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 10, 50));
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000;
    if (!q) return [];

    // Small cache for repeated searches (typing/autocomplete)
    const tenantKey = tenant?.id ? `t${tenant.id}` : 'default';
    const cacheKey = `search:${tenantKey}:${q.toLowerCase()}:${lim}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const startedAt = Date.now();
    const reason = options.reason || 'search';
    try {
        const sw = getShopwareConfig(tenant);
        const response = await fetchWithTimeout(`${sw.url}/store-api/search`, {
            method: 'POST',
            headers: getHeaders(tenant),
            body: JSON.stringify({ search: q, limit: lim })
        }, timeoutMs);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        let products = (data.elements || []).map(p => ({
            id: p.id,
            name: p.name,
            productNumber: p.productNumber,
            description: stripHtml(p.description).substring(0, 200),
            price: p.calculatedPrice?.unitPrice || p.price?.[0]?.gross || 0,
            priceFormatted: formatPrice(p.calculatedPrice?.unitPrice || p.price?.[0]?.gross || 0),
            imageUrl: p.cover?.media?.url || null,
            url: `${sw.url}/detail/${p.id}`,
            available: p.available !== false,
            stock: p.availableStock || 0
        }));

        if (options.debug) {
            log('SHOPWARE', 'Search ok', {
                query: q,
                limit: lim,
                ms: Date.now() - startedAt,
                reason
            });
        }

        // Cache for 60s
        cacheSet(cacheKey, products, 60 * 1000);
        return products;
    } catch (error) {
        const ms = Date.now() - startedAt;
        log('SHOPWARE', 'Search error:', `${error.message} (ms=${ms}, timeoutMs=${timeoutMs}, q="${q}", reason=${reason})`);
        return [];
    }
}

/**
 * Get product by ID
 */
async function getProduct(productId, tenant = null) {
    const pid = String(productId || '').trim();
    if (!pid) return null;

    const tenantKey = tenant?.id ? `t${tenant.id}` : 'default';
    const cacheKey = `product:${tenantKey}:${pid}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const sw = getShopwareConfig(tenant);
        const response = await fetchWithTimeout(`${sw.url}/store-api/product/${pid}`, {
            method: 'POST',
            headers: getHeaders(tenant),
            body: JSON.stringify({})
        });

        if (!response.ok) return null;

        const data = await response.json();
        const p = data.product;
        if (!p) return null;

        const product = {
            id: p.id,
            name: p.name,
            productNumber: p.productNumber,
            description: stripHtml(p.description),
            price: p.calculatedPrice?.unitPrice || 0,
            priceFormatted: formatPrice(p.calculatedPrice?.unitPrice || 0),
            imageUrl: p.cover?.media?.url || null,
            url: `${sw.url}/detail/${p.id}`,
            available: p.available !== false,
            stock: p.availableStock || 0
        };

        cacheSet(cacheKey, product, 5 * 60 * 1000);
        return product;
    } catch (error) {
        log('SHOPWARE', 'Get product error:', error.message);
        return null;
    }
}

// -----------------------------------------------------------------------------
function normalizeLineItems(order) {
    const li = order?.lineItems;
    if (Array.isArray(li)) return li;
    if (li?.elements && Array.isArray(li.elements)) return li.elements;
    return [];
}

function normalizeDeliveries(order) {
    const d = order?.deliveries;
    if (Array.isArray(d)) return d;
    if (d?.elements && Array.isArray(d.elements)) return d.elements;
    return [];
}

function mapDeliveries(order) {
    const deliveries = normalizeDeliveries(order);
    return deliveries.map(d => ({
        id: d.id,
        state: d.stateMachineState?.name || null,
        shippingMethod: d.shippingMethod?.name || null,
        trackingCodes: Array.isArray(d.trackingCodes) ? d.trackingCodes : [],
        shippedAt: d.shippedAt || d.shippingDateEarliest || null,
        shippedAtLatest: d.shippingDateLatest || null
    }));
}

/**
 * Get customer orders - REQUIRES LOGGED IN CUSTOMER
 */
async function getOrders(contextToken, limit = 5, tenant = null) {
    if (!contextToken) {
        return {
            success: false,
            error: 'not_logged_in',
            message: 'Der Kunde ist nicht eingeloggt. Bestellungen können nur für eingeloggte Kunden abgerufen werden.',
            orders: []
        };
    }

    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 5, 50));

    try {
        log('SHOPWARE', 'Fetching orders with token:', contextToken.substring(0, 12) + '...');

        const sw = getShopwareConfig(tenant);
        const response = await fetchWithTimeout(`${sw.url}/store-api/order`, {
            method: 'POST',
            headers: {
                ...getHeaders(tenant),
                'sw-context-token': contextToken
            },
            body: JSON.stringify({
                limit: lim,
                page: 1,
                sort: [{ field: 'orderDateTime', order: 'DESC' }],
                associations: {
                    lineItems: {},
                    stateMachineState: {},
                    deliveries: {
                        associations: {
                            shippingMethod: {},
                            stateMachineState: {}
                        }
                    }
                }
            })
        }, 25000);

        if (response.status === 403 || response.status === 401) {
            log('SHOPWARE', 'Orders: Not authenticated');
            return {
                success: false,
                error: 'not_logged_in',
                message: 'Bitte loggen Sie sich ein, um Ihre Bestellungen zu sehen.',
                orders: []
            };
        }

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const elements = data.orders?.elements || data.elements || [];

        const orders = elements.map(order => {
            const lineItems = normalizeLineItems(order);

            return {
                id: order.id,
                orderNumber: order.orderNumber,
                date: order.orderDateTime,
                dateFormatted: new Date(order.orderDateTime).toLocaleDateString('de-DE', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric'
                }),
                total: order.amountTotal,
                totalFormatted: formatPrice(order.amountTotal),
                status: order.stateMachineState?.name || 'Unbekannt',
                deliveries: mapDeliveries(order),
                items: lineItems.map(item => ({
                    // productId (Shopware line item)
                    productId: item.productId || item.referencedId || null,
                    name: item.label,
                    quantity: item.quantity,
                    price: item.unitPrice,
                    priceFormatted: formatPrice(item.unitPrice)
                }))
            };
        });

        log('SHOPWARE', `Found ${orders.length} orders`);
        return { success: true, orders, count: orders.length };
    } catch (error) {
        log('SHOPWARE', 'Orders error:', error.message);
        return {
            success: false,
            error: 'api_error',
            message: 'Fehler beim Abrufen der Bestellungen.',
            orders: []
        };
    }
}

/**
 * Get order by orderNumber (best-effort search across last N orders)
 */
async function getOrderByNumber(contextToken, orderNumber, lookback = 25, tenant = null) {
    const num = String(orderNumber || '').trim();
    if (!num) return null;

    const result = await getOrders(contextToken, lookback, tenant);
    if (!result.success) return null;

    const found = (result.orders || []).find(o => String(o.orderNumber).trim() === num);
    return found || null;
}

/**
 * Get last order (newest)
 */
async function getLastOrder(contextToken, tenant = null) {
    const result = await getOrders(contextToken, 1, tenant);
    if (!result.success) return null;
    return result.orders?.[0] || null;
}

/**
 * Get categories
 */
async function getCategories(limit = 50, tenant = null) {
    const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));

    const tenantKey = tenant?.id ? `t${tenant.id}` : 'default';
    const cacheKey = `categories:${tenantKey}:${lim}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    try {
        const sw = getShopwareConfig(tenant);
        const response = await fetchWithTimeout(`${sw.url}/store-api/category`, {
            method: 'POST',
            headers: getHeaders(tenant),
            body: JSON.stringify({ limit: lim })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();

        const cats = (data.elements || [])
            .filter(c => c.visible !== false)
            .map(c => ({
                id: c.id,
                name: c.name,
                level: c.level,
                parentId: c.parentId
            }));

        cacheSet(cacheKey, cats, 10 * 60 * 1000);
        return cats;
    } catch (error) {
        log('SHOPWARE', 'Categories error:', error.message);
        return [];
    }
}

/**
 * Verify if a context token is valid and customer is logged in
 */
async function verifyCustomerSession(contextToken, tenant = null) {
    if (!contextToken) return { valid: false, loggedIn: false };

    try {
        const sw = getShopwareConfig(tenant);
        log('SHOPWARE', 'Verifying session', {
            url: sw.url,
            token: `${String(contextToken).slice(0, 8)}...`
        });
        const response = await fetchWithTimeout(`${sw.url}/store-api/account/customer`, {
            method: 'POST',
            headers: {
                ...getHeaders(tenant),
                'sw-context-token': contextToken
            },
            body: JSON.stringify({})
        });

        if (response.ok) {
            const customer = await response.json();
            return {
                valid: true,
                loggedIn: true,
                customer: {
                    firstName: customer.firstName,
                    lastName: customer.lastName,
                    email: customer.email
                }
            };
        }

        const status = response.status;
        let body = '';
        try { body = await response.text(); } catch (_) {}
        log('SHOPWARE', `Verify session failed (${status})`, body ? body.substring(0, 500) : '');
        return { valid: false, loggedIn: false };
    } catch (error) {
        log('SHOPWARE', 'Verify session error', error.message);
        return { valid: false, loggedIn: false };
    }
}

/**
 * Get cart summary from Store API using sw-context-token.
 * Works for guests and logged-in customers.
 */
async function getCart(contextToken, tenant = null) {
    if (!contextToken) {
        return { items: [], itemCount: 0, total: 0, contextToken: null };
    }

    try {
        const sw = getShopwareConfig(tenant);
        const response = await fetchWithTimeout(`${sw.url}/store-api/checkout/cart`, {
            method: 'POST',
            headers: { ...getHeaders(tenant), 'sw-context-token': contextToken },
            body: JSON.stringify({})
        }, 20000);
        const headerContextToken = response.headers.get('sw-context-token') || null;

        if (!response.ok) {
            return { items: [], itemCount: 0, total: 0, contextToken: headerContextToken || contextToken };
        }

        const data = await response.json().catch(() => ({}));
        const bodyContextToken = data?.token || data?.contextToken || data?.context_token || null;
        const lineItems = Array.isArray(data?.lineItems)
            ? data.lineItems
            : (Array.isArray(data?.lineItems?.elements) ? data.lineItems.elements : []);

        const items = lineItems
            .filter(li => li.type === 'product')
            .map(li => ({
                id: li.id,
                productId: li.referencedId || null,
                name: li.label,
                quantity: parseInt(li.quantity, 10) || 0,
                price: Number(li?.price?.unitPrice) || 0,
                totalPrice: Number(li?.price?.totalPrice) || 0
            }));

        const itemCount = items.reduce((sum, item) => sum + (item.quantity || 0), 0);
        const total = Number(data?.price?.totalPrice) || items.reduce((sum, item) => sum + (item.totalPrice || 0), 0);
        return { items, itemCount, total, contextToken: headerContextToken || bodyContextToken || contextToken };
    } catch (e) {
        return { items: [], itemCount: 0, total: 0, contextToken: contextToken || null };
    }
}

/**
 * Shipping methods (optionally language-aware, context-aware for costs)
 */
async function getShippingMethods(contextToken, tenant = null, languageId = null) {
    try {
        const sw = getShopwareConfig(tenant);
        const response = await fetchWithTimeout(`${sw.url}/store-api/checkout/shipping-method`, {
            method: 'POST',
            headers: getHeaders(tenant, { contextToken, languageId }),
            body: JSON.stringify({})
        }, 20000);

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        const elements = data.elements || [];
        return elements.map(m => ({
            id: m.id,
            name: m.name,
            description: stripHtml(m.description || ''),
            price: m.price?.gross ?? m.calculatedPrice?.unitPrice ?? null,
            priceFormatted: m.price?.gross ? formatPrice(m.price.gross) : null,
            active: m.active !== false
        }));
    } catch (_) {
        return [];
    }
}

/**
 * Payment methods (optionally language-aware)
 */
async function getPaymentMethods(contextToken, tenant = null, languageId = null) {
    try {
        const sw = getShopwareConfig(tenant);
        const response = await fetchWithTimeout(`${sw.url}/store-api/payment-method`, {
            method: 'POST',
            headers: getHeaders(tenant, { contextToken, languageId }),
            body: JSON.stringify({})
        }, 20000);

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        const elements = data.elements || [];
        return elements.map(m => ({
            id: m.id,
            name: m.name,
            description: stripHtml(m.description || ''),
            active: m.active !== false
        }));
    } catch (_) {
        return [];
    }
}

/**
 * Resolve a product identifier to a Shopware product UUID.
 * - If identifier already looks like UUID (32 hex), returns it.
 * - Otherwise: uses search and returns best match.
 */
async function resolveProductIdentifier(identifier, limit = 5, tenant = null) {
    const id = String(identifier || '').trim();
    if (!id) return { success: false, error: 'missing_identifier', product: null };

    // Shopware IDs are 32 hex
    if (/^[a-f0-9]{32}$/i.test(id)) {
        const product = await getProduct(id, tenant);
        return { success: true, resolved: true, product: product || { id } };
    }

    const buildVariants = (value) => {
        const raw = String(value || '').trim();
        if (!raw) return [];
        const variants = [];
        const seen = new Set();
        const add = (v) => {
            const cleaned = String(v || '').replace(/\s+/g, ' ').trim();
            if (!cleaned) return;
            const key = cleaned.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            variants.push(cleaned);
        };

        add(raw);

        const noParen = raw.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
        add(noParen);

        const beforeDash = raw.split(/\s[-–—]\s/)[0]?.trim();
        add(beforeDash);

        const beforeComma = raw.split(',')[0]?.trim();
        add(beforeComma);

        const tokens = raw.split(/\s+/).filter(Boolean);
        if (tokens.length > 6) {
            add(tokens.slice(0, 6).join(' '));
        }

        return variants;
    };

    const variants = buildVariants(id);
    let products = [];
    for (let i = 0; i < variants.length; i += 1) {
        const q = variants[i];
        const timeoutMs = i === 0 ? 12000 : 8000;
        const reason = i === 0 ? 'resolve_identifier' : 'resolve_identifier_fallback';
        products = await searchProducts(q, limit, tenant, { timeoutMs, reason });
        if (products.length) {
            if (i > 0) {
                log('SHOPWARE', 'Resolve identifier fallback matched', { query: q, attempt: i + 1 });
            }
            break;
        }
    }
    if (!products.length) {
        log('SHOPWARE', 'Resolve identifier failed', { identifier: id, attempts: variants.length });
        return { success: false, error: 'not_found', product: null };
    }

    const lower = id.toLowerCase();

    // Prefer exact SKU match
    const exactSku = products.find(p => (p.productNumber || '').toLowerCase() === lower);
    const exactName = products.find(p => (p.name || '').toLowerCase() === lower);

    const best = exactSku || exactName || products[0];
    return { success: true, resolved: true, product: best, candidates: products };
}

function formatPrice(price) {
    return new Intl.NumberFormat('de-DE', {
        style: 'currency',
        currency: 'EUR'
    }).format(price || 0);
}

module.exports = {
    searchProducts,
    getProduct,
    resolveProductIdentifier,
    refreshContextToken,
    getOrders,
    getOrderByNumber,
    getLastOrder,
    getCategories,
    verifyCustomerSession,
    getCart,
    getShippingMethods,
    getPaymentMethods,
    formatPrice
};
