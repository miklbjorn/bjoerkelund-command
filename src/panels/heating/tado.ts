// tado° API client. Unofficial API: shapes verified against the live house in Phase 0
// (see specs/implementation-plan.md, "Validation results").

const CLIENT_ID = "1bb50063-6b0c-4d11-bd99-387f4a91cc46"; // public client id from tado° support
const AUTH = "https://login.tado.com/oauth2";
const API = "https://my.tado.com/api/v2";

export class TadoError extends Error {
  constructor(
    message: string,
    readonly kind: "needs_reconnect" | "rate_limited" | "api" = "api",
  ) {
    super(message);
  }
}

type AuthRow = {
  status: string;
  refresh_token: string | null;
  access_token: string | null;
  access_expires_at: number | null;
  device_code: string | null;
  device_expires_at: number | null;
  home_id: number | null;
  zone_id: number | null;
  heat_capabilities: string | null;
};

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number };

export type HeatCapability = {
  temperatures?: { celsius?: { min: number; max: number; step: number } };
  fanLevel?: string[];
  verticalSwing?: string[];
  horizontalSwing?: string[];
  light?: string[];
};

export type ZoneState = {
  temp_c: number | null;
  humidity_pct: number | null;
  power: "ON" | "OFF";
  manual: boolean;
  online: boolean;
};

const now = () => new Date().toISOString();

async function form(path: string, params: Record<string, string>) {
  const res = await fetch(`${AUTH}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

export const loadAuth = (db: D1Database) => db.prepare("SELECT * FROM heating_auth WHERE id = 1").first<AuthRow>();

async function storeTokens(db: D1Database, t: TokenResponse, previousRefresh: string | null) {
  // Guarded on the token we used, so a concurrent refresh can't be overwritten by a stale one.
  const sql =
    "UPDATE heating_auth SET status = 'connected', refresh_token = ?1, access_token = ?2, access_expires_at = ?3, updated_at = ?4 WHERE id = 1" +
    (previousRefresh === null ? "" : " AND refresh_token = ?5");
  const args: unknown[] = [t.refresh_token, t.access_token, Date.now() + t.expires_in * 1000, now()];
  if (previousRefresh !== null) args.push(previousRefresh);
  await db.prepare(sql).bind(...args).run();
}

// ---- Device-code login (Connect / Reconnect in the panel) ----

export async function startDeviceLogin(db: D1Database) {
  const r = await form("device_authorize", { scope: "offline_access" });
  if (r.status !== 200) throw new TadoError(`device_authorize failed (${r.status})`);
  const b = r.body as { device_code: string; user_code: string; verification_uri_complete: string; expires_in: number; interval?: number };
  await db
    .prepare("UPDATE heating_auth SET device_code = ?1, device_expires_at = ?2, updated_at = ?3 WHERE id = 1")
    .bind(b.device_code, Date.now() + b.expires_in * 1000, now())
    .run();
  return { url: b.verification_uri_complete, user_code: b.user_code, expires_in: b.expires_in, interval: b.interval ?? 5 };
}

export async function pollDeviceLogin(db: D1Database): Promise<"pending" | "approved" | "expired"> {
  const auth = await loadAuth(db);
  if (!auth?.device_code || !auth.device_expires_at || auth.device_expires_at < Date.now()) return "expired";
  const r = await form("token", {
    device_code: auth.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (r.status === 200) {
    await storeTokens(db, r.body as unknown as TokenResponse, null);
    await db.prepare("UPDATE heating_auth SET device_code = NULL, device_expires_at = NULL WHERE id = 1").run();
    await discoverZone(db); // ids and capabilities, cached for the cron
    return "approved";
  }
  const err = r.body.error;
  if (err === "authorization_pending" || err === "slow_down") return "pending";
  if (err === "expired_token") return "expired";
  throw new TadoError(`device login failed: ${String(err ?? r.status)}`);
}

// ---- Tokens ----

async function accessToken(db: D1Database): Promise<string> {
  const auth = await loadAuth(db);
  if (!auth?.refresh_token) throw new TadoError("tado° is not connected", "needs_reconnect");
  if (auth.access_token && (auth.access_expires_at ?? 0) > Date.now() + 60_000) return auth.access_token;

  const r = await form("token", { grant_type: "refresh_token", refresh_token: auth.refresh_token });
  if (r.status === 200) {
    const t = r.body as unknown as TokenResponse;
    await storeTokens(db, t, auth.refresh_token); // persist the rotated token before anything else
    return t.access_token;
  }
  if (r.body.error === "invalid_grant") {
    // Someone else (cron vs. "check now") may have refreshed in the meantime: use their token.
    const fresh = await loadAuth(db);
    if (fresh?.refresh_token && fresh.refresh_token !== auth.refresh_token && fresh.access_token) return fresh.access_token;
    await db.prepare("UPDATE heating_auth SET status = 'needs_reconnect', updated_at = ?1 WHERE id = 1").bind(now()).run();
    throw new TadoError("tado° login expired or was revoked", "needs_reconnect");
  }
  throw new TadoError(`token refresh failed (${r.status})`);
}

// ---- API calls ----

export type CallInfo = { ratelimitRemaining: number | null };

async function api<T>(db: D1Database, info: CallInfo, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken(db)}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // e.g. ratelimit: "perday";r=999
  const remaining = res.headers.get("ratelimit")?.match(/;r=(\d+)/)?.[1];
  if (remaining !== undefined) info.ratelimitRemaining = Number(remaining);
  if (res.status === 429) throw new TadoError(`rate limited (retry after ${res.headers.get("retry-after") ?? "?"} s)`, "rate_limited");
  if (res.status === 401) throw new TadoError("tado° rejected the access token", "needs_reconnect");
  if (!res.ok) throw new TadoError(`${method} ${path} failed (${res.status})`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function discoverZone(db: D1Database) {
  const info: CallInfo = { ratelimitRemaining: null };
  const me = await api<{ homes?: { id: number }[] }>(db, info, "GET", "/me");
  const homeId = me.homes?.[0]?.id;
  if (!homeId) throw new TadoError("no home on this tado° account");
  const zones = await api<{ id: number; type: string }[]>(db, info, "GET", `/homes/${homeId}/zones`);
  const ac = zones.filter((z) => z.type === "AIR_CONDITIONING");
  if (ac.length !== 1) throw new TadoError(`expected one AIR_CONDITIONING zone, found ${ac.length}`);
  const caps = await api<{ HEAT?: HeatCapability }>(db, info, "GET", `/homes/${homeId}/zones/${ac[0].id}/capabilities`);
  if (!caps.HEAT?.temperatures?.celsius) throw new TadoError("zone has no HEAT mode");
  await db
    .prepare("UPDATE heating_auth SET home_id = ?1, zone_id = ?2, heat_capabilities = ?3, updated_at = ?4 WHERE id = 1")
    .bind(homeId, ac[0].id, JSON.stringify(caps.HEAT), now())
    .run();
}

async function zone(db: D1Database) {
  let auth = await loadAuth(db);
  if (!auth?.home_id || !auth.zone_id || !auth.heat_capabilities) {
    await discoverZone(db);
    auth = await loadAuth(db);
  }
  return { homeId: auth!.home_id!, zoneId: auth!.zone_id!, heat: JSON.parse(auth!.heat_capabilities!) as HeatCapability };
}

export async function getZoneState(db: D1Database, info: CallInfo): Promise<ZoneState> {
  const { homeId, zoneId } = await zone(db);
  const s = await api<{
    setting?: { power?: string };
    overlayType?: string | null;
    sensorDataPoints?: { insideTemperature?: { celsius?: number }; humidity?: { percentage?: number } };
    link?: { state?: string };
  }>(db, info, "GET", `/homes/${homeId}/zones/${zoneId}/state`);
  return {
    temp_c: s.sensorDataPoints?.insideTemperature?.celsius ?? null,
    humidity_pct: s.sensorDataPoints?.humidity?.percentage ?? null,
    power: s.setting?.power === "ON" ? "ON" : "OFF",
    manual: s.overlayType === "MANUAL",
    online: s.link?.state === "ONLINE",
  };
}

// Always a MANUAL overlay with no expiry, so the tado° schedule never takes over between checks.
export async function setPower(db: D1Database, info: CallInfo, power: "ON" | "OFF") {
  const { homeId, zoneId, heat } = await zone(db);
  const pick = (options: string[] | undefined, preferred: string) => (options?.includes(preferred) ? preferred : undefined);
  const setting =
    power === "ON"
      ? {
          type: "AIR_CONDITIONING",
          power: "ON",
          mode: "HEAT",
          temperature: { celsius: heat.temperatures!.celsius!.min },
          // tado° fills in defaults otherwise, including the unit's light ON.
          fanLevel: pick(heat.fanLevel, "AUTO"),
          verticalSwing: pick(heat.verticalSwing, "OFF"),
          horizontalSwing: pick(heat.horizontalSwing, "OFF"),
          light: pick(heat.light, "OFF"),
        }
      : { type: "AIR_CONDITIONING", power: "OFF" };
  await api(db, info, "PUT", `/homes/${homeId}/zones/${zoneId}/overlay`, {
    setting,
    termination: { typeSkillBasedApp: "MANUAL" },
  });
}
