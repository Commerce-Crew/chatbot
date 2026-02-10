/**
 * Chatbot Middleware (Multi-tenant)
 * Entry Point
 */
const app = require('./src/app');
const config = require('./src/config');

const PORT = config.port;

app.listen(PORT, () => {
    console.log('='.repeat(60));
    console.log('🦷 CommerceCrew Chatbot Middleware (Multi-tenant)');
    console.log('='.repeat(60));
    console.log(`   Port:      ${PORT}`);
    console.log(`   Database:  ${config.db.url ? 'DATABASE_URL' : `${config.db.host}:${config.db.port}/${config.db.database}`}`);
    console.log(`   Debug:     ${config.debug}`);
    console.log('='.repeat(60));
    console.log('');
    console.log('Endpoints:');
    console.log('   POST /api/chat/stream      - Chat with streaming');
    console.log('   POST /api/products/search  - Search products');
    console.log('   POST /api/cart/add         - Queue cart action');
    console.log('   POST /api/orders           - Get customer orders');
    console.log('   GET  /api/categories       - Get categories');
    console.log('   GET  /api/customer         - Get customer info');
    console.log('   GET  /api/health                   - Health check');
    console.log('='.repeat(60));
});
