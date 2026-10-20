#!/usr/bin/env node
// tado° API validation spike (Phase 0). No dependencies, needs Node 18+.
//
//   node scripts/tado-validate.mjs login          device-code login, stores refresh token
//   node scripts/tado-validate.mjs probe          read-only: /me, zones, capabilities, state
//   node scripts/tado-validate.mjs rotation       proves refresh tokens rotate (old one dies)
//   node scripts/tado-validate.mjs set on|off     WRITES an overlay to the real heat pump
//   node scripts/tado-validate.mjs resume         removes the overlay (back to tado° schedule)
//
// Tokens and raw responses go to .tado/ (gitignored). Every API call prints the
// remaining daily quota from the `ratelimit` header. Without a subscription the
// limit is 100 calls/day, so don't loop this.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

const CLIENT_ID = "1bb50063-6b0c-4d11-bd99-387f4a91cc46"; // public, from tado° support article
const AUTH = "https://login.tado.com/oauth2";
const API = "https://my.tado.com/api/v2";
const DIR = new URL("../.tado/", import.meta.url);
const TOKEN_FILE = new URL("tokens.json", DIR);
const IDS_FILE = new URL("ids.json", DIR);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function save(name, data) {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  await writeFile(new URL(name, DIR), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

async function load(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function form(url, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function login() {
  const start = await form(`${AUTH}/device_authorize`, { scope: "offline_access" });
  if (start.status !== 200) throw new Error(`device_authorize ${start.status}: ${JSON.stringify(start.body)}`);
  const { device_code, user_code, verification_uri_complete, expires_in, interval = 5 } = start.body;
  console.log(`\nOpen this link and approve (code ${user_code}, expires in ${expires_in}s):\n\n  ${verification_uri_complete}\n`);

  const deadline = Date.now() + expires_in * 1000;
  let wait = interval;
  while (Date.now() < deadline) {
    await sleep(wait * 1000);
    const r = await form(`${AUTH}/token`, {
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (r.status === 200) {
      await storeTokens(r.body);
      console.log(`Approved. access expires_in=${r.body.expires_in}s, refresh_token present=${!!r.body.refresh_token}`);
      return;
    }
    const err = r.body?.error;
    if (err === "slow_down") wait += 5;
    else if (err !== "authorization_pending") throw new Error(`token ${r.status}: ${JSON.stringify(r.body)}`);
    process.stdout.write(".");
  }
  throw new Error("Device code expired before approval");
}

async function storeTokens(body) {
  await save("tokens.json", {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    access_expires_at: Date.now() + body.expires_in * 1000,
    saved_at: new Date().toISOString(),
  });
}

// Mirrors what the Worker cron will do: refresh, then persist the new refresh token before anything else.
async function refresh() {
  const t = await load(TOKEN_FILE);
  if (!t?.refresh_token) throw new Error("No tokens yet, run `login` first");
  const r = await form(`${AUTH}/token`, { grant_type: "refresh_token", refresh_token: t.refresh_token });
  if (r.status !== 200) throw new Error(`refresh ${r.status}: ${JSON.stringify(r.body)} -> run \`login\` again`);
  await storeTokens(r.body);
  return { old: t.refresh_token, ...r.body };
}

async function accessToken() {
  const t = await load(TOKEN_FILE);
  if (t?.access_token && t.access_expires_at > Date.now() + 30_000) return t.access_token;
  return (await refresh()).access_token;
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      ...(body && { "content-type": "application/json" }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`${method} ${path} -> ${res.status}  ratelimit: ${res.headers.get("ratelimit") ?? "(none)"}`);
  if (res.status === 429) console.log(`  retry-after: ${res.headers.get("retry-after")}`);
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function ids() {
  const cached = await load(IDS_FILE);
  if (cached) return cached;
  const me = await api("GET", "/me");
  await save("me.json", me);
  const homeId = me.homes?.[0]?.id;
  if (me.homes?.length > 1) console.log(`Note: ${me.homes.length} homes, using the first (${homeId})`);
  const zones = await api("GET", `/homes/${homeId}/zones`);
  await save("zones.json", zones);
  const ac = zones.filter((z) => z.type === "AIR_CONDITIONING");
  console.log("Zones:", zones.map((z) => `${z.id}:${z.name}(${z.type})`).join(", "));
  if (ac.length !== 1) throw new Error(`Expected exactly 1 AIR_CONDITIONING zone, found ${ac.length}`);
  const result = { homeId, zoneId: ac[0].id };
  await save("ids.json", result);
  return result;
}

function summarise(state) {
  const s = state.sensorDataPoints ?? {};
  return {
    temp_c: s.insideTemperature?.celsius,
    humidity_pct: s.humidity?.percentage,
    power: state.setting?.power,
    mode: state.setting?.mode,
    setpoint_c: state.setting?.temperature?.celsius,
    overlay: state.overlayType ?? null,
    link: state.link?.state,
  };
}

async function probe() {
  const { homeId, zoneId } = await ids();
  const caps = await api("GET", `/homes/${homeId}/zones/${zoneId}/capabilities`);
  await save("capabilities.json", caps);
  const state = await api("GET", `/homes/${homeId}/zones/${zoneId}/state`);
  await save("state.json", state);
  console.log("\nHEAT capability:", JSON.stringify(caps.HEAT ?? "(no HEAT mode!)", null, 2));
  console.log("State:", summarise(state));
  console.log("\nRaw responses saved in .tado/");
}

async function rotation() {
  const r = await refresh();
  console.log(`Refresh OK. New token differs from old: ${r.refresh_token !== r.old}`);
  const reuse = await form(`${AUTH}/token`, { grant_type: "refresh_token", refresh_token: r.old });
  console.log(`Reusing the old refresh token -> ${reuse.status} ${JSON.stringify(reuse.body)}`);
  console.log(reuse.status === 200 ? "WARNING: old token still works (no strict rotation?)" : "Confirmed: old token rejected.");
  // Make sure the stored token is still alive after the reuse attempt (some servers revoke the whole chain).
  await refresh();
  console.log("Stored (newest) refresh token still valid.");
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} Type "yes": `);
  rl.close();
  if (answer.trim() !== "yes") process.exit(1);
}

async function set(power) {
  if (!["on", "off"].includes(power)) throw new Error("usage: set on|off");
  const { homeId, zoneId } = await ids();
  const caps = (await load(new URL("capabilities.json", DIR))) ?? (await api("GET", `/homes/${homeId}/zones/${zoneId}/capabilities`));
  const minC = caps.HEAT?.temperatures?.celsius?.min;
  const setting =
    power === "on"
      ? { type: "AIR_CONDITIONING", power: "ON", mode: "HEAT", temperature: { celsius: minC } }
      : { type: "AIR_CONDITIONING", power: "OFF" };
  // Some AC models require fanLevel/swing etc. in the setting; if the PUT is rejected, check capabilities.json.
  const body = { setting, termination: { typeSkillBasedApp: "MANUAL" } };
  console.log("Overlay body:", JSON.stringify(body));
  await confirm(`This will turn the real heat pump ${power.toUpperCase()}.`);
  const res = await api("PUT", `/homes/${homeId}/zones/${zoneId}/overlay`, body);
  await save(`overlay-${power}.json`, res);
  console.log("Response:", JSON.stringify(res, null, 2));
}

async function resume() {
  const { homeId, zoneId } = await ids();
  await api("DELETE", `/homes/${homeId}/zones/${zoneId}/overlay`);
  console.log("Overlay removed; zone follows its tado° schedule again.");
}

const [cmd, arg] = process.argv.slice(2);
const commands = { login, probe, rotation, set: () => set(arg), resume };
if (!commands[cmd]) {
  console.log("usage: node scripts/tado-validate.mjs login|probe|rotation|set on|off|resume");
  process.exit(1);
}
commands[cmd]().catch((e) => {
  console.error("\nERROR:", e.message);
  process.exit(1);
});
