/**
 * Chat Routes - Main streaming chat endpoint
 */
const express = require('express');
const router = express.Router();

const dify = require('../services/dify');
const shopware = require('../services/shopware');
const cartTracker = require('../services/cartTracker');
const { createSelection } = require('../services/selectionTracker');
const productListTracker = require('../services/productListTracker');
const tenantRepo = require('../repositories/tenantRepository');
const { log, logError } = require('../utils/logger');
const { resolveContextToken } = require('../utils/contextToken');

function isBuyIntent(text) {
    const t = String(text || '').toLowerCase();
    // Broad intent detection (DE + EN) for adding to cart / purchase
    return /(kauf|kaufen|bestell|bestellen|nachbestell|in den warenkorb|warenkorb|zum warenkorb|add to cart|buy this|purchase|order this|put\s+.+\s+in\s+(?:den\s+)?(?:warenkorb|basket)|in\s+basket|in\s+den\s+warenkorb|ich (möchte|will|würde gern).*(kaufen|bestellen|nehmen))/i.test(t);
}

function isRemoveIntent(text) {
    const t = String(text || '').toLowerCase();
    return /(entfern|entferne|entfernen|rausnehmen|raus|wegnehmen|löschen|loeschen|streichen|remove|delete|take out|from (my )?cart|aus (meinem )?warenkorb|vom (meinem )?warenkorb)/i.test(t);
}

function isRemoveAllIntent(text) {
    const t = String(text || '').toLowerCase();
    return /\b(alle|alles|komplett|vollständig|vollstaendig|ganz|gesamt|sämtlich|saemtlich)\b/i.test(t);
}

function parseRemoveQuantity(text) {
    const t = String(text || '').toLowerCase();
    if (!t) return null;

    // Quick "one" patterns
    if (/\b(ein|eine|eins|einmal|nur\s+eine?|eine?\s+davon|davon\s+eine?|ein\s+stück|eine?\s+stück|one\s+of\s+(them|those)|remove\s+one|only\s+one)\b/i.test(t)) {
        return 1;
    }

    const wordMap = new Map([
        ['eins', 1],
        ['ein', 1],
        ['eine', 1],
        ['einer', 1],
        ['einen', 1],
        ['zwei', 2],
        ['drei', 3],
        ['vier', 4],
        ['fünf', 5],
        ['fuenf', 5],
        ['funf', 5],
        ['sechs', 6],
        ['sieben', 7],
        ['acht', 8],
        ['neun', 9],
        ['zehn', 10]
    ]);

    const wordPattern = Array.from(wordMap.keys()).join('|');

    // "2 davon" or "davon 2" or "zwei davon"
    let m = t.match(new RegExp(`\\b(\\d+|${wordPattern})\\s*(?:davon|stück|stueck|stück|stk|pcs|pieces)\\b`, 'i'));
    if (m) {
        const raw = m[1];
        if (/^\d+$/.test(raw)) return parseInt(raw, 10);
        return wordMap.get(raw) || null;
    }
    m = t.match(new RegExp(`\\b(?:davon|von\\s+den|von\\s+denen)\\s*(\\d+|${wordPattern})\\b`, 'i'));
    if (m) {
        const raw = m[1];
        if (/^\d+$/.test(raw)) return parseInt(raw, 10);
        return wordMap.get(raw) || null;
    }

    // "entferne 2" / "remove 2"
    m = t.match(/\b(?:entfern|entferne|entfernen|lösche|loesche|remove|delete|take out)\b[^0-9]{0,4}(\d+)\b/i);
    if (m) {
        return parseInt(m[1], 10);
    }

    return null;
}

function normalizeMatchText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9äöüß]+/gi, ' ')
        .trim();
}

function tokensForMatch(text) {
    const norm = normalizeMatchText(text);
    if (!norm) return [];
    return norm.split(/\s+/).filter(t => t && (t.length >= 2 || /\d/.test(t)));
}

function findCartItemMatch(message, items) {
    const msgNorm = normalizeMatchText(message || '');
    if (!msgNorm || !Array.isArray(items) || items.length === 0) return null;

    const msgTokens = new Set(tokensForMatch(message));
    let best = null;

    for (const item of items) {
        const name = item?.name || '';
        const nameNorm = normalizeMatchText(name);
        if (!nameNorm) continue;

        const nameTokens = tokensForMatch(name);
        let matched = 0;
        let score = 0;

        if (msgNorm.includes(nameNorm)) {
            matched = nameTokens.length || 1;
            score = 1;
        } else if (nameTokens.length) {
            for (const token of nameTokens) {
                if (msgTokens.has(token)) matched++;
            }
            score = matched / nameTokens.length;
        }

        if (!best || score > best.score || (score === best.score && matched > best.matched)) {
            best = { item, score, matched, tokenCount: nameTokens.length };
        }
    }

    if (best) {
        const strong = best.score >= 0.6
            || best.matched >= 3
            || (best.score >= 0.5 && best.tokenCount >= 4);
        if (strong) return best.item;
    }

    if (items.length === 1) return items[0];
    return null;
}

function shouldRunImagePipeline(message) {
    const t = String(message || '').toLowerCase().trim();

    // If user only sent an image (no text) -> run pipeline
    if (!t) return true;

    // Any explicit buy intent
    if (isBuyIntent(t)) return true;

    // Quantity-ish patterns usually mean purchase intent, especially with image
    if (/(\b\d+\s*(x|stk|stück|stueck|stuck)\b)|((\bqty\b|quantity)\s*\d+)/i.test(t)) return true;

    // Common context phrases users type when attaching a photo
    if (/(foto|photo|bild|anhang|siehe bild|siehe foto)/i.test(t)) return true;

    return false;
}
// Heuristic: is this message a textual product search (e.g. "ich suche latex handschuhe", "I'm looking for gloves")
function isProductSearch(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return false;

    // German search verbs/phrases
    if (/\b(suche|ich suche|finde|gibt es|haben sie|wo (gibt es|finde)|produkten?|artikel)\b/i.test(t)) return true;

    // English search verbs/phrases
    if (/\b(search|find|looking for|do you have|show me|i need|i want|where can i find|products?)\b/i.test(t)) return true;

    // Short queries (1-3 words) are likely product searches
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 0 && words.length <= 3) return true;

    return false;
}

function isAffirmative(text) {
    return /^(ja|yes|y|klar|ok|okay|bitte|gerne)\b/i.test(String(text || '').trim());
}

function isNegative(text) {
    return /^(nein|no|n|nicht|abbrechen|stopp|stop)\b/i.test(String(text || '').trim());
}

function parseNumericChoice(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;

    // Direct numeric (including "1." or "1)")
    const numMatch = t.match(/\b(\d+)\b/);
    if (numMatch) {
        const n = parseInt(numMatch[1], 10);
        if (Number.isFinite(n) && n > 0) return n;
    }

    // Ordinal numeric suffix (1st, 2nd, 3rd, 4th)
    const ordMatch = t.match(/\b(\d+)(?:st|nd|rd|th)\b/);
    if (ordMatch) {
        const n = parseInt(ordMatch[1], 10);
        if (Number.isFinite(n) && n > 0) return n;
    }

    const ordinalMap = [
        { n: 1, re: /\b(erste|erster|erstes|ersten|first)\b/ },
        { n: 2, re: /\b(zweite|zweiter|zweites|zweiten|second)\b/ },
        { n: 3, re: /\b(dritte|dritter|drittes|dritten|third)\b/ },
        { n: 4, re: /\b(vierte|vierter|viertes|vierten|fourth)\b/ },
        { n: 5, re: /\b(fünfte|fuenfte|funfte|fünfter|fuenfter|funfter|fünftes|fuenftes|funftes|fünften|fuenften|funften|fifth)\b/ },
        { n: 6, re: /\b(sechste|sechster|sechstes|sechsten|sixth)\b/ },
        { n: 7, re: /\b(siebte|siebter|siebtes|siebten|seventh)\b/ },
        { n: 8, re: /\b(achte|achter|achtes|achten|eighth)\b/ },
        { n: 9, re: /\b(neunte|neunter|neuntes|neunten|ninth)\b/ },
        { n: 10, re: /\b(zehnte|zehnter|zehntes|zehnten|tenth)\b/ }
    ];
    for (const { n, re } of ordinalMap) {
        if (re.test(t)) return n;
    }

    const words = t.split(/\s+/).filter(Boolean);
    const allowCardinal = words.length === 1
        || /\bbitte\b/i.test(t)
        || /\b(nummer|nr|auswahl|option|position|punkt)\b/i.test(t);

    if (allowCardinal) {
        const cardinalMap = [
            { n: 1, re: /\b(eins|ein|eine|einen|einem|eines)\b/ },
            { n: 2, re: /\b(zwei)\b/ },
            { n: 3, re: /\b(drei)\b/ },
            { n: 4, re: /\b(vier)\b/ },
            { n: 5, re: /\b(fünf|fuenf|funf)\b/ },
            { n: 6, re: /\b(sechs)\b/ },
            { n: 7, re: /\b(sieben)\b/ },
            { n: 8, re: /\b(acht)\b/ },
            { n: 9, re: /\b(neun)\b/ },
            { n: 10, re: /\b(zehn)\b/ }
        ];
        for (const { n, re } of cardinalMap) {
            if (re.test(t)) return n;
        }
    }

    return null;
}

function extractNumberedProductList(text) {
    const extractProductIdFromText = (value) => {
        if (!value) return null;
        const str = String(value);
        const match = str.match(/\/detail\/([a-f0-9]{32})/i)
            || str.match(/\b([a-f0-9]{32})\b/i)
            || str.match(/\/([a-f0-9]{32})(?:[/?#]|$)/i);
        return match ? match[1] : null;
    };

    const lines = String(text || '').split(/\r?\n/);
    const items = [];
    let priceSeen = false;
    let current = null;

    const pushCurrent = () => {
        if (current && current.name) {
            items.push(current);
        }
        current = null;
    };

    for (const line of lines) {
        const normalizedLine = String(line || '')
            .replace(/^\s*[\-*]\s+/, '')
            .replace(/^\s*\*\*\s*/, '')
            .replace(/\s*\*\*\s*$/, '');
        const m = normalizedLine.match(/^\s*(\d+)\s*[\.\)\-:–—]\s*(.+)$/);
        if (m) {
            pushCurrent();

            const index = parseInt(m[1], 10);
            let value = String(m[2] || '').trim();
            if (!value || value.startsWith('![')) continue;

            if (value.includes('€') || /\bEUR\b/i.test(value)) priceSeen = true;

            const inlineProductId = extractProductIdFromText(value);

            // Convert markdown links to plain text
            value = value.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
            value = value.replace(/\*\*/g, '').replace(/__+/g, '');

            // Strip trailing price/extra info for a cleaner search term
            let name = value;
            name = name.replace(/\s*[-–—]\s*\d+[.,]\d+\s*€.*$/i, '');
            name = name.replace(/\s*\(\s*\d+[.,]\d+\s*€\s*\).*$/i, '');
            name = name.replace(/\s*\d+[.,]\d+\s*€.*$/i, '');
            name = name.replace(/\s*€.*$/i, '');
            name = name.replace(/\s*-\s*$/, '').trim();

            if (!name) continue;

            current = { index, name, raw: value, productId: inlineProductId || null };
            continue;
        }

        if (current) {
            const urlMatch = line.match(/\((https?:\/\/[^)]+)\)/i) || line.match(/https?:\/\/\S+/i);
            const url = urlMatch ? (urlMatch[1] || urlMatch[0]) : null;
            if (url) {
                const idMatch = extractProductIdFromText(url);
                if (idMatch) current.productId = idMatch;
            }
        }
    }

    pushCurrent();

    items.sort((a, b) => a.index - b.index);

    // Keep only contiguous 1..N
    const normalized = [];
    for (const item of items) {
        if (item.index === normalized.length + 1) {
            normalized.push(item);
        }
    }

    return { items: normalized, priceSeen };
}

function normalizeAssistantText(text) {
    return String(text || '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*/g, '')
        .replace(/__+/g, '')
        .replace(/\r/g, '')
        .trim();
}

function cleanProductNameCandidate(value) {
    let name = String(value || '')
        .replace(/^[\s✓✅•\-]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (!name) return null;

    name = name.replace(/^["'`“”„]+|["'`“”„]+$/g, '').trim();
    name = name.replace(/^(?:der|die|das|den|dem|ein|eine|einen|einem|einer|the|this)\s+/i, '').trim();
    name = name.replace(/\s*\(\s*[^)]*(?:€|eur|usd)\s*[^)]*\)\s*$/i, '').trim();
    name = name.replace(/\s+(?:für|for)\s+[$€£]?\d[\d.,]*.*$/i, '').trim();
    name = name.replace(/\s*[\.\!\?]+$/, '').trim();

    if (!name) return null;
    if (/^(?:dieses?\s+produkt|produkt|artikel|this\s+product|item|it)$/i.test(name)) return null;
    return name;
}

/** Extract first product ID (32 hex) from assistant text, e.g. from /detail/xxx or markdown links. */
function extractProductIdFromAnswer(text) {
    if (!text) return null;
    const str = String(text);
    const match = str.match(/\/detail\/([a-f0-9]{32})/i)
        || str.match(/\(https?:\/\/[^)]*\/detail\/([a-f0-9]{32})/i)
        || str.match(/\b([a-f0-9]{32})\b/i);
    return match ? match[1] : null;
}

function extractAddedProductNameFromText(text) {
    const normalized = normalizeAssistantText(text);
    if (!normalized) return null;

    const lines = normalized.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const patterns = [
        /^(?:[✓✅]\s*)?(.+?)(?:\s*\(\s*[^)]*(?:€|eur|usd)\s*[^)]*\)\s*)?\s+(?:wurde|ist)\s+(?:zum|in den)\s+warenkorb\s+hinzugefügt\b/i,
        /^(?:[✓✅]\s*)?(.+?)\s+(?:was|has been)\s+added\s+to\s+(?:your\s+)?(?:cart|basket)\b/i
    ];

    for (const line of lines) {
        for (const re of patterns) {
            const match = line.match(re);
            if (!match || !match[1]) continue;
            const cleaned = cleanProductNameCandidate(match[1]);
            if (cleaned) return cleaned;
        }
    }

    return null;
}

/**
 * Extract product name from user message for add-to-cart intent.
 * E.g. "put Medicom SafeSeal in basket" -> "Medicom SafeSeal"
 */
function extractProductNameFromUserMessage(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    const lower = t.toLowerCase();
    const patterns = [
        /\b(?:put|add|lege|pack|nimm|rein|füge\s+hinzu)\s+(.+?)\s+(?:in\s+(?:den\s+)?(?:warenkorb|basket)|zum\s+warenkorb)\b/i,
        /\b(?:in\s+den\s+warenkorb|zum\s+warenkorb)\s+(?:legen|packen|hinzufügen)?\s*[:\s]*\s*(.+?)(?:\s*[.!?]|$)/i,
        /\b(?:add|put)\s+(.+?)\s+to\s+(?:my\s+)?(?:cart|basket)\b/i,
        /(.+?)\s+(?:bitte\s+)?(?:in\s+den\s+warenkorb|zum\s+warenkorb)\b/i
    ];
    for (const re of patterns) {
        const match = t.match(re);
        if (match && match[1]) {
            const cleaned = cleanProductNameCandidate(match[1]);
            if (cleaned && cleaned.length >= 3) return cleaned;
        }
    }
    return null;
}

function normalizeTextSearchMode(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 'shopware' : 'dify';
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return normalized || null;
}

// Resolve how text-only product searches should be handled.
// Default: prefer Dify (so chatbot matches direct Dify results).
function resolveTextSearchMode(req) {
    const body = req.body || {};
    if (body.force_dify === true) return 'dify';
    if (String(req.headers['x-cc-force-dify'] || '').toLowerCase() === 'true') return 'dify';
    const headerMode = req.headers['x-cc-text-search-mode'] || req.headers['x-cc-search-mode'] || null;
    const bodyMode = body.text_search_mode || body.search_mode || body.textSearchMode || body.searchMode || null;
    const configMode = req.tenant?.dify?.modelConfig?.text_search_mode
        || req.tenant?.dify?.modelConfig?.textSearchMode
        || req.tenant?.dify?.modelConfig?.search_mode
        || req.tenant?.dify?.modelConfig?.searchMode
        || null;

    const configNormalized = normalizeTextSearchMode(configMode);
    if (configNormalized) return configNormalized;

    if (body.use_shopware_search === true) return 'shopware';
    if (body.use_shopware_search === false) return 'dify';

    return normalizeTextSearchMode(bodyMode)
        || normalizeTextSearchMode(headerMode)
        || 'dify';
}

function shouldUseShopwareTextSearch(req, message) {
    if (!isProductSearch(message || '')) return false;

    const mode = resolveTextSearchMode(req);
    return ['shopware', 'store', 'shop', 'catalog'].includes(mode);
}
function resolveLanguageHint(req) {
    const body = req.body || {};
    return (
        body.language ||
        body.language_code ||
        body.languageCode ||
        req.headers['x-cc-language'] ||
        req.headers['accept-language'] ||
        null
    );
}

function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function emitCartActions(res, cartActions) {
    if (!Array.isArray(cartActions) || !cartActions.length) return;
    log('CHAT', 'Emitting cart_actions', {
        count: cartActions.length,
        types: cartActions.map(a => a?.type),
        productIds: cartActions.map(a => (a?.productId || '').slice(0, 8))
    });
    writeSse(res, { cart_action: cartActions[0] });
    writeSse(res, { cart_actions: cartActions });
}

function emitConversationId(res, conversationId) {
    if (!conversationId) return;
    writeSse(res, { conversation_id: conversationId });
}

function getQueuedCartActions(userId, tenantId) {
    let actions = cartTracker.getCartActions(userId, tenantId);
    // Backwards compatibility: older tool calls were stored without tenant scope.
    if (!actions.length && tenantId) {
        actions = cartTracker.getCartActions(userId, null);
    }
    return actions;
}

function emitQueuedCartActions(res, userId, tenantId) {
    const cartActions = getQueuedCartActions(userId, tenantId);
    if (!cartActions.length) return [];

    emitCartActions(res, cartActions);
    return cartActions;
}


/**
 * Streaming chat endpoint
 */
router.post('/stream', async (req, res) => {
    const body = req.body || {};
    const {
        message,
        conversation_id,
        user,
        cart,
        image,
        shop_info,
        extra_instructions
    } = body;

        const userMessage = String(message || '').trim();
    let resolvedContextToken = resolveContextToken(req, { bodyKeys: ['context_token', 'contextToken'] }).token;
    const cookieHeader = req.headers.cookie || '';

    log('CHAT', 'Stream start', {
        user,
        hasContextToken: !!resolvedContextToken,
        contextTokenSource: resolvedContextToken ? 'body/header/cookie' : 'none',
        hasCookie: !!cookieHeader
    });

    if (!message && !image) {
        return res.status(400).json({ error: 'Message or image is required' });
    }

    let keepalive = null;

    try {
        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Debug info (no image content logged)
        if (image) {
            const len = typeof image === 'string' ? image.length : 0;
            log('CHAT', `Incoming image attached (len=${len})`);
        }


        // Keepalive: helps avoid proxy idle timeouts
        keepalive = setInterval(() => {
            try { res.write(': keepalive\n\n'); } catch (_) { }
        }, 15000);

        // Verify session (if any)
        let customerInfo = { valid: false, loggedIn: false, customer: null };
        if (resolvedContextToken) {
            customerInfo = await shopware.verifyCustomerSession(resolvedContextToken, req.tenant);
            if (!customerInfo.loggedIn && cookieHeader) {
                const refresh = await shopware.refreshContextToken(resolvedContextToken, cookieHeader, req.tenant);
                if (refresh?.success && refresh.token && refresh.token !== resolvedContextToken) {
                    log('CHAT', 'Context token refreshed for session');
                    resolvedContextToken = refresh.token;
                    customerInfo = await shopware.verifyCustomerSession(resolvedContextToken, req.tenant);
                }
            }
        }

        // Orders (only when relevant)
        const asksAboutOrders = /bestell|order|liefer|sendung|paket|tracking|nachbestell/i.test(message || '');
        let orders = [];
        if (asksAboutOrders && resolvedContextToken) {
            const orderResult = await shopware.getOrders(resolvedContextToken, 3, req.tenant);
            if (orderResult.success) {
                orders = orderResult.orders || [];
                if (!customerInfo.loggedIn) {
                    customerInfo = { ...customerInfo, valid: true, loggedIn: true };
                }
                log('CHAT', `Orders fetched: ${orders.length}`);
            } else {
                log('CHAT', `Orders fetch failed: ${orderResult.error || 'unknown'}`);
            }
        }

        // Use cart from body if present; otherwise fetch when we have a context token (guest or logged-in)
        let effectiveCart = cart;
        if ((!effectiveCart || !effectiveCart.items) && resolvedContextToken) {
            try {
                const fetched = await shopware.getCart(resolvedContextToken, req.tenant);
                if (fetched?.items) {
                    effectiveCart = fetched;
                    if (fetched.contextToken && fetched.contextToken !== resolvedContextToken) {
                        resolvedContextToken = fetched.contextToken;
                    }
                }
            } catch (_) {}
        }

        log('CHAT', `User: ${user} | LoggedIn: ${customerInfo.loggedIn} | Cart: ${effectiveCart?.itemCount || 0} | Orders: ${orders.length}`);

        // ---------------------------------------------------------------------
        // Deterministic selection flow (from last Dify product list)
        // ---------------------------------------------------------------------
        const pending = productListTracker.getPending(req.tenant?.id, user);
        if (pending && isAffirmative(userMessage)) {
            cartTracker.addCartAction(
                pending.productId,
                pending.productName,
                pending.quantity || 1,
                user,
                req.tenant?.id
            );

            productListTracker.clearPending(req.tenant?.id, user);

            writeSse(res, { text: `✓ ${pending.productName} wurde zum Warenkorb hinzugefügt! 🛒` });
            emitConversationId(res, conversation_id);
            emitQueuedCartActions(res, user, req.tenant?.id);
            res.write('data: [DONE]\n\n');
            clearInterval(keepalive);
            return res.end();
        }

        if (pending && isNegative(userMessage)) {
            productListTracker.clearPending(req.tenant?.id, user);
            writeSse(res, { text: 'Alles klar, ich habe nichts hinzugefügt.' });
            emitConversationId(res, conversation_id);
            res.write('data: [DONE]\n\n');
            clearInterval(keepalive);
            return res.end();
        }

        const numericChoice = parseNumericChoice(userMessage);
        const listEntry = productListTracker.getList(req.tenant?.id, user);
        const maxReasonableChoice = 20;
        const isReasonableListIndex = numericChoice !== null && numericChoice >= 1 && numericChoice <= maxReasonableChoice;
        if (isReasonableListIndex && listEntry?.items?.length) {
            const item = listEntry.items[numericChoice - 1];
            if (!item) {
                writeSse(res, { text: `Bitte wählen Sie eine Zahl zwischen 1 und ${listEntry.items.length}.` });
                emitConversationId(res, conversation_id);
                res.write('data: [DONE]\n\n');
                clearInterval(keepalive);
                return res.end();
            }

                // Clear any stale pending confirmation before setting a new one
                productListTracker.clearPending(req.tenant?.id, user);

                let resolved = null;
                if (item.productId && /^[a-f0-9]{32}$/i.test(item.productId)) {
                    resolved = {
                        success: true,
                        product: { id: item.productId, name: item.name }
                    };
                    log('CHAT', 'Selection uses productId from list', {
                        name: item.name,
                        productId: item.productId
                    });
                } else {
                    const startedAt = Date.now();
                    resolved = await shopware.resolveProductIdentifier(item.name, 5, req.tenant);
                    log('CHAT', 'Selection resolve done', {
                        name: item.name,
                        ms: Date.now() - startedAt,
                        success: !!resolved?.success,
                        productId: resolved?.product?.id || null
                    });
                }
                if (!resolved?.success || !resolved.product?.id) {
                    writeSse(res, { text: 'Ich konnte das Produkt nicht eindeutig zuordnen. Bitte nennen Sie den Produktnamen.' });
                    emitConversationId(res, conversation_id);
                    res.write('data: [DONE]\n\n');
                    clearInterval(keepalive);
                    return res.end();
                }

                const productName = resolved.product.name || item.name;
                const price = resolved.product.priceFormatted ? ` (${resolved.product.priceFormatted})` : '';
                const directAdd = !!listEntry?.meta?.addOnSelect
                    || isBuyIntent(userMessage)
                    || /\b(bitte|nehmen|nimm|pack|lege|rein|in den warenkorb|zum warenkorb|add to cart|buy|order|purchase)\b/i.test(userMessage || '');

                if (directAdd) {
                    cartTracker.addCartAction(
                        resolved.product.id,
                        productName,
                        1,
                        user,
                        req.tenant?.id
                    );

                    productListTracker.clearPending(req.tenant?.id, user);
                    productListTracker.clearList(req.tenant?.id, user);

                    writeSse(res, { text: `✓ ${productName}${price} wurde zum Warenkorb hinzugefügt! 🛒` });
                    emitConversationId(res, conversation_id);
                    emitQueuedCartActions(res, user, req.tenant?.id);
                    res.write('data: [DONE]\n\n');
                    clearInterval(keepalive);
                    return res.end();
                }

                productListTracker.setPending(req.tenant?.id, user, {
                    productId: resolved.product.id,
                    productName,
                    quantity: 1
                });
                // Prevent re-use of the list for a different selection
                productListTracker.clearList(req.tenant?.id, user);

                writeSse(res, { text: `Möchten Sie ${productName}${price} zum Warenkorb hinzufügen? 🛒` });
                emitConversationId(res, conversation_id);
                res.write('data: [DONE]\n\n');
                clearInterval(keepalive);
                return res.end();
        }
        if (numericChoice !== null && !listEntry?.items?.length && numericChoice <= maxReasonableChoice) {
            log('CHAT', 'Numeric choice but no product list', {
                choice: numericChoice,
                user,
                tenant: req.tenant?.id || 'default'
            });
        }

        // ---------------------------------------------------------------------
        // Deterministic removal flow (match cart item from user message)
        // ---------------------------------------------------------------------
        if (isRemoveIntent(userMessage) && Array.isArray(effectiveCart?.items) && effectiveCart.items.length) {
            let item = findCartItemMatch(userMessage, effectiveCart.items);
            const choice = parseNumericChoice(userMessage);
            if (!item && choice && choice <= effectiveCart.items.length) {
                item = effectiveCart.items[choice - 1];
            }

            if (item) {
                const currentQty = parseInt(item.quantity, 10) || 1;
                let removeQty = parseRemoveQuantity(userMessage);
                const removeAll = isRemoveAllIntent(userMessage);

                if (currentQty > 1) {
                    if (removeAll) {
                        removeQty = currentQty;
                    } else if (!removeQty) {
                        removeQty = 1; // default to removing one for safety
                    }
                } else {
                    removeQty = 1;
                }

                if (removeQty >= currentQty) {
                    cartTracker.removeCartAction(
                        item.id || null,
                        item.productId || null,
                        item.name || 'Artikel',
                        user,
                        req.tenant?.id
                    );

                    log('CHAT', `Remove intent matched (full): ${item.name || 'Artikel'}`);

                    writeSse(res, { text: `✓ ${item.name || 'Artikel'} wurde aus dem Warenkorb entfernt! 🛒` });
                    emitConversationId(res, conversation_id);
                    emitQueuedCartActions(res, user, req.tenant?.id);
                    res.write('data: [DONE]\n\n');
                    clearInterval(keepalive);
                    return res.end();
                }

                const newQty = Math.max(currentQty - removeQty, 1);
                cartTracker.updateCartQuantityAction(
                    item.id || null,
                    item.productId || null,
                    item.name || 'Artikel',
                    newQty,
                    user,
                    req.tenant?.id
                );

                log('CHAT', `Remove intent matched (decrement): ${item.name || 'Artikel'} -${removeQty} -> ${newQty}`);

                writeSse(res, { text: `✓ ${item.name || 'Artikel'}: Menge reduziert (${removeQty} entfernt, jetzt ${newQty}). 🛒` });
                emitConversationId(res, conversation_id);
                emitQueuedCartActions(res, user, req.tenant?.id);
                res.write('data: [DONE]\n\n');
                clearInterval(keepalive);
                return res.end();
            }

            if (effectiveCart.items.length > 1) {
                const lines = effectiveCart.items
                    .slice(0, 5)
                    .map((ci, idx) => `${idx + 1}. ${ci.name || 'Artikel'}`)
                    .join('\n');

                writeSse(res, { text: `Welchen Artikel möchten Sie entfernen?\n${lines}` });
                emitConversationId(res, conversation_id);
                res.write('data: [DONE]\n\n');
                clearInterval(keepalive);
                return res.end();
            }
        }

        // ---------------------------------------------------------------------
        // AUTOMATIC MULTIMODAL PIPELINE (image -> extract -> search -> suggest)
        // Trigger only when user intent is to buy/add.
        // ---------------------------------------------------------------------
        let cachedDifyFiles = null;
        if (image && shouldRunImagePipeline(message || '')) {
            const extracted = await dify.extractProductQueryFromImage(image, user, message || '', req.tenant);
            cachedDifyFiles = extracted?.difyFiles || null;
            const query = (extracted.query || '').trim();

            if (query) {
                const suggestions = await shopware.searchProducts(query, 3, req.tenant, { reason: 'image_pipeline' });

                if (suggestions.length) {
                    const selectionId = createSelection(user, query, extracted.quantity || 1, suggestions, req.tenant?.id);

                    const intro = [
                        `Ich habe im Bild folgendes erkannt: **${query}**.`,
                        'Bitte wählen Sie das passende Produkt aus:'
                    ].join('\n');

                    writeSse(res, { text: intro });
                    emitConversationId(res, conversation_id);

                    writeSse(res, {
                        product_suggestions: {
                            selection_id: selectionId,
                            query,
                            quantity: extracted.quantity || 1,
                            confidence: extracted.confidence,
                            suggestions
                        }
                    });

                    res.write('data: [DONE]\n\n');
                    clearInterval(keepalive);
                    return res.end();
                }
            }

            // If extraction/search fails, continue with normal chat as fallback
            log('CHAT', 'Image pipeline: no query/matches -> fallback to dify');
        }

        // ---------------------------------------------------------------------
        // Product search fallback (text queries)
        // ---------------------------------------------------------------------
        // Optional: call Shopware directly and return structured product suggestions.
        // Default is Dify-first to match direct Dify results.
        if (shouldUseShopwareTextSearch(req, message || '')) {
            try {
                const suggestions = await shopware.searchProducts(message, 5, req.tenant, { reason: 'text_search' });
                if (suggestions.length) {
                    const selectionId = createSelection(user, message, 1, suggestions, req.tenant?.id);

                    const intro = [`Ich habe folgende Produkte für "${message}" gefunden:`].join('\n');

                    writeSse(res, { text: intro });
                    emitConversationId(res, conversation_id);

                    writeSse(res, {
                        product_suggestions: {
                            selection_id: selectionId,
                            query: message,
                            quantity: 1,
                            confidence: null,
                            suggestions
                        }
                    });

                    res.write('data: [DONE]\n\n');
                    clearInterval(keepalive);
                    return res.end();
                }
            } catch (e) {
                log('CHAT', 'Product search fallback failed:', e.message);
                // Fall through to Dify if search failed
            }
        }

        // ---------------------------------------------------------------------
        // Default: stream from Dify
        // ---------------------------------------------------------------------
        const languageHint = resolveLanguageHint(req);
        if (shop_info && typeof shop_info === 'object') {
            log('CHAT', 'Shop info for Dify', {
                hasOpeningHours: !!shop_info.openingHours,
                hasContact: !!shop_info.contact,
                hasReturnPolicy: !!shop_info.returnPolicy,
                hasAboutUs: !!shop_info.aboutUs,
                shippingCount: Array.isArray(shop_info.shippingMethods) ? shop_info.shippingMethods.length : 0,
                paymentCount: Array.isArray(shop_info.paymentMethods) ? shop_info.paymentMethods.length : 0
            });
        }

        const difyResponse = await dify.streamChat(
            message || '',
            user,
            conversation_id,
            {
                cart: effectiveCart,
                orders,
                customer: customerInfo.customer,
                isLoggedIn: customerInfo.loggedIn,
                askedAboutOrders: asksAboutOrders,
                languageHint,
                shopInfo: shop_info,
                extraInstructions: extra_instructions,
                image,
                // Reuse already-uploaded file ids to avoid an additional upload
                difyFiles: cachedDifyFiles
            },
            req.tenant
        );

        const reader = difyResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullAnswer = '';
        let convId = conversation_id;
        let tokensUsed = null;

        let clientDisconnected = false;
        req.on('close', () => {
            clientDisconnected = true;
            try { reader.cancel(); } catch (e) { }
            if (keepalive) {
                try { clearInterval(keepalive); } catch (e) { }
                keepalive = null;
            }
        });

        while (true) {
            if (clientDisconnected) break;
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;

                const jsonStr = line.substring(6).trim();
                if (!jsonStr || jsonStr === '[DONE]') continue;

                try {
                    const event = JSON.parse(jsonStr);

                    // Handle text chunks
                    if (event.event === 'message' || event.event === 'agent_message') {
                        const text = event.answer || '';
                        if (text) {
                            fullAnswer += text;
                            res.write(`data: ${JSON.stringify({ text })}\n\n`);
                        }
                    }

                    // Conversation ID
                    if (event.conversation_id && !convId) {
                        convId = event.conversation_id;
                        res.write(`data: ${JSON.stringify({ conversation_id: convId })}\n\n`);
                    }

                    // Token usage (best-effort)
                    const usage = event?.metadata?.usage || event?.usage || null;
                    const totalTokensRaw = usage?.total_tokens ?? usage?.totalTokens ?? event?.total_tokens ?? null;
                    const totalTokens = Number(totalTokensRaw);
                    if (Number.isFinite(totalTokens)) {
                        tokensUsed = totalTokens;
                    }

                } catch (_) {
                    // ignore malformed chunk
                }
            }
        }

        // ---------------------------------------------------------------------
        // Parse Dify answer for numbered product lists (store for selection)
        // ---------------------------------------------------------------------
        if (fullAnswer) {
            const parsed = extractNumberedProductList(fullAnswer);
            if ((parsed.items.length >= 2 && parsed.priceSeen) || parsed.items.length >= 3) {
                log('CHAT', 'Parsed product list', {
                    count: parsed.items.length,
                    withIds: parsed.items.filter(i => i.productId).length,
                    sample: parsed.items.slice(0, 2)
                });
                const addOnSelect = /(zum|in den)\s+warenkorb|warenkorb\s+(hinzufügen|legen)|add to cart|to cart/i.test(fullAnswer);
                productListTracker.storeList(req.tenant?.id, user, parsed.items, { addOnSelect });
            }
        }

        // ---------------------------------------------------------------------
        // Cart actions (FIFO queue)
        // ---------------------------------------------------------------------
        let cartActions = getQueuedCartActions(user, req.tenant?.id);
        let cartActionsSource = cartActions.length ? 'queue' : null;

        // Legacy marker fallback: [ADD_TO_CART:...], [REMOVE_FROM_CART:...], ...
        if (!cartActions.length) {
            const legacy = cartTracker.parseCartActionFromText(fullAnswer);
            if (legacy) {
                cartActions = [legacy];
                cartActionsSource = 'legacy_text';
                log('CHAT', 'Legacy cart action parsed', { type: legacy.type });
            }
        }

        // Compatibility fallback: infer from Dify answer or from user message ("put X in basket").
        // Prefer product ID from Dify's answer (e.g. detail URL) so we skip slow Shopware search when Dify already found the product.
        if (!cartActions.length && (isAffirmative(userMessage) || isBuyIntent(userMessage))) {
            const productIdFromAnswer = extractProductIdFromAnswer(fullAnswer);
            if (productIdFromAnswer) {
                const product = await shopware.getProduct(productIdFromAnswer, req.tenant);
                if (product?.id) {
                    cartActions = [{
                        type: 'add',
                        productId: product.id,
                        productName: product.name || 'Produkt',
                        quantity: 1
                    }];
                    cartActionsSource = 'inferred_from_answer_link';
                    log('CHAT', 'Inferred add-to-cart from Dify answer link', {
                        productId: product.id,
                        productName: product.name
                    });
                }
            }
            if (!cartActions.length) {
                let inferredName = extractAddedProductNameFromText(fullAnswer);
                if (!inferredName && isBuyIntent(userMessage)) {
                    inferredName = extractProductNameFromUserMessage(userMessage);
                    if (inferredName) log('CHAT', 'Inferred product name from user message', { inferredName });
                }
                if (inferredName) {
                    const resolved = await shopware.resolveProductIdentifier(inferredName, 5, req.tenant);
                    log('CHAT', 'Inference resolution result', {
                        inferredName,
                        success: !!resolved?.success,
                        productId: resolved?.product?.id || null,
                        error: resolved?.error || null
                    });
                    if (resolved?.success && resolved.product?.id) {
                        cartActions = [{
                            type: 'add',
                            productId: resolved.product.id,
                            productName: resolved.product.name || inferredName,
                            quantity: 1
                        }];
                        cartActionsSource = inferredName === extractAddedProductNameFromText(fullAnswer) ? 'inferred_from_answer' : 'inferred_from_user_message';
                        log('CHAT', 'Inferred add-to-cart', {
                            inferredName,
                            productId: resolved.product.id,
                            productName: resolved.product.name,
                            source: cartActionsSource
                        });
                    } else {
                        log('CHAT', 'Inferred name but product not resolved', { inferredName, error: resolved?.error });
                    }
                }
            }
        }

        log('CHAT', 'Cart actions summary', {
            count: cartActions.length,
            source: cartActionsSource,
            types: cartActions.map(a => a?.type)
        });

        if (!cartActions.length) {
            log('CHAT', 'No cart actions to emit (queue empty, no legacy/inference from answer)');
        } else {
            emitCartActions(res, cartActions);
        }

        if (req.tenant?.apiKeyUsed && Number.isFinite(tokensUsed)) {
            const ip = req.ip || req.connection?.remoteAddress || null;
            try {
                await tenantRepo.addTokenUsage(req.tenant.id, req.tenant.apiKeyUsed, tokensUsed, ip);
            } catch (_) { }
        }

        // Complete
        res.write('data: [DONE]\n\n');
        clearInterval(keepalive);

    } catch (error) {
        logError('CHAT', 'Chat stream failed', error, {
            path: req.path,
            user,
            conversation_id,
            loggedIn: !!resolvedContextToken,
            cartItems: effectiveCart?.itemCount || 0
        });

        if (!res.headersSent) {
            res.status(500).json({ error: 'Chat failed', message: error.message });
        } else {
            res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        }
    } finally {
        if (keepalive) {
            try { clearInterval(keepalive); } catch (_) { }
            keepalive = null;
        }
        res.end();
    }
});

module.exports = router;
