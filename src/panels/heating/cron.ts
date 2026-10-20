import type { Env } from "../../index";
import { decide, type Settings } from "./control";
import { getZoneState, setPower, TadoError, type CallInfo } from "./tado";

const RETENTION_DAYS = 400;

export type Reading = {
  ts: string;
  source: "cron" | "manual";
  temp_c: number | null;
  humidity_pct: number | null;
  pump_power: "ON" | "OFF" | null;
  action: "none" | "turned_on" | "turned_off" | "paused" | "error";
  error: string | null;
  ratelimit_remaining: number | null;
};

export async function loadSettings(db: D1Database): Promise<Settings> {
  const row = await db.prepare("SELECT target_c, band_c, enabled FROM heating_settings WHERE id = 1").first<{
    target_c: number;
    band_c: number;
    enabled: number;
  }>();
  return { target_c: row!.target_c, band_c: row!.band_c, enabled: row!.enabled === 1 };
}

// One check: read the zone, decide, act, log. On any failure, change nothing on the pump:
// the electric heaters at ~5 °C are the safety net.
export async function runCheck(env: Env, source: Reading["source"]): Promise<Reading> {
  const info: CallInfo = { ratelimitRemaining: null };
  const reading: Reading = {
    ts: new Date().toISOString(),
    source,
    temp_c: null,
    humidity_pct: null,
    pump_power: null,
    action: "error",
    error: null,
    ratelimit_remaining: null,
  };

  try {
    const settings = await loadSettings(env.DB);
    const state = await getZoneState(env.DB, info);
    reading.temp_c = state.temp_c;
    reading.humidity_pct = state.humidity_pct;
    reading.pump_power = state.power;

    if (!state.online) throw new TadoError("tado° device is offline");
    if (state.temp_c === null) throw new TadoError("no temperature reading");

    if (!settings.enabled) {
      reading.action = "paused";
    } else {
      const decision = decide({ temp_c: state.temp_c, power: state.power, manual: state.manual }, settings);
      if (decision === "none") {
        reading.action = "none";
      } else {
        const power = decision === "turn_on" ? "ON" : "OFF";
        await setPower(env.DB, info, power);
        reading.pump_power = power;
        reading.action = power === "ON" ? "turned_on" : "turned_off";
      }
    }
  } catch (err) {
    reading.action = "error";
    reading.error = err instanceof Error ? err.message : String(err);
    console.error("heating check failed", reading.error);
  }

  reading.ratelimit_remaining = info.ratelimitRemaining;
  await env.DB.prepare(
    "INSERT INTO heating_readings (ts, source, temp_c, humidity_pct, pump_power, action, error, ratelimit_remaining) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(reading.ts, reading.source, reading.temp_c, reading.humidity_pct, reading.pump_power, reading.action, reading.error, reading.ratelimit_remaining)
    .run();
  return reading;
}

export async function heatingCron(env: Env) {
  await runCheck(env, "cron");
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare("DELETE FROM heating_readings WHERE ts < ?1").bind(cutoff).run();
}
