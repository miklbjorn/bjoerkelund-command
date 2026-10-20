-- Heating panel: tado° connection, settings and hourly readings.

CREATE TABLE heating_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'disconnected',  -- disconnected / connected / needs_reconnect
  refresh_token TEXT,                           -- rotates on every use; persist before anything else
  access_token TEXT,
  access_expires_at INTEGER,                    -- epoch ms
  device_code TEXT,                             -- pending device-code login
  device_expires_at INTEGER,
  home_id INTEGER,
  zone_id INTEGER,
  heat_capabilities TEXT,                       -- JSON of the zone's HEAT capability
  updated_at TEXT
);
INSERT INTO heating_auth (id) VALUES (1);

CREATE TABLE heating_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_c REAL NOT NULL DEFAULT 9.0,
  band_c REAL NOT NULL DEFAULT 1.0,             -- pump on below target - band, off above target + band
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO heating_settings (id) VALUES (1);

CREATE TABLE heating_readings (
  ts TEXT PRIMARY KEY,                          -- ISO UTC
  source TEXT NOT NULL,                         -- cron / manual
  temp_c REAL,
  humidity_pct REAL,
  pump_power TEXT,                              -- ON / OFF after this check
  action TEXT NOT NULL,                         -- none / turned_on / turned_off / paused / error
  error TEXT,
  ratelimit_remaining INTEGER
);
