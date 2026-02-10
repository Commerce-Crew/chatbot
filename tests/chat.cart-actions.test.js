const request = require('supertest');
const { TextEncoder } = require('util');
const { buildApp } = require('./helpers/appFactory');

jest.mock('../src/services/dify', () => ({
    streamChat: jest.fn()
}));

jest.mock('../src/services/shopware', () => ({
    verifyCustomerSession: jest.fn().mockResolvedValue({ valid: false, loggedIn: false }),
    getOrders: jest.fn().mockResolvedValue({ success: true, orders: [] }),
    resolveProductIdentifier: jest.fn(),
    getCart: jest.fn().mockResolvedValue({ items: [], itemCount: 0, total: 0, contextToken: null })
}));

const dify = require('../src/services/dify');
const shopware = require('../src/services/shopware');
const chatRouter = require('../src/routes/chat');
const cartRouter = require('../src/routes/cart');

function parseSseEvents(text) {
    return text
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6).trim())
        .filter(payload => payload && payload !== '[DONE]')
        .map(payload => {
            try { return JSON.parse(payload); } catch (_) { return null; }
        })
        .filter(Boolean);
}

function createDifyStream(events) {
    const encoder = new TextEncoder();
    const chunks = (events || []).map((evt) => `data: ${JSON.stringify(evt)}\n\n`);
    let index = 0;

    return {
        body: {
            getReader() {
                return {
                    async read() {
                        if (index >= chunks.length) {
                            return { done: true, value: undefined };
                        }
                        const value = encoder.encode(chunks[index]);
                        index += 1;
                        return { done: false, value };
                    },
                    async cancel() {}
                };
            }
        }
    };
}

describe('Chat stream cart action queue', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        dify.streamChat.mockResolvedValue(createDifyStream([{
            event: 'message',
            answer: 'Alles klar.'
        }]));
        shopware.resolveProductIdentifier.mockResolvedValue({
            success: true,
            product: {
                id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                name: 'Medicom SafeSeal'
            }
        });
    });

    test('emits queued cart_actions in stream response', async () => {
        const app = buildApp([
            ['/api/cart', cartRouter],
            ['/api/chat', chatRouter]
        ]);

        await request(app)
            .post('/api/cart/add')
            .send({
                product_id: 'sku-123',
                quantity: 2,
                user_id: 'queue-user-1'
            })
            .expect(200);

        const res = await request(app)
            .post('/api/chat/stream')
            .send({
                message: 'zeige mir den stand',
                user: 'queue-user-1',
                cart: { itemCount: 0, items: [] }
            })
            .expect(200);

        const events = parseSseEvents(res.text);
        const cartActionsEvent = events.find(e => Array.isArray(e.cart_actions));

        expect(cartActionsEvent).toBeTruthy();
        expect(cartActionsEvent.cart_actions).toHaveLength(1);
        expect(cartActionsEvent.cart_actions[0]).toMatchObject({
            type: 'add',
            productId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            productName: 'Medicom SafeSeal',
            quantity: 2
        });
    });

    test('consumes queued cart actions exactly once', async () => {
        const app = buildApp([
            ['/api/cart', cartRouter],
            ['/api/chat', chatRouter]
        ]);

        await request(app)
            .post('/api/cart/add')
            .send({
                product_id: 'sku-123',
                quantity: 1,
                user_id: 'queue-user-2'
            })
            .expect(200);

        const first = await request(app)
            .post('/api/chat/stream')
            .send({
                message: 'hallo',
                user: 'queue-user-2',
                cart: { itemCount: 0, items: [] }
            })
            .expect(200);

        const second = await request(app)
            .post('/api/chat/stream')
            .send({
                message: 'nochmal',
                user: 'queue-user-2',
                cart: { itemCount: 0, items: [] }
            })
            .expect(200);

        const firstEvents = parseSseEvents(first.text);
        const secondEvents = parseSseEvents(second.text);

        expect(firstEvents.some(e => Array.isArray(e.cart_actions))).toBe(true);
        expect(secondEvents.some(e => Array.isArray(e.cart_actions))).toBe(false);
    });

    test('consumes latest action even when queued user id mismatches stream user', async () => {
        const app = buildApp([
            ['/api/cart', cartRouter],
            ['/api/chat', chatRouter]
        ]);

        await request(app)
            .post('/api/cart/add')
            .send({
                product_id: 'sku-123',
                quantity: 1,
                user_id: 'different-user'
            })
            .expect(200);

        const res = await request(app)
            .post('/api/chat/stream')
            .send({
                message: 'zeige mir den stand',
                user: 'chat-user',
                cart: { itemCount: 0, items: [] }
            })
            .expect(200);

        const events = parseSseEvents(res.text);
        const cartActionsEvent = events.find(e => Array.isArray(e.cart_actions));
        expect(cartActionsEvent).toBeTruthy();
        expect(cartActionsEvent.cart_actions[0]).toMatchObject({
            type: 'add',
            productId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        });
    });

    test('falls back to legacy inline cart marker when queue is empty', async () => {
        const app = buildApp([['/api/chat', chatRouter]]);

        dify.streamChat.mockResolvedValue(createDifyStream([{
            event: 'message',
            answer: 'Okay [ADD_TO_CART:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:Test Produkt:2]'
        }]));

        const res = await request(app)
            .post('/api/chat/stream')
            .send({
                message: 'bitte hinzufügen',
                user: 'legacy-user',
                cart: { itemCount: 0, items: [] }
            })
            .expect(200);

        const events = parseSseEvents(res.text);
        const cartActionsEvent = events.find(e => Array.isArray(e.cart_actions));
        expect(cartActionsEvent).toBeTruthy();
        expect(cartActionsEvent.cart_actions[0]).toMatchObject({
            type: 'add',
            productId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            productName: 'Test Produkt',
            quantity: 2
        });
    });
});
