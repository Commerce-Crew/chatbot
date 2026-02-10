function parseCookieHeader(header) {
    if (!header || typeof header !== 'string') return {};
    const out = {};
    header.split(';').forEach(part => {
        const idx = part.indexOf('=');
        if (idx === -1) return;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (!key) return;
        out[key] = decodeURIComponent(val);
    });
    return out;
}

function getCookie(req, name) {
    const header = req?.headers?.cookie || '';
    const cookies = parseCookieHeader(header);
    return cookies[name] || null;
}

module.exports = { parseCookieHeader, getCookie };
