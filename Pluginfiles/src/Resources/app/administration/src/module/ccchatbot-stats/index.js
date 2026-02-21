import './page/ccchatbot-stats';

Shopware.Module.register('ccchatbot-stats', {
    type: 'plugin',
    name: 'ccchatbot-stats',
    title: 'CCChatbot Stats',
    description: 'Chatbot analytics and usage',
    color: '#0b1742',
    icon: 'default-object-chart',
    routes: {
        index: {
            component: 'ccchatbot-stats',
            path: 'index'
        }
    },
    navigation: [{
        id: 'ccchatbot-stats',
        label: 'CCChatbot Stats',
        color: '#0b1742',
        path: 'ccchatbot.stats.index',
        parent: 'sw-marketing',
        position: 100
    }]
});
