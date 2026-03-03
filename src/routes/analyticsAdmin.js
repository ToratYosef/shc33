const express = require('express');
const pool = require('../db/pool');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();
router.use(adminAuth);

function parseRange(query) {
  const from = query.from ? new Date(query.from) : new Date(Date.now() - 7 * 86400000);
  const to = query.to ? new Date(query.to) : new Date();
  return { from, to };
}

router.get('/summary', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const totals = (await pool.query(
      `SELECT
         COUNT(*)::int AS sessions,
         COUNT(*) FILTER (WHERE converted)::int AS conversions,
         COUNT(*) FILTER (WHERE converted)::float / NULLIF(COUNT(*),0) AS conversion_rate
       FROM analytics_sessions
       WHERE first_seen BETWEEN $1 AND $2`,
      [from, to]
    )).rows[0];

    const events = (await pool.query(
      `SELECT
         COUNT(*)::int AS total_events,
         COUNT(*) FILTER (WHERE event_type = 'pageview')::int AS pageviews,
         COUNT(*) FILTER (WHERE event_type = 'click')::int AS clicks
       FROM analytics_events
       WHERE ts BETWEEN $1 AND $2`,
      [from, to]
    )).rows[0];

    const byDay = (await pool.query(
      `SELECT DATE_TRUNC('day', ts) AS day, COUNT(*)::int AS events
         FROM analytics_events
        WHERE ts BETWEEN $1 AND $2
        GROUP BY 1
        ORDER BY 1`,
      [from, to]
    )).rows;

    const topSources = (await pool.query(
      `SELECT source, COUNT(*)::int AS sessions
         FROM analytics_sessions
        WHERE first_seen BETWEEN $1 AND $2
        GROUP BY source
        ORDER BY sessions DESC
        LIMIT 10`,
      [from, to]
    )).rows;

    return res.json({
      from,
      to,
      totals,
      events,
      by_day: byDay,
      top_sources: topSources,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/sessions', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    const conditions = ['first_seen BETWEEN $1 AND $2'];
    const values = [from, to];

    if (req.query.source) {
      values.push(String(req.query.source));
      conditions.push(`source = $${values.length}`);
    }
    if (req.query.page) {
      values.push(String(req.query.page));
      conditions.push(`landing_path = $${values.length}`);
    }
    if (typeof req.query.converted !== 'undefined') {
      values.push(String(req.query.converted) === 'true');
      conditions.push(`converted = $${values.length}`);
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    values.push(limit, offset);

    const sql = `SELECT
        session_id, first_seen, last_seen, landing_url, landing_path, referrer,
        source, converted, conversion_time, country, region, city
      FROM analytics_sessions
      WHERE ${conditions.join(' AND ')}
      ORDER BY first_seen DESC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}`;

    const rows = (await pool.query(sql, values)).rows;
    return res.json({ limit, offset, sessions: rows });
  } catch (error) {
    return next(error);
  }
});

router.get('/sessions/:id', async (req, res, next) => {
  try {
    const sessionId = String(req.params.id);
    const session = (await pool.query('SELECT * FROM analytics_sessions WHERE session_id = $1', [sessionId])).rows[0];
    if (!session) {
      return res.status(404).json({ error: 'not_found' });
    }

    const events = (await pool.query(
      `SELECT id, ts, event_type, page_url, path, query, referrer, element, extra
         FROM analytics_events
        WHERE session_id = $1
        ORDER BY ts ASC, id ASC`,
      [sessionId]
    )).rows;

    const timeline = events.map((event, index) => {
      const nextPage = event.event_type === 'pageview'
        ? events.slice(index + 1).find((item) => item.event_type === 'pageview')?.path || null
        : null;
      return {
        ...event,
        next_page: nextPage,
      };
    });

    return res.json({ session, events: timeline });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
