const express = require('express');
const adminAuth = require('../middleware/adminAuth');
const {
  getSession,
  getSessionEvents,
  listEventsInRange,
  listSessionsInRange,
} = require('../services/analyticsStore');
const {
  listVisitorCsvFiles,
  readAllVisitorCsvFiles,
} = require('../services/visitorCsv');

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
    const sessions = await listSessionsInRange(from, to);
    const events = await listEventsInRange(from, to);

    const conversions = sessions.filter((session) => session.converted).length;
    const totals = {
      sessions: sessions.length,
      conversions,
      conversion_rate: sessions.length ? conversions / sessions.length : 0,
    };

    const eventSummary = {
      total_events: events.length,
      pageviews: events.filter((event) => event.event_type === 'pageview').length,
      clicks: events.filter((event) => event.event_type === 'click').length,
    };

    const dayCounts = new Map();
    for (const event of events) {
      const dayKey = event.ts ? event.ts.toISOString().slice(0, 10) : 'unknown';
      dayCounts.set(dayKey, (dayCounts.get(dayKey) || 0) + 1);
    }

    const sourceCounts = new Map();
    for (const session of sessions) {
      const sourceKey = session.source || 'unknown';
      sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) || 0) + 1);
    }

    return res.json({
      from,
      to,
      totals,
      events: eventSummary,
      by_day: Array.from(dayCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([day, count]) => ({ day, events: count })),
      top_sources: Array.from(sourceCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([source, count]) => ({ source, sessions: count })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/sessions', async (req, res, next) => {
  try {
    const { from, to } = parseRange(req.query);
    let sessions = await listSessionsInRange(from, to);

    if (req.query.source) {
      const source = String(req.query.source);
      sessions = sessions.filter((session) => session.source === source);
    }
    if (req.query.page) {
      const page = String(req.query.page);
      sessions = sessions.filter((session) => session.landing_path === page);
    }
    if (typeof req.query.converted !== 'undefined') {
      const converted = String(req.query.converted) === 'true';
      sessions = sessions.filter((session) => session.converted === converted);
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    return res.json({
      limit,
      offset,
      sessions: sessions.slice(offset, offset + limit),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/sessions/:id', async (req, res, next) => {
  try {
    const sessionId = String(req.params.id);
    const session = await getSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'not_found' });
    }

    const events = await getSessionEvents(sessionId);
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

router.get('/visitor-csvs', async (req, res, next) => {
  try {
    const includeRows = String(req.query.include_rows || 'true') === 'true';
    if (!includeRows) {
      return res.json({ files: listVisitorCsvFiles() });
    }

    const files = readAllVisitorCsvFiles();
    const rows = files.flatMap((file) => (
      Array.isArray(file.rows)
        ? file.rows.map((row) => ({ ...row, __file: file.name }))
        : []
    ));

    return res.json({
      files: files.map(({ rows: _rows, ...rest }) => rest),
      rows,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
