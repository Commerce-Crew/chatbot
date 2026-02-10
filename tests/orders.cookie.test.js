const request = require('supertest');
const { buildApp } = require('./helpers/appFactory');

jest.mock('../src/services/shopware', () => ({
    getOrders: jest.fn(),
    getLastOrder: jest.fn(),
    getOrderByNumber: jest.fn()
}));

const shopware = require('../src/services/shopware');
const ordersRouter = require('../src/routes/orders');

describe('Orders routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('uses cookie context token for last order', async () => {
        shopware.getLastOrder.mockResolvedValue({
            id: 'o1',
            orderNumber: '1001',
            date: new Date().toISOString(),
            dateFormatted: '01.01.2025',
            total: 12.3,
            totalFormatted: '12,30 €',
            status: 'open',
            deliveries: [],
            items: []
        });

        const app = buildApp([['/api/orders', ordersRouter]]);

        const res = await request(app)
            .post('/api/orders/last')
            .set('Cookie', 'sw-context-token=cookie-token')
            .send({ context_token: 'body-token' })
            .expect(200);

        expect(shopware.getLastOrder).toHaveBeenCalledWith('cookie-token', expect.any(Object));
        expect(res.body.success).toBe(true);
        expect(res.body.order.orderNumber).toBe('1001');
    });

    test('uses header token when cookie is missing', async () => {
        shopware.getOrders.mockResolvedValue({
            success: true,
            orders: []
        });

        const app = buildApp([['/api/orders', ordersRouter]]);

        await request(app)
            .post('/api/orders')
            .set('sw-context-token', 'header-token')
            .send({ context_token: 'body-token' })
            .expect(200);

        expect(shopware.getOrders).toHaveBeenCalledWith('header-token', 5, expect.any(Object));
    });

    test('uses body token when cookie/header are missing', async () => {
        shopware.getOrderByNumber.mockResolvedValue({
            id: 'o2',
            orderNumber: '2002',
            deliveries: [],
            items: []
        });

        const app = buildApp([['/api/orders', ordersRouter]]);

        const res = await request(app)
            .post('/api/orders/by-number')
            .send({ context_token: 'body-token', order_number: '2002' })
            .expect(200);

        expect(shopware.getOrderByNumber).toHaveBeenCalledWith('body-token', '2002', 25, expect.any(Object));
        expect(res.body.success).toBe(true);
        expect(res.body.order.orderNumber).toBe('2002');
    });
});
