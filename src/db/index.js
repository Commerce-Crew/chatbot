/**
 * Postgres DB helper
 */
const { Pool } = require('pg');
const config = require('../config');

function buildPoolConfig() {
    if (config.db.url) {
        return {
            connectionString: config.db.url,
            ssl: config.db.ssl ? { rejectUnauthorized: false } : false
        };
    }

    return {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        ssl: config.db.ssl ? { rejectUnauthorized: false } : false
    };
}

const pool = new Pool(buildPoolConfig());

async function query(text, params) {
    return pool.query(text, params);
}

module.exports = {
    pool,
    query
};
