const request = require('supertest');
const { buildApp } = require('./helpers/appFactory');

jest.mock('../src/services/dify', () => ({
    streamChat: jest.fn()
}));

jest.mock('../src/services/shopware', () => ({
    verifyCustomerSession: jest.fn().mockResolvedValue({ valid: false, loggedIn: false }),
    getOrders: jest.fn()
}));

const chatRouter = require('../src/routes/chat');

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

describe('Chat remove quantity', () => {
    test('removes one when user asks to remove one of two', async () => {
        const app = buildApp([['/api/chat', chatRouter]]);

        const res = await request(app)
            .post('/api/chat/stream')
            .send({
                message: 'ich habe Elastischer Vorschubdoppelplatten-Steg nach Schaneng zweimal in meinem warenkorb, kannst du eine davon entfernen?',
                user: 'user-1',
                cart: {
                    itemCount: 2,
                    items: [
                        {
                            id: 'line-1',
                            productId: 'prod-1',
                            name: 'Elastischer Vorschubdoppelplatten-Steg nach Schaneng',
                            quantity: 2,
                            price: 10
                        }
                    ]
                }
            })
            .expect(200);

        const events = parseSseEvents(res.text);
        const cartActionsEvent = events.find(e => Array.isArray(e.cart_actions));
        expect(cartActionsEvent).toBeTruthy();
        expect(cartActionsEvent.cart_actions[0].type).toBe('update');
        expect(cartActionsEvent.cart_actions[0].quantity).toBe(1);
    });

    test('removes all when user asks to remove all', async () => {
        const app = buildApp([['/api/chat', chatRouter]]);

        const res = await request(app)
            .post('/api/chat/stream')
            .send({
                message: 'bitte entferne alle Elastischer Vorschubdoppelplatten-Steg nach Schaneng',
                user: 'user-1',
                cart: {
                    itemCount: 2,
                    items: [
                        {
                            id: 'line-1',
                            productId: 'prod-1',
                            name: 'Elastischer Vorschubdoppelplatten-Steg nach Schaneng',
                            quantity: 2,
                            price: 10
                        }
                    ]
                }
            })
            .expect(200);

        const events = parseSseEvents(res.text);
        const cartActionsEvent = events.find(e => Array.isArray(e.cart_actions));
        expect(cartActionsEvent).toBeTruthy();
        expect(cartActionsEvent.cart_actions[0].type).toBe('remove');
    });
});
