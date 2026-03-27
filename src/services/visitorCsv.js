const fs = require('fs');
const path = require('path');
const { inferUserAgentMetadata } = require('../utils/userAgent');

const DEFAULT_TIMEZONE = process.env.VISITOR_CSV_TIMEZONE || 'America/New_York';
const EXPORT_DIR = path.join(__dirname, '..', '..', 'exports', 'visitor-logs');

function escapeCsv(value) {
  const stringValue = value == null ? '' : String(value);
  if (!/[",\n]/.test(stringValue)) {
    return stringValue;
  }
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function parseClientContext(extra) {
  if (!extra || typeof extra !== 'object') {
    return {};
  }
  return extra.client && typeof extra.client === 'object' ? extra.client : {};
}

function formatLocation(row = {}) {
  return [row.city, row.region, row.country].filter(Boolean).join(', ');
}

function localDateBounds(dateKey, timeZone = DEFAULT_TIMEZONE) {
  const safeDateKey = String(dateKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDateKey)) {
    throw new Error('dateKey must be YYYY-MM-DD');
  }

  const [year, month, day] = safeDateKey.split('-').map(Number);
  const baseUtc = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const zoned = new Date(baseUtc.toLocaleString('en-US', { timeZone }));
  const offsetMs = zoned.getTime() - baseUtc.getTime();
  const from = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMs);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, to };
}

async function exportDailyVisitorCsv(dateKey, { timeZone = DEFAULT_TIMEZONE } = {}) {
  const pool = require('../db/pool');
  const { from, to } = localDateBounds(dateKey, timeZone);
  const result = await pool.query(
    `WITH first_pageviews AS (
       SELECT DISTINCT ON (e.session_id)
         e.session_id,
         e.ts,
         e.path,
         e.page_url,
         e.extra
       FROM analytics_events e
       WHERE e.event_type = 'pageview'
         AND e.ts >= $1
         AND e.ts < $2
       ORDER BY e.session_id, e.ts ASC, e.id ASC
     )
     SELECT
       s.session_id,
       s.first_seen,
       s.last_seen,
       s.ip_full,
       s.ip_masked,
       s.country,
       s.region,
       s.city,
       s.user_agent,
       s.source,
       fp.path,
       fp.page_url,
       fp.extra
     FROM analytics_sessions s
     INNER JOIN first_pageviews fp ON fp.session_id = s.session_id
     ORDER BY s.first_seen ASC`,
    [from, to]
  );

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const filePath = path.join(EXPORT_DIR, `visitor-log-${dateKey}.csv`);
  const header = [
    'timestamp',
    'session_id',
    'ip_address',
    'country',
    'region',
    'city',
    'location',
    'source',
    'landing_path',
    'browser',
    'os',
    'device_type',
    'device_name',
    'language',
    'timezone',
    'screen',
    'viewport',
    'user_agent',
  ];

  const lines = [header.join(',')];
  for (const row of result.rows) {
    const client = parseClientContext(row.extra);
    const uaMeta = inferUserAgentMetadata(row.user_agent);
    const screen = client.screenWidth && client.screenHeight
      ? `${client.screenWidth}x${client.screenHeight}`
      : '';
    const viewport = client.viewportWidth && client.viewportHeight
      ? `${client.viewportWidth}x${client.viewportHeight}`
      : '';

    const values = [
      row.first_seen instanceof Date ? row.first_seen.toISOString() : row.first_seen,
      row.session_id,
      row.ip_full || row.ip_masked || '',
      row.country || '',
      row.region || '',
      row.city || '',
      formatLocation(row),
      row.source || '',
      row.path || '',
      client.browser || uaMeta.browser || '',
      client.os || uaMeta.os || '',
      client.deviceType || uaMeta.deviceType || '',
      client.deviceName || uaMeta.deviceName || '',
      client.language || '',
      client.timezone || '',
      screen,
      viewport,
      row.user_agent || '',
    ];
    lines.push(values.map(escapeCsv).join(','));
  }

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return {
    filePath,
    rowCount: result.rows.length,
    dateKey,
    timeZone,
  };
}

module.exports = {
  exportDailyVisitorCsv,
  localDateBounds,
  EXPORT_DIR,
};
