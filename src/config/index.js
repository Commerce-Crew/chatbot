/**
 * Configuration - Edit this file to change settings
 */
require('dotenv').config();

module.exports = {
    port: process.env.PORT || 3330,

    db: {
        url: process.env.DATABASE_URL || '',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'ccchatmiddleware',
        ssl: process.env.DB_SSL === 'true'
    },
    
    shopware: {
        url: '',
        accessKey: ''
    },
    
    dify: {
        url: '',
        apiKey: ''
    },
    
    cors: {
        origins: []
    },
    
    // Limits
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxJsonSize: '50mb', // For base64 images
    
    // Debug
    // NOTE: the previous implementation `|| true` always enabled debug.
    debug: process.env.DEBUG === 'true'
};
