const express = require('express');
const pool = require('../db/pool');
const originGuard = require('../middleware/originGuard');
const analyticsRateLimit = require('../middleware/rateLimit');
const { getClientIp, maskIp } = require('../utils/ip');
const { deriveSource } = require('../utils/source');
const { lookupGeo } = require('../geo/maxmind');

const router = express.Router();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

router.use(express.json({ limit: '20kb' }));

function clampString(value, max = 1024) {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out ? out.slice(0, max) : null;
}

function parseEventTs(value) {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parsePage(urlValue) {
  if (!urlValue) return { pageUrl: null, path: null, query: null };
  try {
    const parsed = new URL(urlValue);
    return {
      pageUrl: parsed.toString().slice(0, 2048),
      path: parsed.pathname.slice(0, 512),
      query: parsed.search ? parsed.search.slice(1, 1024) : null,
    };
  } catch (error) {
    return { pageUrl: null, path: null, query: null };
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return 'payload must be object';
  const sessionId = clampString(payload.session_id, 120);
  if (!sessionId) return 'session_id is required';
  if (!Array.isArray(payload.events) || payload.events.length < 1 || payload.events.length > 25) {
    return 'events must be array length 1..25';
  }
  const allowedTypes = new Set(['pageview', 'click', 'conversion', 'heartbeat']);
  for (const event of payload.events) {
    if (!event || typeof event !== 'object') return 'event must be object';
    if (!allowedTypes.has(event.event_type)) return 'invalid event_type';
    if (event.ts && !parseEventTs(event.ts)) return 'invalid event ts';
    if (event.page_url && !clampString(event.page_url, 2048)) return 'invalid page_url';
    if (event.referrer && !clampString(event.referrer, 2048)) return 'invalid referrer';
    if (event.element && typeof event.element !== 'object') return 'element must be object';
    if (event.extra && typeof event.extra !== 'object') return 'extra must be object';
  }
  return null;
}

async function resolveServerSession(client, cookieSessionId) {
  const rows = (await client.query(
    `SELECT session_id, last_seen
       FROM analytics_sessions
      WHERE session_id = $1 OR session_id LIKE $2`,
    [cookieSessionId, `${cookieSessionId}:%`]
  )).rows;

  if (!rows.length) {
    return cookieSessionId;
  }

  let maxSuffix = 1;
  let latest = rows[0];
  for (const row of rows) {
    if (new Date(row.last_seen).getTime() > new Date(latest.last_seen).getTime()) {
      latest = row;
    }

    if (row.session_id === cookieSessionId) {
      maxSuffix = Math.max(maxSuffix, 1);
    } else if (row.session_id.startsWith(`${cookieSessionId}:`)) {
      const suffix = Number(row.session_id.split(':').pop());
      if (Number.isInteger(suffix)) {
        maxSuffix = Math.max(maxSuffix, suffix);
      }
    }
  }

  const isTimedOut = Date.now() - new Date(latest.last_seen).getTime() > SESSION_TIMEOUT_MS;
  if (!isTimedOut) {
    return latest.session_id;
  }

  return `${cookieSessionId}:${maxSuffix + 1}`;
}

function isConversion(eventType, path) {
  return eventType === 'conversion' || path === '/order-submittedpage.html';
}

async function ingest(req, res, payload) {
  const validationError = validatePayload(payload);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const cookieSessionId = clampString(payload.session_id, 120);
  const clientIp = getClientIp(req);
  req.analyticsClientIp = clientIp;
  const ipMasked = maskIp(clientIp);
  const storeFullIp = String(process.env.ANALYTICS_STORE_FULL_IP || 'false').toLowerCase() === 'true';
  const geo = await lookupGeo(clientIp);

  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const serverSessionId = await resolveServerSession(db, cookieSessionId);

    const firstEvent = payload.events[0];
    const firstParsed = parsePage(firstEvent.page_url);
    const sourceMeta = deriveSource({ pageUrl: firstEvent.page_url, referrer: firstEvent.referrer });

    await db.query(
      `INSERT INTO analytics_sessions (
        session_id, first_seen, last_seen, landing_url, landing_path, landing_query,
        referrer, source, utm, user_agent, ip_masked, ip_full, country, region, city
      ) VALUES ($1, NOW(), NOW(), $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (session_id)
      DO UPDATE SET
        last_seen = NOW(),
        user_agent = COALESCE(EXCLUDED.user_agent, analytics_sessions.user_agent),
        referrer = COALESCE(analytics_sessions.referrer, EXCLUDED.referrer)`,
      [
        serverSessionId,
        firstParsed.pageUrl,
        firstParsed.path,
        firstParsed.query,
        clampString(firstEvent.referrer, 2048),
        sourceMeta.source,
        JSON.stringify(sourceMeta.utm || {}),
        clampString(req.headers['user-agent'], 1000),
        ipMasked,
        storeFullIp ? clientIp : null,
        geo.country,
        geo.region,
        geo.city,
      ]
    );

    let converted = false;
    let conversionTime = null;
    for (const event of payload.events) {
      const parsedTs = parseEventTs(event.ts);
      const parsedPage = parsePage(event.page_url);
      const referrer = clampString(event.referrer, 2048);

      await db.query(
        `INSERT INTO analytics_events
          (session_id, ts, event_type, page_url, path, query, referrer, element, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
        [
          serverSessionId,
          parsedTs,
          event.event_type,
          parsedPage.pageUrl,
          parsedPage.path,
          parsedPage.query,
          referrer,
          JSON.stringify(event.element || null),
          JSON.stringify(event.extra || null),
        ]
      );

      if (!converted && isConversion(event.event_type, parsedPage.path)) {
        converted = true;
        conversionTime = parsedTs;
      }
    }

    if (converted) {
      await db.query(
        `UPDATE analytics_sessions
            SET converted = true,
                conversion_time = COALESCE(conversion_time, $2)
          WHERE session_id = $1`,
        [serverSessionId, conversionTime]
      );
    }

    await db.query('COMMIT');
    res.set('X-Analytics-Session', serverSessionId);
    return res.status(202).json({ ok: true, session_id: serverSessionId });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

router.post('/collect', originGuard, analyticsRateLimit, async (req, res, next) => {
  try {
    return await ingest(req, res, req.body);
  } catch (error) {
    return next(error);
  }
});

router.post('/heartbeat', originGuard, analyticsRateLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    const event = {
      event_type: 'heartbeat',
      ts: body.ts,
      page_url: body.page_url,
      referrer: body.referrer,
      extra: body.extra,
    };
    return await ingest(req, res, {
      session_id: body.session_id,
      events: [event],
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
