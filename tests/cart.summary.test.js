const request = require('supertest');
const { buildApp } = require('./helpers/appFactory');

jest.mock('../src/services/shopware', () => ({
    getCart: jest.fn()
}));

const shopware = require('../src/services/shopware');
const cartRouter = require('../src/routes/cart');

describe('Cart summary', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('prefers cookie context token over body/header', async () => {
        shopware.getCart.mockImplementation(async (token) => ({
            items: [],
            itemCount: 0,
            total: 0,
            contextToken: token
        }));

        const app = buildApp([['/api/cart', cartRouter]]);

        const res = await request(app)
            .post('/api/cart/summary')
            .set('Cookie', 'sw-context-token=cookie-token')
            .set('sw-context-token', 'header-token')
            .send({ context_token: 'body-token' })
            .expect(200);

        expect(shopware.getCart).toHaveBeenCalledWith('cookie-token', expect.any(Object));
        expect(res.body.context_token).toBe('cookie-token');
    });

    test('falls back to header token when cookie is missing', async () => {
        shopware.getCart.mockImplementation(async (token) => ({
            items: [],
            itemCount: 0,
            total: 0,
            contextToken: token
        }));

        const app = buildApp([['/api/cart', cartRouter]]);

        const res = await request(app)
            .post('/api/cart/summary')
            .set('sw-context-token', 'header-token')
            .send({ context_token: 'body-token' })
            .expect(200);

        expect(shopware.getCart).toHaveBeenCalledWith('header-token', expect.any(Object));
        expect(res.body.context_token).toBe('header-token');
    });

    test('uses body token when cookie and header are missing', async () => {
        shopware.getCart.mockResolvedValue({
            items: [],
            itemCount: 0,
            total: 0,
            contextToken: 'body-token'
        });

        const app = buildApp([['/api/cart', cartRouter]]);

        const res = await request(app)
            .post('/api/cart/summary')
            .send({ context_token: 'body-token' })
            .expect(200);

        expect(shopware.getCart).toHaveBeenCalledWith('body-token', expect.any(Object));
        expect(res.headers['sw-context-token']).toBe('body-token');
        expect(res.body.context_token).toBe('body-token');
    });
});
