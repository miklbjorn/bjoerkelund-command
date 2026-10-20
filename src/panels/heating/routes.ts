import type { Env } from "../../index";
import type { AdminIdentity } from "../../auth/access";
import type { PanelSummary } from "../registry";
import { html, json, readJson } from "../../http";
import { LIMITS, thresholds, validateSettings } from "./control";
import { loadSettings, runCheck, type Reading } from "./cron";
import { loadAuth, pollDeviceLogin, startDeviceLogin, TadoError } from "./tado";
import page from "./page.html";

const STALE_MS = 2 * 60 * 60 * 1000; // no successful check for 2 h → warn
const MANUAL_CHECK_MIN_GAP_MS = 60_000; // protects the tado° daily quota

const READING_COLUMNS = "ts, source, temp_c, humidity_pct, pump_power, action, error, ratelimit_remaining";

export async function heatingRoutes(request: Request, env: Env, url: URL, admin: AdminIdentity): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/admin/heating") return html(page);
  if (!pathname.startsWith("/api/admin/heating/")) return null;
  const route = `${method} ${pathname.slice("/api/admin/heating".length)}`;

  try {
    switch (route) {
      case "GET /status":
        return json(await status(env));

      case "PUT /settings": {
        const parsed = validateSettings(await readJson(request));
        if (!parsed.ok) return json({ error: parsed.error }, 400);
        const s = parsed.value;
        await env.DB.prepare(
          "UPDATE heating_settings SET target_c = ?1, band_c = ?2, enabled = ?3, updated_at = ?4, updated_by = ?5 WHERE id = 1",
        )
          .bind(s.target_c, s.band_c, s.enabled ? 1 : 0, new Date().toISOString(), admin.email)
          .run();
        return json(await status(env));
      }

      case "GET /readings": {
        const days = Number(url.searchParams.get("days"));
        if (![1, 7, 30].includes(days)) return json({ error: "days must be 1, 7 or 30" }, 400);
        const since = new Date(Date.now() - days * 86_400_000).toISOString();
        const { results } = await env.DB.prepare(`SELECT ${READING_COLUMNS} FROM heating_readings WHERE ts >= ?1 ORDER BY ts`)
          .bind(since)
          .all();
        return json({ readings: results });
      }

      case "POST /check": {
        const last = await env.DB.prepare("SELECT ts FROM heating_readings ORDER BY ts DESC LIMIT 1").first<{ ts: string }>();
        if (last && Date.now() - Date.parse(last.ts) < MANUAL_CHECK_MIN_GAP_MS) {
          return json({ error: "Checked less than a minute ago; try again shortly" }, 429);
        }
        await runCheck(env, "manual");
        return json(await status(env));
      }

      case "POST /connect/start":
        return json(await startDeviceLogin(env.DB));

      case "POST /connect/poll": {
        const result = await pollDeviceLogin(env.DB);
        return json({ result, ...(result === "approved" ? { status: await status(env) } : {}) });
      }
    }
  } catch (err) {
    const message = err instanceof TadoError ? err.message : "Internal error";
    if (!(err instanceof TadoError)) console.error("heating route failed", err);
    return json({ error: message }, 502);
  }
  return json({ error: "not_found" }, 404);
}

const fmt = (n: number | null | undefined, unit: string, digits = 1) => (n == null ? "–" : `${n.toFixed(digits)} ${unit}`);

// Dashboard tile: green only when connected, enabled, and the last check succeeded recently.
export async function heatingSummary(env: Env): Promise<PanelSummary> {
  const s = await status(env);
  const ok = s.last_ok;
  let problem: string | null = null;
  if (s.connection.status === "needs_reconnect") problem = "tado° needs reconnecting";
  else if (s.connection.status !== "connected") problem = "tado° not connected";
  else if (s.last?.action === "error") problem = "Last check failed";
  else if (s.stale) problem = "No successful check in 2 h";
  else if (!s.settings.enabled) problem = "Control paused";
  return {
    ok: problem === null,
    label: problem ?? "Running as planned",
    stats: [
      { label: "Temperature", value: fmt(ok?.temp_c, "°C") },
      { label: "Humidity", value: fmt(ok?.humidity_pct, "%", 0) },
      { label: "Target", value: `${s.settings.target_c.toFixed(1)} ± ${s.settings.band_c.toFixed(1)} °C` },
      { label: "Heat pump", value: ok?.pump_power ?? "–" },
    ],
  };
}

async function status(env: Env) {
  const [settings, auth, settingsMeta, last, lastOk] = await Promise.all([
    loadSettings(env.DB),
    loadAuth(env.DB),
    env.DB.prepare("SELECT updated_at, updated_by FROM heating_settings WHERE id = 1").first(),
    env.DB.prepare(`SELECT ${READING_COLUMNS} FROM heating_readings ORDER BY ts DESC LIMIT 1`).first<Reading>(),
    env.DB.prepare(`SELECT ${READING_COLUMNS} FROM heating_readings WHERE action != 'error' ORDER BY ts DESC LIMIT 1`).first<Reading>(),
  ]);
  return {
    settings,
    settings_meta: settingsMeta,
    thresholds: thresholds(settings),
    limits: LIMITS,
    // Never return tokens to the browser: only the connection state.
    connection: {
      status: auth?.status ?? "disconnected",
      login_pending: !!auth?.device_code && (auth.device_expires_at ?? 0) > Date.now(),
    },
    last,
    last_ok: lastOk,
    stale: !lastOk || Date.now() - Date.parse(lastOk.ts) > STALE_MS,
  };
}
