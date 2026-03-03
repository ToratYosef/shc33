const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function runMigrations() {
  const migrationPath = path.join(__dirname, '..', '..', 'migrations', '001_analytics_tables.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  await pool.query(sql);
  console.log('Analytics migrations applied.');
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch((error) => {
      console.error('Failed to run migrations:', error);
      return pool.end().finally(() => process.exit(1));
    });
}

module.exports = { runMigrations };
