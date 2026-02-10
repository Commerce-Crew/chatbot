/**
 * Logger utility
 *
 * Goals:
 *  - Always provide enough context to debug production issues.
 *  - Stay lightweight (no heavy logging dependencies).
 */

const config = require('../config');

function ts() {
    // HH:MM:SS (local)
    return new Date().toISOString().substr(11, 8);
}

function truncate(str, max = 2000) {
    if (typeof str !== 'string') return str;
    if (str.length <= max) return str;
    return str.substring(0, max) + '…';
}

function serializeError(err) {
    if (!err) return null;
    return {
        name: err.name,
        message: err.message,
        code: err.code,
        status: err.status,
        stack: config.debug ? truncate(err.stack || '') : undefined,
        cause: err.cause ? String(err.cause) : undefined
    };
}

function log(category, message, data = null) {
    if (!config.debug && category === 'DEBUG') return;

    const prefix = `[${ts()}] [${category}]`;

    if (data === null || data === undefined) {
        console.log(prefix, message);
        return;
    }

    // Keep console output readable
    if (data instanceof Error) {
        console.log(prefix, message, JSON.stringify(serializeError(data)));
        return;
    }

    if (typeof data === 'object') {
        console.log(prefix, message, truncate(JSON.stringify(data)));
        return;
    }

    console.log(prefix, message, truncate(String(data)));
}

function logError(category, message, err, context = {}) {
    const prefix = `[${ts()}] [${category}]`;
    const payload = {
        ...context,
        error: serializeError(err)
    };
    console.error(prefix, message, truncate(JSON.stringify(payload)));
    if (config.debug && err?.stack) {
        console.error(err.stack);
    }
}

module.exports = { log, logError };
