import template from './ccchatbot-stats.html.twig';
import './ccchatbot-stats.scss';

const { Component } = Shopware;

Component.register('ccchatbot-stats', {
    template,

    data() {
        return {
            isLoading: false,
            error: null,
            stats: null,
            topQuestions: [],
            cartActions: {},
            middlewareUrl: '',
            middlewareApiKey: ''
        };
    },

    computed: {
        hasConfig() {
            return !!this.middlewareUrl && !!this.middlewareApiKey;
        },
        statsSafe() {
            return this.stats || {};
        }
    },

    created() {
        this.loadConfig().then(() => {
            if (this.hasConfig) {
                this.loadStats();
            }
        });
    },

    methods: {
        normalizeBaseUrl(value) {
            return String(value || '').trim().replace(/\/+$/, '');
        },

        buildAnalyticsUrl(endpoint) {
            const base = this.normalizeBaseUrl(this.middlewareUrl);
            const cleanEndpoint = String(endpoint || '').trim().replace(/^\/+/, '');
            if (!base || !cleanEndpoint) return '';

            try {
                const url = new URL(base);
                const path = (url.pathname || '').replace(/\/+$/, '');
                if (path.endsWith('/analytics')) {
                    url.pathname = `${path}/${cleanEndpoint}`;
                } else {
                    url.pathname = `${path}/analytics/${cleanEndpoint}`;
                }
                return url.toString();
            } catch (e) {
                if (base.endsWith('/analytics')) {
                    return `${base}/${cleanEndpoint}`;
                }
                return `${base}/analytics/${cleanEndpoint}`;
            }
        },

        async loadConfig() {
            try {
                const systemConfigApiService = Shopware.Service('systemConfigApiService');
                const values = await systemConfigApiService.getValues('CCChatbot.config');
                this.middlewareUrl = values['CCChatbot.config.middlewareUrl'] || '';
                this.middlewareApiKey = values['CCChatbot.config.middlewareApiKey'] || '';
            } catch (e) {
                this.error = 'Failed to load CCChatbot config.';
            }
        },

        async loadStats() {
            if (!this.hasConfig) return;
            this.isLoading = true;
            this.error = null;

            try {
                const url = this.buildAnalyticsUrl('summary');
                if (!url) {
                    throw new Error('Invalid middleware URL.');
                }
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-cc-api-key': this.middlewareApiKey
                    }
                });
                const json = await response.json().catch(() => null);
                if (!response.ok || !json?.success) {
                    throw new Error(json?.error || `HTTP ${response.status}`);
                }
                this.stats = json.stats || {};
                this.topQuestions = Array.isArray(json.topQuestions) ? json.topQuestions : [];
                this.cartActions = this.stats.cartActions || {};
            } catch (e) {
                this.error = `Failed to load stats: ${e.message}`;
            } finally {
                this.isLoading = false;
            }
        },

        formatDateTime(value) {
            if (!value) return '-';
            const d = new Date(value);
            if (!Number.isFinite(d.getTime())) return String(value);
            return d.toLocaleString();
        }
    }
});
