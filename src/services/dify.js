/**
 * Dify API Service
 */
const config = require('../config');
const { log } = require('../utils/logger');

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    return fetch(url, {
        ...options,
        signal: controller.signal
    }).finally(() => clearTimeout(id));
}

function parseDataUrl(dataUrl) {
    // data:<mime>;base64,<payload>
    const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl || '');
    if (!m) return null;
    const mime = m[1];
    const b64 = m[2];
    return { mime, b64 };
}

function extensionFromMime(mime) {
    const map = {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif'
    };
    return map[mime] || 'png';
}

function getDifyConfig(tenant) {
    return tenant?.dify || config.dify;
}

async function uploadImageToDify({ buffer, mime, filename }, userId, difyConfig) {
    const url = `${difyConfig.url}/v1/files/upload`;

    // Native FormData in Node 18+ (undici)
    const formData = new FormData();
    formData.append('user', userId);
    formData.append('file', new Blob([buffer], { type: mime }), filename);

    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${difyConfig.apiKey}`
        },
        body: formData
    }, 60000);

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Dify file upload failed: ${resp.status} ${err}`);
    }

    const json = await resp.json();
    const fileId = json?.id;
    if (fileId) {
        log('DIFY', `Uploaded image to Dify (file_id=${fileId})`);
    }
    return fileId;
}

async function buildDifyFiles(image, userId, difyConfig) {
    // Accept:
    //  - http(s) URL (remote_url)
    //  - data URL base64 image (upload -> local_file)

    if (typeof image !== 'string' || !image.trim()) return [];
    const value = image.trim();

    if (/^https?:\/\//i.test(value)) {
        return [{ type: 'image', transfer_method: 'remote_url', url: value }];
    }

    const parsed = parseDataUrl(value);
    if (!parsed) {
        // Unknown format; ignore
        return [];
    }

    const buffer = Buffer.from(parsed.b64, 'base64');
    const mime = parsed.mime;
    const ext = extensionFromMime(mime);
    const filename = `upload.${ext}`;

    const uploadFileId = await uploadImageToDify({ buffer, mime, filename }, userId, difyConfig);
    if (!uploadFileId) return [];

    return [{ type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId }];
}

/**
 * Read a Dify streaming (SSE) response and return the full assistant answer.
 *
 * Dify returns `text/event-stream` with lines like:
 *   data: {"event":"message",...,"answer":"..."}\n\n
 *
 * Some deployments may omit blank-line separators, so we parse every line that
 * starts with `data:`.
 */
async function readDifyStreamingAnswer(resp) {
    if (!resp?.body) return '';

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = String(rawLine || '').trim();
            if (!line.startsWith('data:')) continue;

            const payload = line.replace(/^data:\s*/, '').trim();
            if (!payload || payload === '[DONE]') continue;

            // Payload must be JSON.
            let obj = null;
            try {
                obj = JSON.parse(payload);
            } catch (_) {
                // If multiple `data:` objects appear in a single chunk,
                // split and attempt parsing each part.
                const parts = payload
                    .split(/\s*data:\s*/g)
                    .map(p => p.trim())
                    .filter(Boolean);
                for (const part of parts) {
                    try {
                        obj = JSON.parse(part);
                        break;
                    } catch (e) { }
                }
            }

            if (!obj) continue;

            if (typeof obj.answer === 'string' && obj.answer.length) {
                const chunk = obj.answer;
                // Some versions emit deltas; some emit full accumulated text.
                if (chunk.startsWith(answer)) {
                    answer = chunk;
                } else {
                    answer += chunk;
                }
            }
        }
    }

    return String(answer || '').trim();
}

/**
 * Format cart for Dify context
 */
function formatCart(cart, lang = 'de') {
    const en = String(lang || '').toLowerCase().startsWith('en');
    if (!cart?.items?.length) {
        return en ? '[CART: empty]\n\n' : '[WARENKORB: leer]\n\n';
    }

    const header = en
        ? `[CART - ${cart.itemCount} items, Total: ${cart.total?.toFixed(2) || 0}€]`
        : `[WARENKORB - ${cart.itemCount} Artikel, Gesamt: ${cart.total?.toFixed(2) || 0}€]`;
    let text = header + '\n';
    cart.items.forEach((item, i) => {
        const price = item.totalPrice?.toFixed(2) || item.price?.toFixed(2) || '?';
        text += `  ${i + 1}. "${item.name}" x${item.quantity} = ${price}€\n`;
    });
    text += en ? '[END CART]\n\n' : '[ENDE WARENKORB]\n\n';
    return text;
}

/**
 * Format orders for Dify context
 */
function formatOrders(orders, lang = 'de') {
    if (!orders?.length) return '';
    const en = String(lang || '').toLowerCase().startsWith('en');

    let text = en ? '[ORDER HISTORY]\n' : '[BESTELLHISTORIE des Kunden]\n';
    orders.slice(0, 3).forEach((order, i) => {
        text += en
            ? `  ${i + 1}. Order #${order.orderNumber} from ${order.dateFormatted}\n`
            : `  ${i + 1}. Bestellung #${order.orderNumber} vom ${order.dateFormatted}\n`;
        text += en
            ? `     Status: ${order.status} | Total: ${order.totalFormatted}\n`
            : `     Status: ${order.status} | Gesamt: ${order.totalFormatted}\n`;
        const deliveries = Array.isArray(order.deliveries) ? order.deliveries : [];
        const tracking = deliveries.flatMap(d => Array.isArray(d.trackingCodes) ? d.trackingCodes : []);
        if (tracking.length) {
            text += `     Tracking: ${tracking.join(', ')}\n`;
        }
        text += en ? '     Items:\n' : '     Artikel:\n';
        order.items.slice(0, 5).forEach(item => {
            text += `       - ${item.name} x${item.quantity} à ${item.priceFormatted}\n`;
        });
    });
    text += en ? '[END ORDER HISTORY]\n\n' : '[ENDE BESTELLHISTORIE]\n\n';
    return text;
}

/**
 * Format shop info (shipping, payment, opening hours, contact, return policy, about us) for Dify context
 */
function formatShopInfo(shopInfo, lang = 'de') {
    const shipping = shopInfo?.shippingMethods || [];
    const payment = shopInfo?.paymentMethods || [];
    const openingHours = String(shopInfo?.openingHours || '').trim();
    const contact = String(shopInfo?.contact || '').trim();
    const returnPolicy = String(shopInfo?.returnPolicy || '').trim();
    const aboutUs = String(shopInfo?.aboutUs || '').trim();

    const hasStatic = openingHours || contact || returnPolicy || aboutUs;
    if (!shipping.length && !payment.length && !hasStatic) return '';
    const en = String(lang || '').toLowerCase().startsWith('en');

    let text = '[SHOP INFO]\n';
    if (openingHours) {
        text += en ? 'Opening hours:\n' : 'Öffnungszeiten:\n';
        text += openingHours + '\n\n';
    }
    if (contact) {
        text += en ? 'Contact (phone, email, address):\n' : 'Kontakt (Telefon, E-Mail, Adresse):\n';
        text += contact + '\n\n';
    }
    if (returnPolicy) {
        text += en ? 'Return policy / Refunds:\n' : 'Rückversand / Retouren:\n';
        text += returnPolicy + '\n\n';
    }
    if (aboutUs) {
        text += en ? 'About us:\n' : 'Wer wir sind / Über uns:\n';
        text += aboutUs + '\n\n';
    }
    if (shipping.length) {
        text += en ? 'Shipping:\n' : 'Versand:\n';
        shipping.slice(0, 10).forEach((m, i) => {
            const price = m.priceFormatted || (Number.isFinite(m.price) ? `${m.price}€` : '');
            const line = [m.name, price].filter(Boolean).join(' - ');
            text += `  ${i + 1}. ${line}\n`;
        });
    }
    if (payment.length) {
        text += en ? 'Payment:\n' : 'Zahlung:\n';
        payment.slice(0, 10).forEach((m, i) => {
            text += `  ${i + 1}. ${m.name}\n`;
        });
    }
    text += '[END SHOP INFO]\n\n';
    return text;
}
/**
 * Format customer info for Dify context.
 * Important: Adding to cart does NOT require login; guests can add items.
 * Only order history and reordering require the customer to be logged in.
 */
function formatCustomerInfo(customer, isLoggedIn, lang = 'de') {
    const en = String(lang || '').toLowerCase().startsWith('en');
    if (!isLoggedIn) {
        const guestCart = en
            ? '[NOTE: Adding to cart does NOT require login. Guests can add items to the cart. Only order history and reordering require login.]\n\n'
            : '[HINWEIS: Warenkorb funktioniert auch ohne Anmeldung. Gäste können Artikel in den Warenkorb legen. Nur Bestellhistorie und Nachbestellen erfordern Login.]\n\n';
        const customerLine = en
            ? '[CUSTOMER: Not logged in - order history unavailable]\n\n'
            : '[KUNDE: Nicht eingeloggt - Bestellhistorie nicht verfügbar]\n\n';
        return guestCart + customerLine;
    }
    if (customer) {
        const label = en ? 'CUSTOMER' : 'KUNDE';
        const status = en ? 'logged in' : 'eingeloggt';
        return `[${label}: ${customer.firstName} ${customer.lastName} (${customer.email}) - ${status}]\n\n`;
    }
    return en ? '[CUSTOMER: Logged in]\n\n' : '[KUNDE: Eingeloggt]\n\n';
}

/**
 * Stream chat with Dify
 */
async function streamChat(message, userId, conversationId, context = {}, tenant = null) {
    const { cart, orders, customer, isLoggedIn, image, askedAboutOrders, difyFiles, languageHint, shopInfo, extraInstructions } = context;
    const difyConfig = getDifyConfig(tenant);

    // Build enhanced message with context
    let enhancedMessage = '';
    if (difyConfig.instructions) {
        enhancedMessage += `[SYSTEM INSTRUCTIONS]\n${difyConfig.instructions}\n\n`;
    }
    if (extraInstructions) {
        enhancedMessage += `[SHOP INSTRUCTIONS]\n${String(extraInstructions).trim()}\n\n`;
        log('DIFY', 'Extra instructions present');
    }
    if (languageHint) {
        enhancedMessage += `[LANGUAGE]\n${String(languageHint).trim()}\n\n`;
        log('DIFY', `Language hint: ${languageHint}`);
    }

    // Derive language code for bilingual formatting
    const lang = String(languageHint || '').toLowerCase().startsWith('en') ? 'en' : 'de';

    enhancedMessage += formatCustomerInfo(customer, isLoggedIn, lang);
    enhancedMessage += formatCart(cart, lang);

    if (orders?.length) {
        enhancedMessage += formatOrders(orders, lang);
    } else if (askedAboutOrders && isLoggedIn === false) {
        // Only add this hint if the customer actually asked about orders.
        enhancedMessage += lang === 'en'
            ? '[NOTE: Customer is not logged in, order history cannot be retrieved]\n\n'
            : '[HINWEIS: Kunde ist nicht eingeloggt, Bestellhistorie kann nicht abgerufen werden]\n\n';
    }

    if (shopInfo) {
        enhancedMessage += formatShopInfo(shopInfo, lang);
    }

    const queryLabel = lang === 'en' ? 'Customer inquiry' : 'Kundenanfrage';
    enhancedMessage += queryLabel + ': ' + message;

    // Request body
    const body = {
        inputs: {},
        query: enhancedMessage,
        user: userId || 'anonymous',
        response_mode: 'streaming'
    };

    if (difyConfig.inputs && typeof difyConfig.inputs === 'object') {
        body.inputs = { ...body.inputs, ...difyConfig.inputs };
    }
    if (difyConfig.agentId && !body.inputs.agent_id) {
        body.inputs.agent_id = difyConfig.agentId;
    }

    if (conversationId) {
        body.conversation_id = conversationId;
    }

    // Handle image:
    // - Prefer pre-built files (avoids double upload when the middleware
    //   already uploaded the image for the vision pipeline)
    // - Otherwise build from image input
    if (Array.isArray(difyFiles) && difyFiles.length) {
        body.files = difyFiles;
    } else if (image) {
        const files = await buildDifyFiles(image, body.user, difyConfig);
        if (files?.length) body.files = files;
    }

    log('DIFY', `Request: user=${userId}, cart=${cart?.itemCount || 0}, orders=${orders?.length || 0}, loggedIn=${isLoggedIn}`);

    const response = await fetchWithTimeout(`${difyConfig.url}/v1/chat-messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${difyConfig.apiKey}`
        },
        body: JSON.stringify(body)
    }, 120000);

    if (!response.ok) {
        const errorText = await response.text();
        log('DIFY', `Error ${response.status}:`, errorText);
        throw new Error(`Dify API error: ${response.status}`);
    }

    return response;
}


/**
 * Extract product query from an image (Vision)
 *
 * This is used by the middleware "image → extract → search → suggest" pipeline.
 * Uses Dify chat-messages endpoint in blocking mode.
 *
 * Returns: { query: string, quantity: number|null, confidence: number|null }
 */
async function extractProductQueryFromImage(image, userId, userMessage = '', tenant = null) {
    try {
        const difyConfig = getDifyConfig(tenant);
        const files = await buildDifyFiles(image, userId || 'anonymous', difyConfig);
        if (!files?.length) {
            return { query: '', quantity: null, confidence: null, difyFiles: [] };
        }

        // Prompt: we want a very small JSON output to parse reliably.
        const instruction = [
            'Du bist ein Shopping-Assistent für einen Dental-Shop.',
            'Erkenne im Bild das Produkt oder den Produktnamen (ggf. Marke/Variante).',
            'Wenn möglich: erkenne auch Menge/Packungsgröße oder Stückzahl.',
            '',
            'Gib NUR ein gültiges JSON zurück, ohne Markdown:',
            '{"query":"<kurzer Suchbegriff>","quantity":<zahl oder null>,"confidence":<0-1 oder null>}',
            '',
            `Zusatztext vom Kunden: "${String(userMessage || '').slice(0, 200)}"`
        ].join('\n');

        const body = {
            inputs: {},
            query: instruction,
            user: userId || 'anonymous',
            // Agent Chat Apps may not support blocking mode. Streaming is safe
            // across Dify app types (Chat App / Agent / Chatflow).
            response_mode: 'streaming',
            files
        };

        const resp = await fetchWithTimeout(`${difyConfig.url}/v1/chat-messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${difyConfig.apiKey}`
            },
            body: JSON.stringify(body)
        }, 60000);

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`extractProductQueryFromImage failed: ${resp.status} ${err}`);
        }

        // Streaming (SSE) response -> aggregate answer text
        const answer = await readDifyStreamingAnswer(resp);

        // Parse JSON
        let parsed = null;
        try {
            parsed = JSON.parse(answer);
        } catch (e) {
            // Try to extract JSON from a text blob
            const m = answer.match(/\{[\s\S]*\}/);
            if (m) {
                try { parsed = JSON.parse(m[0]); } catch (_) { }
            }
        }

        const query = (parsed?.query || '').toString().trim();
        const quantity = (parsed?.quantity === null || parsed?.quantity === undefined) ? null : (parseInt(parsed.quantity, 10) || null);
        const confidence = (parsed?.confidence === null || parsed?.confidence === undefined) ? null : Number(parsed.confidence);

        return { query, quantity, confidence: Number.isFinite(confidence) ? confidence : null, difyFiles: files };
    } catch (e) {
        log('DIFY', 'Vision extract error:', e.message);
        return { query: '', quantity: null, confidence: null, difyFiles: [] };
    }
}

module.exports = {
    streamChat,
    formatCart,
    formatOrders,
    extractProductQueryFromImage,
    formatCustomerInfo
};
