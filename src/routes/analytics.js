/**
 * Analytics Routes (Postgres)
 *
 * Mount path in app.js: /api/analytics
 *
 * Endpoints:
 *   POST   /              - ingest events batch
 *   GET    /              - aggregated stats + recent events + last questions
 *   GET    /questions     - recent questions + top repeated questions
 *   GET    /performance   - response time metrics (last hour + all-time)
 *   GET    /summary       - compact summary for dashboards
 */

const express = require('express');
const db = require('../db');

const router = express.Router();

function safeNumber(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
}

function avg(arr) {
    return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

function computeStats(responseTimes, firstChunkTimes, totals) {
    const rt = responseTimes.filter(Number.isFinite);
    const fc = firstChunkTimes.filter(Number.isFinite);
    return {
        ...totals,
        avgResponseTime: avg(rt),
        minResponseTime: rt.length ? Math.min(...rt) : 0,
        maxResponseTime: rt.length ? Math.max(...rt) : 0,
        avgTimeToFirstChunk: avg(fc),
        minTimeToFirstChunk: fc.length ? Math.min(...fc) : 0,
        maxTimeToFirstChunk: fc.length ? Math.max(...fc) : 0
    };
}

function extractEventFields(event) {
    const type = event.type || event.event || '';
    const sessionId = event.sessionId || event.session_id || event.data?.sessionId || null;
    const timestamp = safeNumber(event.timestamp || event.data?.timestamp) || null;

    const question = (event.question || event.data?.question || event.transcript || event.data?.transcript || '').toString().trim() || null;
    const length = safeNumber(event.length || event.data?.length || event.transcriptLength || event.data?.transcriptLength);
    const responseTime = safeNumber(event.responseTime || event.data?.responseTime);
    const timeToFirstChunk = safeNumber(event.timeToFirstChunk || event.data?.timeToFirstChunk);
    const action = (event.action || event.data?.action || '').toString().trim() || null;

    return {
        type,
        sessionId,
        timestamp,
        question,
        length,
        responseTime,
        timeToFirstChunk,
        action
    };
}

async function insertEvents(tenantId, apiKey, events) {
    if (!events.length) return;

    const values = [];
    const placeholders = [];
    let idx = 1;

    for (const event of events) {
        if (!event || typeof event !== 'object') continue;
        const serverTimestamp = Date.now();
        event.serverTimestamp = serverTimestamp;

        const fields = extractEventFields(event);
        placeholders.push(
            `($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`
        );
        values.push(
            tenantId,
            fields.type || 'unknown',
            apiKey,
            fields.sessionId,
            fields.timestamp,
            serverTimestamp,
            fields.question,
            fields.length,
            fields.responseTime,
            fields.timeToFirstChunk,
            fields.action,
            event
        );
    }

    if (!placeholders.length) return;

    await db.query(
        `
        INSERT INTO analytics_events
            (tenant_id, event_type, api_key, session_id, timestamp, server_timestamp, question, length, response_time, time_to_first_chunk, action, data)
        VALUES ${placeholders.join(', ')}
        `,
        values
    );
}

// -----------------------------------------------------------------
// POST /api/analytics
// -----------------------------------------------------------------
router.post('/', async (req, res) => {
    try {
        const { events } = req.body || {};
        if (!Array.isArray(events)) {
            return res.status(400).json({ success: false, error: 'events array required' });
        }
        if (!req.tenant?.id) {
            return res.status(400).json({ success: false, error: 'tenant_required' });
        }

        await insertEvents(req.tenant.id, req.tenant.apiKeyUsed || null, events);
        res.json({ success: true, received: events.length });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to save analytics' });
    }
});

// -----------------------------------------------------------------
// GET /api/analytics
// -----------------------------------------------------------------
router.get('/', async (req, res) => {
    try {
        const tenantId = req.tenant?.id;
        if (!tenantId) return res.status(400).json({ success: false, error: 'tenant_required' });

        const totals = await db.query(
            `
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'message_sent') AS total_messages,
                COUNT(DISTINCT session_id) AS total_sessions,
                COUNT(*) FILTER (WHERE event_type = 'voice_input_complete') AS voice_input_used,
                COUNT(*) FILTER (WHERE event_type = 'message_error') AS errors
            FROM analytics_events
            WHERE tenant_id = $1
            `,
            [tenantId]
        );

        const quickActions = await db.query(
            `
            SELECT action, COUNT(*)::int AS count
            FROM analytics_events
            WHERE tenant_id = $1 AND event_type = 'quick_action_click' AND action IS NOT NULL
            GROUP BY action
            `,
            [tenantId]
        );

        const responseTimesRes = await db.query(
            `
            SELECT response_time
            FROM analytics_events
            WHERE tenant_id = $1 AND response_time IS NOT NULL
            ORDER BY server_timestamp DESC
            LIMIT 2000
            `,
            [tenantId]
        );

        const firstChunkRes = await db.query(
            `
            SELECT time_to_first_chunk
            FROM analytics_events
            WHERE tenant_id = $1 AND time_to_first_chunk IS NOT NULL
            ORDER BY server_timestamp DESC
            LIMIT 2000
            `,
            [tenantId]
        );

        const recentEventsRes = await db.query(
            `
            SELECT data
            FROM analytics_events
            WHERE tenant_id = $1
            ORDER BY server_timestamp DESC
            LIMIT 50
            `,
            [tenantId]
        );

        const questionsRes = await db.query(
            `
            SELECT question, timestamp, session_id, event_type, length
            FROM analytics_events
            WHERE tenant_id = $1 AND question IS NOT NULL
            ORDER BY server_timestamp DESC
            LIMIT 100
            `,
            [tenantId]
        );

        const leadsRes = await db.query(
            `
            SELECT COUNT(*)::int AS count
            FROM leads
            WHERE tenant_id = $1
            `,
            [tenantId]
        );

        const totalsRow = totals.rows[0] || {};
        const stats = computeStats(
            responseTimesRes.rows.map(r => safeNumber(r.response_time)).filter(Number.isFinite),
            firstChunkRes.rows.map(r => safeNumber(r.time_to_first_chunk)).filter(Number.isFinite),
            {
                totalMessages: parseInt(totalsRow.total_messages || '0', 10),
                totalSessions: parseInt(totalsRow.total_sessions || '0', 10),
                voiceInputUsed: parseInt(totalsRow.voice_input_used || '0', 10),
                quickActionClicks: quickActions.rows.reduce((acc, r) => {
                    acc[r.action] = r.count;
                    return acc;
                }, {}),
                errors: parseInt(totalsRow.errors || '0', 10),
                leads: parseInt(leadsRes.rows[0]?.count || '0', 10)
            }
        );

        res.json({
            stats,
            recentEvents: recentEventsRes.rows.map(r => r.data),
            questions: questionsRes.rows.map(r => ({
                question: r.question,
                timestamp: r.timestamp,
                sessionId: r.session_id,
                length: r.length,
                isVoiceInput: r.event_type === 'voice_input_complete'
            }))
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load analytics' });
    }
});

// -----------------------------------------------------------------
// GET /api/analytics/questions
// -----------------------------------------------------------------
router.get('/questions', async (req, res) => {
    try {
        const tenantId = req.tenant?.id;
        if (!tenantId) return res.status(400).json({ success: false, error: 'tenant_required' });

        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const questionsRes = await db.query(
            `
            SELECT question, timestamp, session_id, event_type, length
            FROM analytics_events
            WHERE tenant_id = $1 AND question IS NOT NULL
            ORDER BY server_timestamp DESC
            LIMIT $2
            `,
            [tenantId, limit]
        );

        const questions = questionsRes.rows.map(r => ({
            question: r.question,
            timestamp: r.timestamp,
            sessionId: r.session_id,
            isVoiceInput: r.event_type === 'voice_input_complete',
            length: r.length
        }));

        const grouped = {};
        for (const q of questions) {
            const normalized = (q.question || '').toLowerCase().trim();
            if (!normalized) continue;
            if (!grouped[normalized]) {
                grouped[normalized] = { question: q.question, count: 0, lastAsked: q.timestamp };
            }
            grouped[normalized].count++;
            if (q.timestamp > grouped[normalized].lastAsked) grouped[normalized].lastAsked = q.timestamp;
        }

        const topQuestions = Object.values(grouped)
            .sort((a, b) => b.count - a.count)
            .slice(0, 50);

        res.json({
            total: questions.length,
            questions,
            topQuestions
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load questions' });
    }
});

// -----------------------------------------------------------------
// GET /api/analytics/performance
// -----------------------------------------------------------------
router.get('/performance', async (req, res) => {
    try {
        const tenantId = req.tenant?.id;
        if (!tenantId) return res.status(400).json({ success: false, error: 'tenant_required' });

        const lastHour = Date.now() - (60 * 60 * 1000);
        const perfRes = await db.query(
            `
            SELECT event_type, response_time, time_to_first_chunk, timestamp, server_timestamp
            FROM analytics_events
            WHERE tenant_id = $1 AND COALESCE(timestamp, server_timestamp) >= $2
            `,
            [tenantId, lastHour]
        );

        const lastHourEvents = perfRes.rows || [];
        const responseTimes = lastHourEvents
            .filter(e => e.event_type === 'message_received')
            .map(e => safeNumber(e.response_time))
            .filter(Number.isFinite);

        const firstChunkTimes = lastHourEvents
            .filter(e => e.event_type === 'first_response_chunk' || e.event_type === 'message_received')
            .map(e => safeNumber(e.time_to_first_chunk))
            .filter(Number.isFinite);

        const allTimeTotals = await db.query(
            `
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'message_sent') AS total_messages,
                COUNT(*) FILTER (WHERE event_type = 'message_error') AS errors
            FROM analytics_events
            WHERE tenant_id = $1
            `,
            [tenantId]
        );

        const totalMessages = parseInt(allTimeTotals.rows[0]?.total_messages || '0', 10);
        const errors = parseInt(allTimeTotals.rows[0]?.errors || '0', 10);

        res.json({
            lastHour: {
                messages: responseTimes.length,
                avgResponseTime: avg(responseTimes),
                avgTimeToFirstChunk: avg(firstChunkTimes),
                maxResponseTime: responseTimes.length ? Math.max(...responseTimes) : 0,
                minResponseTime: responseTimes.length ? Math.min(...responseTimes) : 0
            },
            allTime: {
                totalMessages,
                errors,
                errorRate: totalMessages ? ((errors / totalMessages) * 100).toFixed(2) + '%' : '0%'
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load performance data' });
    }
});

// -----------------------------------------------------------------
// GET /api/analytics/summary
// -----------------------------------------------------------------
router.get('/summary', async (req, res) => {
    try {
        const tenantId = req.tenant?.id;
        if (!tenantId) return res.status(400).json({ success: false, error: 'tenant_required' });

        const totals = await db.query(
            `
            SELECT
                COUNT(*) FILTER (WHERE event_type = 'message_sent') AS total_messages,
                COUNT(DISTINCT session_id) AS total_sessions,
                COUNT(*) FILTER (WHERE event_type = 'voice_input_complete') AS voice_input_used,
                COUNT(*) FILTER (WHERE event_type = 'message_error') AS errors
            FROM analytics_events
            WHERE tenant_id = $1
            `,
            [tenantId]
        );

        const cartCounts = await db.query(
            `
            SELECT event_type, COUNT(*)::int AS count
            FROM analytics_events
            WHERE tenant_id = $1 AND event_type IN
                ('cart_add', 'cart_remove', 'cart_update_qty', 'cart_cleared', 'suggestion_confirm')
            GROUP BY event_type
            `,
            [tenantId]
        );

        const questionsRes = await db.query(
            `
            SELECT question, COALESCE(timestamp, server_timestamp) AS asked_at
            FROM analytics_events
            WHERE tenant_id = $1 AND question IS NOT NULL
            ORDER BY server_timestamp DESC
            LIMIT 500
            `,
            [tenantId]
        );

        const leadsRes = await db.query(
            `
            SELECT COUNT(*)::int AS count
            FROM leads
            WHERE tenant_id = $1
            `,
            [tenantId]
        );

        const grouped = {};
        for (const q of questionsRes.rows || []) {
            const normalized = (q.question || '').toLowerCase().trim();
            if (!normalized) continue;
            if (!grouped[normalized]) {
                grouped[normalized] = { question: q.question, count: 0, lastAsked: q.asked_at || null };
            }
            grouped[normalized].count++;
            if (q.asked_at && (!grouped[normalized].lastAsked || q.asked_at > grouped[normalized].lastAsked)) {
                grouped[normalized].lastAsked = q.asked_at;
            }
        }
        const topQuestions = Object.values(grouped)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        const usageRes = await db.query(
            `
            SELECT
                COALESCE(SUM(tokens_used), 0)::bigint AS tokens_used,
                COALESCE(SUM(request_count), 0)::bigint AS request_count
            FROM api_key_usage
            WHERE tenant_id = $1
            `,
            [tenantId]
        );
        const lastUsedRes = await db.query(
            `
            SELECT last_used_at, last_used_ip
            FROM api_key_usage
            WHERE tenant_id = $1 AND last_used_at IS NOT NULL
            ORDER BY last_used_at DESC
            LIMIT 1
            `,
            [tenantId]
        );

        const totalsRow = totals.rows[0] || {};
        res.json({
            success: true,
            stats: {
                totalMessages: parseInt(totalsRow.total_messages || '0', 10),
                totalSessions: parseInt(totalsRow.total_sessions || '0', 10),
                voiceInputUsed: parseInt(totalsRow.voice_input_used || '0', 10),
                errors: parseInt(totalsRow.errors || '0', 10),
                leads: parseInt(leadsRes.rows[0]?.count || '0', 10),
                tokensUsed: parseInt(usageRes.rows[0]?.tokens_used || '0', 10),
                requestCount: parseInt(usageRes.rows[0]?.request_count || '0', 10),
                lastUsedAt: lastUsedRes.rows[0]?.last_used_at || null,
                lastUsedIp: lastUsedRes.rows[0]?.last_used_ip || null,
                cartActions: cartCounts.rows.reduce((acc, r) => {
                    acc[r.event_type] = r.count;
                    return acc;
                }, {})
            },
            topQuestions
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to load summary' });
    }
});

module.exports = router;
