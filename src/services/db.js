const crypto = require('crypto');
const pool = require('../db/pool');

const TABLES = new Set([
  'orders',
  'users',
  'admins',
  'signed_up_emails',
  'counters',
  'devices_iphone_models',
  'devices_samsung_models',
  'support_tickets',
  'chat_feedback',
]);

function assertTable(table) {
  if (!TABLES.has(table)) {
    throw new Error(`Unsupported table: ${table}`);
  }
}

async function getById(table, id) {
  assertTable(table);
  const res = await pool.query(`SELECT data FROM ${table} WHERE id = $1`, [id]);
  return res.rows[0]?.data ?? null;
}

async function getWithId(table, id) {
  assertTable(table);
  const res = await pool.query(`SELECT id, data FROM ${table} WHERE id = $1`, [id]);
  if (!res.rows[0]) return null;
  return { id: res.rows[0].id, ...res.rows[0].data };
}

async function upsert(table, id, data) {
  assertTable(table);
  const query = `
    INSERT INTO ${table} (id, data, migrated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE
      SET data = EXCLUDED.data,
          migrated_at = NOW()
    RETURNING data;
  `;
  const res = await pool.query(query, [id, data]);
  return res.rows[0]?.data ?? null;
}

async function insertWithGeneratedId(table, data) {
  const id = crypto.randomUUID();
  await upsert(table, id, data);
  return id;
}

async function existsById(table, id) {
  assertTable(table);
  const res = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  return res.rowCount > 0;
}

module.exports = {
  pool,
  getById,
  getWithId,
  upsert,
  insertWithGeneratedId,
  existsById,
};
