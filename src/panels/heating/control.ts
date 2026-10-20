// Pure control logic for the heating panel, kept free of I/O so it can be unit tested.

export type Settings = { target_c: number; band_c: number; enabled: boolean };

export const LIMITS = {
  minOn: 5, // never let the "on" threshold drop below this (the electric heaters are the backstop at ~5°C)
  maxOff: 16, // the pump's lowest HEAT setpoint is 17°C, so "off" must be below that
  minBand: 0.5,
  maxBand: 3,
};

export const thresholds = (s: Pick<Settings, "target_c" | "band_c">) => ({
  on: s.target_c - s.band_c,
  off: s.target_c + s.band_c,
});

export function validateSettings(input: unknown): { ok: true; value: Settings } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Expected an object" };
  const { target_c, band_c, enabled } = input as Record<string, unknown>;
  if (typeof target_c !== "number" || !Number.isFinite(target_c)) return { ok: false, error: "target_c must be a number" };
  if (typeof band_c !== "number" || !Number.isFinite(band_c)) return { ok: false, error: "band_c must be a number" };
  if (typeof enabled !== "boolean") return { ok: false, error: "enabled must be true or false" };
  if (band_c < LIMITS.minBand || band_c > LIMITS.maxBand) {
    return { ok: false, error: `Band must be between ±${LIMITS.minBand} and ±${LIMITS.maxBand} °C` };
  }
  const t = thresholds({ target_c, band_c });
  if (t.on < LIMITS.minOn) return { ok: false, error: `Pump would only start below ${t.on} °C; the minimum is ${LIMITS.minOn} °C` };
  if (t.off > LIMITS.maxOff) return { ok: false, error: `Pump would only stop above ${t.off} °C; the maximum is ${LIMITS.maxOff} °C` };
  // Round to 0.1 °C so the stored values are what the UI shows.
  const r = (n: number) => Math.round(n * 10) / 10;
  return { ok: true, value: { target_c: r(target_c), band_c: r(band_c), enabled } };
}

export type ZoneReading = {
  temp_c: number;
  power: "ON" | "OFF";
  manual: boolean; // a MANUAL overlay is in place (otherwise the tado° schedule is in charge)
};

export type Decision = "none" | "turn_on" | "turn_off";

// Hysteresis around the target. Between the thresholds we keep whatever the pump is doing, but only
// if we are the ones in control (MANUAL overlay). If the tado° schedule has taken over, we take control
// back, picking the side of the target we are on.
export function decide(z: ZoneReading, s: Settings): Decision {
  const { on, off } = thresholds(s);
  let want: "ON" | "OFF";
  if (z.temp_c < on) want = "ON";
  else if (z.temp_c > off) want = "OFF";
  else if (z.manual) want = z.power;
  else want = z.temp_c < s.target_c ? "ON" : "OFF";

  if (want === z.power && z.manual) return "none";
  return want === "ON" ? "turn_on" : "turn_off";
}
