const fs = require('fs');

let readerPromise;

async function getReader() {
  const dbPath = process.env.MAXMIND_DB_PATH;
  if (!dbPath) return null;

  if (!readerPromise) {
    readerPromise = (async () => {
      if (!fs.existsSync(dbPath)) {
        return null;
      }
      // Optional dependency; only loaded when configured.
      const maxmind = require('maxmind');
      return maxmind.open(dbPath);
    })();
  }

  return readerPromise;
}

async function lookupGeo(ip) {
  if (!ip) return { country: null, region: null, city: null };
  const reader = await getReader();
  if (!reader) return { country: null, region: null, city: null };

  const result = reader.get(ip);
  return {
    country: result?.country?.iso_code || null,
    region: result?.subdivisions?.[0]?.names?.en || null,
    city: result?.city?.names?.en || null,
  };
}

module.exports = {
  lookupGeo,
};
