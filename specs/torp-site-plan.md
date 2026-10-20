# Torp website & heating control: project plan

Context and scope for building a public site about a holiday house (a Swedish *torp* near Värnamo) plus a login-protected admin area. The first admin panel controls the heat pump through the tado° API to keep the house frost-free cheaply.

**Status:** planning done, nothing built yet. Before writing code, confirm the open decisions at the bottom with the owner.

---

## 1. Background

- The house is empty most of the winter and must stay frost-free. Värnamo winters regularly reach −15 to −20°C.
- Heating options in the house:
  - **Air-to-air heat pump**, controlled by a **tado° Smart AC Control** (infrared). Through tado° the lowest setpoint is about 17–18°C, and tado° does **not** support the pump's 8/10°C maintenance mode.
  - **Electric panel heaters** that can be set to 5–7°C. These stay on as a **backup at about 5°C** whatever the software does.
- Holding 17°C with the heat pump costs about the same as holding 7°C with electric heat. The plan is to **cycle the heat pump on and off** around a low band (about 8–10°C), which costs roughly a third of the electric option.
- Damp is the other concern. The house should stay at about 8–10°C with relative humidity below about 70%. The tado° unit reports humidity.

## 2. Goals

1. A **simple public website** describing the house.
2. An **admin area behind a login**, designed to hold several panels over time.
3. The **first panel, Heating**, which:
   - checks the tado° zone **every hour**;
   - switches the heat pump **ON (HEAT, lowest allowed setpoint)** below an "on" threshold;
   - switches it **OFF** above an "off" threshold;
   - logs each reading and action;
   - shows status, editable thresholds and a history chart.

## 3. Non-goals (for now)

- Email or push alerts. These are a likely next panel, for example "below 6°C" or "checks failing for 3 hours".
- Editing the public page from the browser. Content lives in the repo for now.
- Bookings, user accounts, or any public display of temperatures or occupancy.
- Home Assistant or any on-site hardware.

## 4. Architecture

Everything runs on **Cloudflare's free tier**, in **one Worker on one custom domain**.

| Piece | Purpose |
|---|---|
| Cloudflare Worker (TypeScript) | Serves the public site, the admin pages and the admin JSON API; runs the hourly cron |
| Workers static assets | Public pages, admin HTML/CSS/JS, photos |
| D1 (SQLite) | tado° tokens, panel settings, heating history |
| Cron Trigger `0 * * * *` | Hourly heating control loop |
| Cloudflare Access | Login gate on `/admin*` and `/api/admin*` (email one-time PIN or Google, allow-list of owner emails) |

### Routing

```
/                    public home (static)
/<other public>      optional extra public pages (static)
/admin               admin dashboard: one tile per panel   [Access]
/admin/heating       heating panel                         [Access]
/api/admin/...       admin JSON API                        [Access]
```

### Security requirements

- **Custom domain is required.** Cloudflare Access protects paths only on a domain proxied by Cloudflare.
- **Disable the `workers.dev` route** (`workers_dev = false`) so nobody can reach the Worker around Access.
- **Verify the Access JWT in the Worker** on every `/admin*` and `/api/admin*` request (`Cf-Access-Jwt-Assertion` header, checked against the team's JWKS and the application AUD, for example with `jose`). Return 403 if it is missing or invalid. This is defence in depth in case an Access rule is misconfigured.
- **Store secrets as Worker secrets**, never in the repo. Tokens live in D1.
- **Expose nothing about occupancy publicly**: no temperatures, heating state or "last visit".

### Panel module pattern

Each admin panel is a self-contained module so new panels can be added without touching existing ones:

```
src/
  index.ts              router plus scheduled() dispatcher
  auth/access.ts        Access JWT verification
  panels/
    registry.ts         list of panels: { id, title, routes, cron?, migrations }
    heating/
      routes.ts         /api/admin/heating/*
      cron.ts           hourly control loop
      tado.ts           tado° API client (auth plus calls)
      schema.sql        heating_* tables
public/
  index.html            public site
  admin/                shared layout, dashboard, heating page
```

- Each module owns its routes, its tables (named with the panel's prefix, e.g. `heating_`), and optionally a cron handler.
- `scheduled()` calls each registered panel's cron handler, and one panel's error must not stop the others.
- Admin pages share one layout and nav, generated from the registry.

## 5. Heating panel

### Control loop (hourly)

1. Load settings and the current refresh token from D1.
2. Refresh the access token and **save the new refresh token immediately**, because tado° rotates them.
3. `GET` the zone state and read inside temperature, humidity and current power/mode.
4. Decide:
   - temp < `on_threshold` and pump OFF → set HEAT at the minimum allowed setpoint (from zone capabilities)
   - temp > `off_threshold` and pump ON → set power OFF
   - otherwise → do nothing
5. Insert a reading row with the timestamp, temperature, humidity, pump state, action taken and any error.
6. **On any failure, change nothing on the pump**, log the error and exit. The electric heaters are the safety net.
7. Skip control if `enabled = false` (a pause switch in the panel).

Defaults: `on_threshold = 8.0`, `off_threshold = 10.0`. Validation: `on_threshold ≥ 5`, `off_threshold − on_threshold ≥ 1`, `off_threshold ≤ 16`.

### Admin UI

- **Status card:** temperature, humidity, pump on/off, time of the last successful check, and a warning banner if the last check failed or the tado° connection needs reconnecting.
- **Settings:** on and off thresholds, plus an enabled/paused toggle. Validate on both client and server.
- **History chart:** temperature and humidity lines, with shaded spans when the pump was on; 7- and 30-day ranges. Use Chart.js loaded from a CDN, or bundled.
- **Connect tado°:** starts the device-code login, shows the verification link and code, polls until approved, then stores the tokens. Also used to reconnect.
- Times are shown in `Europe/Stockholm`.

### D1 schema (initial)

```sql
CREATE TABLE heating_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token TEXT,
  home_id INTEGER,
  zone_id INTEGER,
  updated_at TEXT
);

CREATE TABLE heating_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  on_threshold REAL NOT NULL DEFAULT 8.0,
  off_threshold REAL NOT NULL DEFAULT 10.0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);

CREATE TABLE heating_readings (
  ts TEXT PRIMARY KEY,          -- ISO UTC
  temp_c REAL,
  humidity_pct REAL,
  pump_power TEXT,              -- ON / OFF
  action TEXT,                  -- none / turned_on / turned_off / skipped_paused
  error TEXT
);
```

Prune readings older than about 400 days during the cron run.

## 6. tado° API notes

The API is unofficial and undocumented apart from tado°'s auth guide, so **verify each detail against live responses** before relying on it.

- **Auth:** since March 2025 tado° only supports the **OAuth2 device-code flow**. There is no username/password grant.
  - The guide is "How do I use the REST API" at support.tado.com. Take the `client_id` and exact endpoints from it.
  - Start: POST to `https://login.tado.com/oauth2/device_authorize`, requesting scope `offline_access` so a refresh token is returned. The user opens `verification_uri_complete` and approves.
  - Then poll `https://login.tado.com/oauth2/token` (device-code grant) until approved.
  - Access tokens last about 10 minutes. Refresh tokens **rotate**: each refresh revokes the old one. They are valid for up to 30 days or until used, so always persist the new one before doing anything else.
- **Base URL:** `https://my.tado.com/api/v2`
  - `GET /me` → home id(s)
  - `GET /homes/{home}/zones` → find the zone with `type == "AIR_CONDITIONING"`
  - `GET /homes/{home}/zones/{zone}/capabilities` → allowed HEAT temperature range (use the minimum)
  - `GET /homes/{home}/zones/{zone}/state` → `sensorDataPoints.insideTemperature.celsius`, `sensorDataPoints.humidity.percentage`, `setting.power`, `setting.mode`
  - `PUT /homes/{home}/zones/{zone}/overlay` → set ON/OFF. Expected body shape (verify):
    ```json
    { "setting": { "type": "AIR_CONDITIONING", "power": "ON", "mode": "HEAT",
                   "temperature": { "celsius": 18 } },
      "termination": { "typeSkillBasedApp": "MANUAL" } }
    ```
    For OFF: `"setting": { "type": "AIR_CONDITIONING", "power": "OFF" }`.
- **Rate limits:** tado° caps daily API calls, at 20,000/day with a subscription and a much lower limit (reportedly about 100/day) without one. Hourly control uses about 25–50 calls/day. Handle HTTP 429 by honouring `Retry-After` and skipping the run.
- **IDs:** cache `home_id` and `zone_id` in D1 after the first lookup to save calls.

## 7. Public site

- One simple, fast, mobile-friendly static page: house name, short description, a few photos, rough location (area, not the exact address unless the owner wants it), and optionally a contact line.
- Content is edited in the repo and redeployed.
- Optimise and resize photos before committing them.

## 8. Deployment and setup

1. Use the domain in Cloudflare (buy one if needed, about €10/year).
2. `wrangler d1 create torp-db`, then apply the migrations.
3. `wrangler.toml`: D1 binding, static assets, cron `0 * * * *`, custom domain route, `workers_dev = false`.
4. Secrets: Access team domain and AUD (for JWT verification).
5. Cloudflare Zero Trust (free plan): create an Access application for `<domain>/admin*` and `<domain>/api/admin*`, with a policy allowing only the owner's email(s).
6. Deploy. Open `/admin/heating` → Connect tado° → set thresholds.
7. Physically confirm the electric heaters are set to about 5°C as backup.

## 9. Acceptance criteria

- The public page loads without login; anything under `/admin` or `/api/admin` returns 403 without a valid Access JWT.
- The `workers.dev` URL is unreachable.
- The cron runs hourly and writes a reading row every hour, including on errors.
- With a forced reading below the on threshold, the pump turns on; above the off threshold, it turns off; between them, nothing changes.
- A rotated refresh token is persisted, and restarting or redeploying the Worker does not lose the tado° connection.
- A revoked token shows "Reconnect tado°" in the panel, and the pump is left untouched.
- The history chart shows 7 and 30 days correctly in Stockholm time.

## 10. Open decisions (confirm first)

- [ ] Domain name to use (existing or new)
- [ ] Public page content: text, photos, how precise the location should be, contact info
- [ ] Heat pump brand/model (affects the allowed setpoints in capabilities)
- [ ] Whether there is a tado° subscription (affects the rate-limit margin)
- [ ] Thresholds: keep the defaults of 8 / 10°C?
- [ ] Admin login: email one-time PIN, Google, or both; which email addresses are allowed
