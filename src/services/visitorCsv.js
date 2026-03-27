const fs = require('fs');
const path = require('path');
const { inferUserAgentMetadata } = require('../utils/userAgent');
const { listSessionsInRange } = require('./analyticsStore');

const DEFAULT_TIMEZONE = process.env.VISITOR_CSV_TIMEZONE || 'America/New_York';
const EXPORT_DIR = path.join(__dirname, '..', '..', 'exports', 'visitor-logs');
const CSV_HEADER = [
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
  'notes',
];

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

function getDateKeyForTimeZone(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

function getVisitorCsvPath(dateKey) {
  return path.join(EXPORT_DIR, `visitor-log-${dateKey}.csv`);
}

function parseCsvText(text) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(current);
    current = '';
  };
  const pushRow = () => {
    if (row.length === 1 && row[0] === '') {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      pushField();
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      pushField();
      pushRow();
      continue;
    }

    current += char;
  }

  if (current.length || row.length) {
    pushField();
    pushRow();
  }

  if (!rows.length) return [];
  const header = rows[0].map((value) => String(value || '').trim());
  return rows.slice(1).map((values) => {
    const mapped = {};
    header.forEach((key, index) => {
      mapped[key] = values[index] ?? '';
    });
    return mapped;
  });
}

function listVisitorCsvFiles() {
  if (!fs.existsSync(EXPORT_DIR)) {
    return [];
  }

  return fs.readdirSync(EXPORT_DIR)
    .filter((name) => /^visitor-log-\d{4}-\d{2}-\d{2}\.csv$/i.test(name))
    .sort((a, b) => b.localeCompare(a))
    .map((name) => {
      const filePath = path.join(EXPORT_DIR, name);
      const stat = fs.statSync(filePath);
      return {
        name,
        filePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    });
}

function readVisitorCsvFile(name) {
  const safeName = path.basename(String(name || '').trim());
  if (!/^visitor-log-\d{4}-\d{2}-\d{2}\.csv$/i.test(safeName)) {
    throw new Error('invalid_file_name');
  }

  const filePath = path.join(EXPORT_DIR, safeName);
  const text = fs.readFileSync(filePath, 'utf8');
  return {
    name: safeName,
    filePath,
    rows: parseCsvText(text),
  };
}

function readAllVisitorCsvFiles() {
  return listVisitorCsvFiles().map((file) => ({
    ...file,
    rows: readVisitorCsvFile(file.name).rows,
  }));
}

function buildVisitorCsvRow(row) {
  const client = parseClientContext(row.landing_extra);
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
    row.landing_path || '',
    client.browser || uaMeta.browser || '',
    client.os || uaMeta.os || '',
    client.deviceType || uaMeta.deviceType || '',
    client.deviceName || uaMeta.deviceName || '',
    client.language || '',
    client.timezone || '',
    screen,
    viewport,
    row.user_agent || '',
    Array.isArray(row.notes) ? row.notes.join(' | ') : '',
  ];

  return `${values.map(escapeCsv).join(',')}\n`;
}

function ensureDailyVisitorCsv(dateKey, { timeZone = DEFAULT_TIMEZONE } = {}) {
  if (!dateKey) {
    throw new Error('dateKey is required');
  }

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const filePath = getVisitorCsvPath(dateKey);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${CSV_HEADER.join(',')}\n`, 'utf8');
  }

  return {
    filePath,
    dateKey,
    timeZone,
  };
}

function appendVisitorCsvRow(session, { timeZone = DEFAULT_TIMEZONE } = {}) {
  if (!session || !session.session_id) {
    throw new Error('session with session_id is required');
  }

  const timestamp = session.first_seen instanceof Date ? session.first_seen : new Date(session.first_seen);
  const dateKey = getDateKeyForTimeZone(timestamp, timeZone);
  const { filePath } = ensureDailyVisitorCsv(dateKey, { timeZone });
  fs.appendFileSync(filePath, buildVisitorCsvRow(session), 'utf8');
  return {
    filePath,
    dateKey,
    timeZone,
  };
}

async function exportDailyVisitorCsv(dateKey, { timeZone = DEFAULT_TIMEZONE } = {}) {
  const { from, to } = localDateBounds(dateKey, timeZone);
  const sessions = await listSessionsInRange(from, new Date(to.getTime() - 1));
  const { filePath } = ensureDailyVisitorCsv(dateKey, { timeZone });

  const lines = [`${CSV_HEADER.join(',')}\n`];
  for (const row of [...sessions].sort((a, b) => (a.first_seen?.getTime() || 0) - (b.first_seen?.getTime() || 0))) {
    lines.push(buildVisitorCsvRow(row));
  }

  fs.writeFileSync(filePath, lines.join(''), 'utf8');
  return {
    filePath,
    rowCount: sessions.length,
    dateKey,
    timeZone,
  };
}

module.exports = {
  appendVisitorCsvRow,
  buildVisitorCsvRow,
  ensureDailyVisitorCsv,
  exportDailyVisitorCsv,
  getDateKeyForTimeZone,
  getVisitorCsvPath,
  listVisitorCsvFiles,
  localDateBounds,
  parseCsvText,
  readAllVisitorCsvFiles,
  readVisitorCsvFile,
  EXPORT_DIR,
};
