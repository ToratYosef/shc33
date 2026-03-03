#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');

async function run() {
  const days = Number(process.env.ANALYTICS_RETENTION_DAYS || 90);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('ANALYTICS_RETENTION_DAYS must be a positive integer.');
  }

  const sqlPath = path.join(__dirname, 'analytics-retention.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const result = await pool.query(sql, [days]);

  console.log(JSON.stringify({
    ok: true,
    retention_days: days,
    deleted_sessions: result.rows[0]?.deleted_sessions || 0,
  }));
}

run()
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
