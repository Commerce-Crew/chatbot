const express = require('express');

function buildApp(routes = []) {
    const app = express();
    app.use(express.json());

    // Minimal tenant injection for route handlers
    app.use((req, res, next) => {
        req.tenant = {
            id: 1,
            name: 'test-tenant',
            allowedOrigins: ['http://localhost'],
            dify: {
                url: 'http://dify.local',
                apiKey: 'dify-key',
                agentId: null,
                instructions: '',
                inputs: null,
                modelConfig: null
            },
            shopware: {
                url: 'http://shopware.local',
                accessKey: 'shopware-key'
            }
        };
        next();
    });

    for (const [path, router] of routes) {
        app.use(path, router);
    }

    return app;
}

module.exports = { buildApp };
