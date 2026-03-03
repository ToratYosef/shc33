# Analytics Backend

This repo now provides first-party analytics endpoints mounted under `/analytics/...`.

## Endpoints

Public:
- `POST /analytics/collect`
- `POST /analytics/heartbeat`

Admin (Bearer auth):
- `GET /analytics/admin/summary?from=&to=`
- `GET /analytics/admin/sessions?from=&to=&source=&page=&converted=&limit=&offset=`
- `GET /analytics/admin/sessions/:id`

## Environment variables

- `DATABASE_URL` (required)
- `ANALYTICS_ADMIN_TOKEN` (required for admin APIs)
- `ANALYTICS_ALLOWED_HOSTS` (required for collect/heartbeat, CSV list of allowed Origin/Referer hosts)
- `ANALYTICS_STORE_FULL_IP` (optional, default `false`; set `true` to store full IP in `ip_full`)
- `MAXMIND_DB_PATH` (optional path to GeoLite2-City `.mmdb`)
- `ANALYTICS_RETENTION_DAYS` (optional, default `90`)
- `ANALYTICS_RATE_LIMIT_MAX` (optional, default `120` requests/window)
- `ANALYTICS_RATE_LIMIT_WINDOW_MS` (optional, default `60000`)

## Migrations

Run:

```bash
node src/db/migrate.js
```

This applies `migrations/001_analytics_tables.sql`.

## IP storage behavior

Default behavior stores only masked IP (`IPv4 /24`, `IPv6 /48`) in `ip_masked`.

To also store full IP, set:

```bash
ANALYTICS_STORE_FULL_IP=true
```

## Retention cleanup

Run manually:

```bash
node scripts/analytics-retention.js
```

Cron example (daily at 03:15 UTC):

```cron
15 3 * * * cd /workspace/shc33 && ANALYTICS_RETENTION_DAYS=90 node scripts/analytics-retention.js >> /var/log/analytics-retention.log 2>&1
```

## Nginx / proxy notes

Forward client headers so backend can resolve real IP and origin checks:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
proxy_set_header Origin $http_origin;
proxy_set_header Referer $http_referer;
```

`src/server.js` enables Express proxy support via `app.set('trust proxy', true)`.
