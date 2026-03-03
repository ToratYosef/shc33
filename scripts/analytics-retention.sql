WITH deleted AS (
  DELETE FROM analytics_sessions
  WHERE last_seen < NOW() - ($1::text || ' days')::interval
  RETURNING session_id
)
SELECT COUNT(*)::int AS deleted_sessions FROM deleted;
