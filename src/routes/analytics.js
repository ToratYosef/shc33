const express = require('express');
const originGuard = require('../middleware/originGuard');
const analyticsRateLimit = require('../middleware/rateLimit');
const { getClientIp, maskIp } = require('../utils/ip');
const { deriveSource } = require('../utils/source');
const { lookupGeo } = require('../geo/maxmind');
const { inferUserAgentMetadata } = require('../utils/userAgent');
const {
  addSessionEvent,
  getSession,
  resolveServerSession,
  setSession,
} = require('../services/analyticsStore');

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

function coerceEventTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }
  return parseEventTs(value);
}

function parsePage(urlValue) {
  if (!urlValue) return { pageUrl: null, path: null, query: null };
  try {
    const parsed = new URL(urlValue);
    const pathWithQuery = `${parsed.pathname}${parsed.search || ''}`;
    return {
      pageUrl: parsed.toString().slice(0, 2048),
      path: pathWithQuery.slice(0, 512),
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
  const allowedTypes = new Set(['pageview', 'click', 'conversion', 'heartbeat', 'input']);
  for (const event of payload.events) {
    if (!event || typeof event !== 'object') return 'event must be object';
    const eventType = clampString(event.event_type || event.type, 40);
    if (!allowedTypes.has(eventType)) return 'invalid event_type';
    if (event.ts && !coerceEventTimestamp(event.ts)) return 'invalid event ts';
    const pageUrl = event.page_url || event.url;
    if (pageUrl && !clampString(pageUrl, 2048)) return 'invalid page_url';
    if (event.referrer && !clampString(event.referrer, 2048)) return 'invalid referrer';
    if (event.element && typeof event.element !== 'object') return 'element must be object';
    if (event.extra && typeof event.extra !== 'object') return 'extra must be object';
  }
  return null;
}

function normalizeClientContext(extra = {}) {
  const raw = extra && typeof extra === 'object' && extra.client && typeof extra.client === 'object'
    ? extra.client
    : {};

  return {
    browser: clampString(raw.browser, 120),
    os: clampString(raw.os, 120),
    deviceType: clampString(raw.deviceType, 60),
    deviceName: clampString(raw.deviceName, 180),
    language: clampString(raw.language, 32),
    timezone: clampString(raw.timezone, 120),
    platform: clampString(raw.platform, 120),
    screenWidth: Number.isFinite(Number(raw.screenWidth)) ? Number(raw.screenWidth) : null,
    screenHeight: Number.isFinite(Number(raw.screenHeight)) ? Number(raw.screenHeight) : null,
    viewportWidth: Number.isFinite(Number(raw.viewportWidth)) ? Number(raw.viewportWidth) : null,
    viewportHeight: Number.isFinite(Number(raw.viewportHeight)) ? Number(raw.viewportHeight) : null,
    cookieEnabled: typeof raw.cookieEnabled === 'boolean' ? raw.cookieEnabled : null,
    touchPoints: Number.isFinite(Number(raw.touchPoints)) ? Number(raw.touchPoints) : null,
    hardwareConcurrency: Number.isFinite(Number(raw.hardwareConcurrency)) ? Number(raw.hardwareConcurrency) : null,
    deviceMemory: Number.isFinite(Number(raw.deviceMemory)) ? Number(raw.deviceMemory) : null,
  };
}

function normalizeEvent(event) {
  const eventType = clampString(event.event_type || event.type, 40);
  const pageUrl = clampString(event.page_url || event.url, 2048);
  const path = clampString(event.path, 512);
  const title = clampString(event.title, 512);
  const referrer = clampString(event.referrer, 2048);
  const extra = event.extra && typeof event.extra === 'object'
    ? { ...event.extra }
    : {};

  const client = normalizeClientContext(extra);
  if (Object.values(client).some((value) => value !== null)) {
    extra.client = client;
  }
  if (title) {
    extra.title = title;
  }

  return {
    event_type: eventType,
    ts: coerceEventTimestamp(event.ts),
    page_url: pageUrl,
    path,
    referrer,
    element: event.element && typeof event.element === 'object' ? event.element : null,
    extra,
  };
}

function buildLogContext({ sessionId, clientIp, geo, userAgent, event }) {
  const uaMeta = inferUserAgentMetadata(userAgent);
  const client = normalizeClientContext(event.extra || {});
  const source = clampString(event.extra?.source, 120) || 'unknown';
  const referrer = clampString(event.referrer, 512) || 'none';
  const location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'unknown';
  const deviceName = client.deviceName || uaMeta.deviceName || 'unknown';
  const deviceType = client.deviceType || uaMeta.deviceType || 'unknown';
  const browser = client.browser || uaMeta.browser || 'unknown';
  const os = client.os || uaMeta.os || 'unknown';
  const screen = client.screenWidth && client.screenHeight
    ? `${client.screenWidth}x${client.screenHeight}`
    : 'unknown';
  const pageUrl = clampString(event.page_url, 2048) || 'unknown';
  const notes = Array.isArray(event.extra?.notes)
    ? event.extra.notes.filter(Boolean).slice(0, 4).join(' | ')
    : '';

  return [
    `[visitor] session=${sessionId}`,
    `type=${event.event_type}`,
    `path=${event.path || 'unknown'}`,
    `page=${pageUrl}`,
    `source=${source}`,
    `referrer=${referrer}`,
    `ip=${clientIp || 'unknown'}`,
    `location=${location}`,
    `device=${deviceName}`,
    `deviceType=${deviceType}`,
    `browser=${browser}`,
    `os=${os}`,
    `screen=${screen}`,
    `bot=${uaMeta.isBot ? 'yes' : 'no'}`,
    notes ? `notes=${notes}` : '',
  ].join(' ');
}

function extractEventNotes(events = []) {
  const notes = [];
  events.forEach((event) => {
    const eventNotes = Array.isArray(event?.extra?.notes) ? event.extra.notes : [];
    eventNotes.forEach((note) => {
      const text = clampString(note, 280);
      if (text && !notes.includes(text)) {
        notes.push(text);
      }
    });
  });
  return notes.slice(-40);
}

function isConversion(eventType, path) {
  return path === '/order-submitted.html' || path === '/order-submittedpage.html';
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
  const storeFullIp = String(process.env.ANALYTICS_STORE_FULL_IP || 'true').toLowerCase() === 'true';
  const geo = await lookupGeo(clientIp);
  const normalizedEvents = payload.events.map(normalizeEvent);
  const firstEvent = normalizedEvents[0];
  const firstParsed = parsePage(firstEvent.page_url);
  const sourceMeta = deriveSource({ pageUrl: firstEvent.page_url, referrer: firstEvent.referrer });
  const sourceLabel = clampString(firstEvent.extra?.source, 120) || sourceMeta.source;
  const userAgent = clampString(req.headers['user-agent'], 1000);
  const sessionInfo = await resolveServerSession(cookieSessionId, SESSION_TIMEOUT_MS);
  const serverSessionId = sessionInfo.sessionId;
  const firstSeenAt = firstEvent.ts || new Date();
  const lastSeenAt = normalizedEvents[normalizedEvents.length - 1]?.ts || new Date();

  const existingSession = await getSession(serverSessionId);
  const nextNotes = [
    ...(Array.isArray(existingSession?.notes) ? existingSession.notes : []),
    ...extractEventNotes(normalizedEvents),
  ].filter(Boolean);
  const dedupedNotes = [];
  nextNotes.forEach((note) => {
    if (!dedupedNotes.includes(note)) dedupedNotes.push(note);
  });

  await setSession(serverSessionId, {
    session_id: serverSessionId,
    root_session_id: cookieSessionId,
    session_index: sessionInfo.sessionIndex,
    first_seen: firstSeenAt,
    last_seen: lastSeenAt,
    landing_url: firstParsed.pageUrl,
    landing_path: firstParsed.path,
    landing_query: firstParsed.query,
    referrer: clampString(firstEvent.referrer, 2048),
    source: sourceLabel,
    utm: sourceMeta.utm || {},
    user_agent: userAgent,
    ip_masked: ipMasked,
    ip_full: storeFullIp ? clientIp : null,
    country: geo.country || null,
    region: geo.region || null,
    city: geo.city || null,
    landing_extra: firstEvent.extra || null,
    notes: dedupedNotes.slice(-40),
  });

  let converted = false;
  let conversionTime = null;
  for (const [index, event] of normalizedEvents.entries()) {
    const parsedPage = parsePage(event.page_url);

    await addSessionEvent(serverSessionId, {
      session_id: serverSessionId,
      ts: event.ts,
      event_type: event.event_type,
      page_url: parsedPage.pageUrl,
      path: event.path || parsedPage.path,
      query: parsedPage.query,
      referrer: clampString(event.referrer, 2048),
      element: event.element || null,
      extra: event.extra || null,
      seq: index + 1,
    });

    if (event.event_type === 'pageview' || event.event_type === 'conversion' || event.event_type === 'click' || event.event_type === 'input') {
      console.log(buildLogContext({
        sessionId: serverSessionId,
        clientIp,
        geo,
        userAgent,
        event: {
          ...event,
          path: event.path || parsedPage.path,
        },
      }));
    }

    if (!converted && isConversion(event.event_type, parsedPage.path)) {
      converted = true;
      conversionTime = event.ts;
    }
  }

  await setSession(serverSessionId, {
    last_seen: lastSeenAt,
    converted,
    conversion_time: conversionTime || null,
    event_count: normalizedEvents.length,
    notes: dedupedNotes.slice(-40),
  });

  try {
    const sessionDate = firstSeenAt instanceof Date ? firstSeenAt : new Date(firstSeenAt);
    const { exportDailyVisitorCsv, getDateKeyForTimeZone } = require('../services/visitorCsv');
    await exportDailyVisitorCsv(getDateKeyForTimeZone(sessionDate));
  } catch (error) {
    console.error('[visitor-csv] live export failed:', error?.message || error);
  }

  res.set('X-Analytics-Session', serverSessionId);
  return res.status(202).json({ ok: true, session_id: serverSessionId });
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
      page_url: body.page_url || body.url,
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
