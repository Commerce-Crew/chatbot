/**
 * Express App Configuration
 */
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const crypto = require('crypto');
const config = require('./config');
const tenantResolver = require('./middleware/tenant');
const adminRoutes = require('./routes/admin');
const { logError } = require('./utils/logger');

const app = express();

app.set('trust proxy', true);

// Request ID (useful for debugging & correlating frontend errors with logs)
app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
});

// Body parsing
app.use(express.json({ limit: config.maxJsonSize }));
app.use(express.urlencoded({ extended: true }));

// Logging
morgan.token('rid', (req) => req.requestId || '-');
app.use(morgan(':rid :remote-addr - :method :url :status :res[content-length] - :response-time ms'));

// Health (no tenant required)
app.use('/api/health', require('./routes/health'));
app.use('/admin', adminRoutes);

// Tenant-aware API router
const apiRouter = express.Router();

// Preflight CORS (no tenant resolution; key is required on actual request)
apiRouter.options('*', cors({
    origin: (origin, callback) => callback(null, true),
    credentials: true
}));

apiRouter.use(tenantResolver);
apiRouter.use((req, res, next) => {
    const allowed = (req.tenant?.allowedOrigins?.length ? req.tenant.allowedOrigins : []) || [];
    const allowAll = allowed.includes('*');

    return cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowAll || allowed.includes(origin)) return callback(null, true);

            if (config.debug) {
                console.log(`[CORS] DEBUG allow origin: ${origin}`);
                return callback(null, true);
            }

            return callback(new Error('Not allowed by CORS'));
        },
        credentials: true
    })(req, res, next);
});

apiRouter.use('/products', require('./routes/products'));
apiRouter.use('/cart', require('./routes/cart'));
apiRouter.use('/orders', require('./routes/orders'));
apiRouter.use('/categories', require('./routes/categories'));
apiRouter.use('/chat', require('./routes/chat'));
apiRouter.use('/files', require('./routes/files'));
apiRouter.use('/customer', require('./routes/customer'));
apiRouter.use('/context', require('./routes/context'));
apiRouter.use('/analytics', require('./routes/analytics'));
apiRouter.use('/leads', require('./routes/leads'));
apiRouter.use('/shop', require('./routes/shop'));

app.use('/api', apiRouter);


// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
    logError('ERROR', 'Unhandled middleware error', err, {
        requestId: req.requestId,
        method: req.method,
        path: req.path
    });

    res.status(500).json({
        error: 'Internal server error',
        requestId: req.requestId,
        ...(config.debug ? { message: err.message } : {})
    });
});

module.exports = app;
