# Implementation plan

Build order for `torp-site-plan.md`, with these decisions applied (2026-10-20):

1. **Admin login uses a Google account.** Cloudflare Access with Google as the identity provider and an allow-list of specific Gmail addresses. The Worker still verifies the Access JWT itself. No email PIN.
2. **The public page is a text-only placeholder.** Photos come later.
3. **tado° comes first.** Prove the API does what the control loop needs before building anything around it.

---

## Phase 0: validate tado° (do this first)

The rest of the design depends on unofficial API behaviour, so we prove each assumption against the real house with `scripts/tado-validate.mjs` (Node, no dependencies; tokens go to `.tado/`, which is gitignored).

| # | Assumption to prove | How | Pass criteria |
|---|---|---|---|
| 0.1 | Device-code login works with the public client id and returns a refresh token | `login` | `refresh_token` present |
| 0.2 | We can find the home and exactly one `AIR_CONDITIONING` zone | `probe` | ids saved to `.tado/ids.json` |
| 0.3 | Capabilities expose a HEAT mode and its minimum setpoint | `probe` → `.tado/capabilities.json` | `HEAT.temperatures.celsius.min` exists (expect 16–18) |
| 0.4 | State gives temperature, humidity, power and mode at the paths we expect | `probe` → `.tado/state.json` | All four fields are non-null |
| 0.5 | Refresh tokens rotate, and only the newest one works | `rotation` | Old token rejected, newest still valid |
| 0.6 | The `ratelimit` header is present, and we know our daily budget | Any command (prints the header) | We know whether we're on 100/day or 20,000/day |
| 0.7 | Overlay HEAT at the minimum setpoint actually starts the pump | `set on`, then check the tado° app and the unit | Pump runs, and `state.setting` reflects it |
| 0.8 | Overlay OFF turns it off; `resume` hands control back to the schedule | `set off`, `resume` | As expected |
| 0.9 | A MANUAL overlay persists (tado° doesn't revert it, and nothing like Open Window or geofencing overrides it) | `probe` again a few hours after 0.7 | Overlay still in place |

Run order: `login` → `probe` → `rotation` → (with the pump in mind) `set on` → `probe` → `set off` → `resume`. That's about 15 API calls, well under even the 100/day limit.

**Rate-limit finding (from tado° support):** standard accounts get **100 requests/day**, and Auto-Assist/AI Assist subscribers get 20,000. The hourly loop uses about 24–30 calls, so it fits without a subscription. Two rules follow:
- The admin UI must **never call tado° live** to display status. It reads the last row from D1. Only "Connect" and an explicit "check now" button touch tado°.
- Log the remaining quota (from `ratelimit`) with every reading so we can see the headroom.

**Refresh-token risk:** refresh tokens expire after 30 days unused and rotate on every use. If a cron run crashes after refreshing but before saving, the connection is lost. The cron must write the new token to D1 *before* any other call. If the cron is broken for a month, we have to reconnect.

Results go in a short "Validation results" section at the bottom of this file, and corrections go back into section 6 of `torp-site-plan.md`.

## Phase 1: skeleton and deploy

- `npm create cloudflare` → TypeScript Worker, `wrangler.toml` with static assets, D1 binding, `workers_dev = false`, cron `0 * * * *` (handler is a no-op for now).
- `src/index.ts` router, `src/panels/registry.ts`, an empty `/admin` dashboard.
- `public/index.html`: placeholder with house name, two or three sentences, area ("near Värnamo, Småland"), and no images.
- Domain into Cloudflare, attach as custom domain, deploy.

## Phase 2: Google-gated admin

- Google Cloud Console: create an OAuth client (Web) and add redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`.
- Zero Trust (free): add Google as the login method, then create an Access application for `<domain>/admin*` and `<domain>/api/admin*` with an **Allow** policy of `Emails: <owner gmail(s)>`. Disable other login methods so the PIN option isn't shown.
- `src/auth/access.ts`: verify `Cf-Access-Jwt-Assertion` with `jose` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and the app AUD. Also check the `email` claim against an `ADMIN_EMAILS` secret (second line of defence). Missing or invalid gives 403.
- Check: incognito → `/admin` → Google login → allowed; a different Google account → denied; `curl /api/admin/...` directly → 403.

## Phase 3: heating panel (backend)

- D1 migrations from the spec. Add `ratelimit_remaining INTEGER` to `heating_readings`.
- `tado.ts`: port the validated calls from the spike.
- `routes.ts`: device-code connect (start + poll), get/set settings, readings (range), status from D1.
- `cron.ts`: the control loop in spec section 5, including the pause switch, the "change nothing on error" rule, 429 handling and pruning.
- Testing: unit-test the decision function (below / between / above thresholds, paused, error), and run `wrangler dev --test-scheduled` against the real zone.

## Phase 4: heating panel (UI)

Status card (from D1), settings form with validation, a Connect/Reconnect tado° flow, and a Chart.js history in Europe/Stockholm with 7/30-day ranges.

## Phase 5: go-live

Run the acceptance criteria in spec section 9, set the electric heaters to about 5°C, and watch a week of readings before leaving the house unattended.

---

## Decided

- **Domain:** `bjoerkelund.mikkelbjoern.com`. `mikkelbjoern.com` must be added to Cloudflare first, with its nameservers moved to Cloudflare at the registrar. Cloudflare Access only works on a proxied zone.
- **Admin accounts:** two Google accounts. They are kept out of the repo, in the Access policy and the `ADMIN_EMAILS` Worker secret.
- **Placeholder page:** `public/index.html`. It hotlinks the Visit Sweden hero image for now; replace it with our own photo before launch.

## Where login is configured

| Where | What |
|---|---|
| Google Cloud Console (APIs & Services → Credentials) | One OAuth client (Web), redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. This only lets Cloudflare use "Sign in with Google". **No emails are configured here.** OAuth consent screen: External, and either publish it or add both emails as test users. |
| Cloudflare Zero Trust → Settings → Authentication | Add Google as the login method (paste the client id and secret). Remove One-time PIN. |
| Cloudflare Zero Trust → Access → Applications | App for `bjoerkelund.mikkelbjoern.com/admin*` and `/api/admin*`, policy **Allow → Emails →** the two addresses. **This is the allow-list.** |
| Worker secret `ADMIN_EMAILS` | The same two emails, checked again in `src/auth/access.ts`. Set with `wrangler secret put ADMIN_EMAILS`; for local dev, put it in `.dev.vars`. |

## Still open

- [ ] Heat pump brand/model. Phase 0.3 will show the setpoint range anyway.
- [ ] tado° subscription? Phase 0.6 answers this.

## Validation results

Run 2026-10-20 (ids are in `.tado/ids.json`, which is gitignored):

| # | Result |
|---|---|
| 0.1 | ✅ Device-code login works. **Access token `expires_in` = 599 s (10 min)**, and a refresh token is returned. |
| 0.2 | ✅ One home, one AC zone (type `AIR_CONDITIONING`). |
| 0.3 | ✅ HEAT range **17–30 °C, step 1** → "on" setpoint = **17 °C**. HEAT also lists `fanLevel` (LEVEL1–3, AUTO), `verticalSwing`, `horizontalSwing` and `light`; the ON overlay may need some of these (see 0.7). |
| 0.4 | ✅ `sensorDataPoints.insideTemperature.celsius` = 9.85, `humidity.percentage` = 58.9, `setting.power` = OFF (no `mode` while OFF), `link.state` = ONLINE. Home `tadoMode` = AWAY, no overlay. |
| 0.5 | ✅ Rotation confirmed: old refresh token → `400 invalid_grant / refresh_token_not_found`, newest token still valid. |
| 0.6 | ✅ `ratelimit: "perday";r=999` after the first call → **daily limit is 1,000** (not the documented 100/20,000). The refresh call to login.tado.com did not count. |
| 0.7 | ✅ `PUT overlay` with only `power/mode/temperature` is accepted. tado° fills in defaults: `fanLevel: LEVEL2`, swings OFF, **`light: ON`**. Confirmed in the tado° app. The Worker should send `fanLevel` and `light: "OFF"` explicitly. |
| 0.8 | ✅ OFF overlay works and is held as `MANUAL` with `projectedExpiry: null` (no auto-expiry). `DELETE overlay` returns to the schedule. **The cron should always leave a MANUAL overlay (ON or OFF) and never resume the schedule**, so the tado° schedule can't take over. |
| 0.9 | ⏳ In progress: pump left ON (MANUAL, HEAT 17 °C) on 2026-10-20 ~14:00. Run `probe` after a few hours and check `overlayType` is still `MANUAL` and `power` is still `ON` despite home `tadoMode: AWAY`. |
