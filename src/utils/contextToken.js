const { getCookie } = require('./cookies');

function normalizeToken(value) {
    if (value === null || value === undefined) return null;
    const token = String(value).trim();
    return token || null;
}

function firstToken(...values) {
    for (const value of values) {
        const token = normalizeToken(value);
        if (token) return token;
    }
    return null;
}

function resolveContextToken(req, options = {}) {
    const body = req?.body || {};
    const cookieName = options.cookieName || 'sw-context-token';
    const bodyKeys = Array.isArray(options.bodyKeys) && options.bodyKeys.length
        ? options.bodyKeys
        : ['context_token', 'contextToken'];

    const cookieToken = normalizeToken(getCookie(req, cookieName));
    const headerToken = normalizeToken(
        req?.headers?.['sw-context-token'] || req?.headers?.['x-sw-context-token'] || null
    );

    let bodyToken = null;
    for (const key of bodyKeys) {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
            bodyToken = normalizeToken(body[key]);
            if (bodyToken) break;
        }
    }

    return {
        token: firstToken(cookieToken, headerToken, bodyToken),
        cookieToken,
        headerToken,
        bodyToken
    };
}

function setContextTokenHeader(res, token) {
    const normalized = normalizeToken(token);
    if (!normalized) return;
    res.setHeader('sw-context-token', normalized);
}

module.exports = {
    resolveContextToken,
    setContextTokenHeader
};
