CREATE TABLE IF NOT EXISTS analytics_sessions (
  session_id TEXT PRIMARY KEY,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL,
  landing_url TEXT,
  landing_path TEXT,
  landing_query TEXT,
  referrer TEXT,
  source TEXT,
  utm JSONB,
  user_agent TEXT,
  ip_masked TEXT,
  ip_full TEXT NULL,
  country TEXT NULL,
  region TEXT NULL,
  city TEXT NULL,
  converted BOOLEAN NOT NULL DEFAULT false,
  conversion_time TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT REFERENCES analytics_sessions(session_id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  page_url TEXT,
  path TEXT,
  query TEXT,
  referrer TEXT,
  element JSONB,
  extra JSONB
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_ts ON analytics_events(ts);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_ts ON analytics_events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_first_seen ON analytics_sessions(first_seen);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_converted ON analytics_sessions(converted);
CREATE INDEX IF NOT EXISTS idx_analytics_sessions_source ON analytics_sessions(source);
