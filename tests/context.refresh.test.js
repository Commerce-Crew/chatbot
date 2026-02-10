const request = require('supertest');
const { buildApp } = require('./helpers/appFactory');

jest.mock('../src/services/shopware', () => ({
    refreshContextToken: jest.fn()
}));

const contextRouter = require('../src/routes/context');

describe('Context refresh', () => {
    test('returns cookie token when present', async () => {
        const app = buildApp([['/api/context', contextRouter]]);

        const res = await request(app)
            .post('/api/context/refresh')
            .set('Cookie', 'sw-context-token=cookie-token')
            .send({})
            .expect(200);

        expect(res.body.context_token).toBe('cookie-token');
    });
});
