import { describe, expect, it } from "vitest";
import { decide, thresholds, validateSettings } from "./control";

const s = { target_c: 9, band_c: 1, enabled: true }; // on below 8, off above 10

describe("decide", () => {
  it("turns on below the band", () => {
    expect(decide({ temp_c: 7.9, power: "OFF", manual: true }, s)).toBe("turn_on");
  });
  it("turns off above the band", () => {
    expect(decide({ temp_c: 10.1, power: "ON", manual: true }, s)).toBe("turn_off");
  });
  it("does nothing inside the band while in control", () => {
    expect(decide({ temp_c: 9.5, power: "ON", manual: true }, s)).toBe("none");
    expect(decide({ temp_c: 8.5, power: "OFF", manual: true }, s)).toBe("none");
  });
  it("does nothing when already in the wanted state", () => {
    expect(decide({ temp_c: 7, power: "ON", manual: true }, s)).toBe("none");
    expect(decide({ temp_c: 12, power: "OFF", manual: true }, s)).toBe("none");
  });
  it("treats the exact thresholds as inside the band", () => {
    expect(decide({ temp_c: 8, power: "OFF", manual: true }, s)).toBe("none");
    expect(decide({ temp_c: 10, power: "ON", manual: true }, s)).toBe("none");
  });
  it("takes control back from the tado° schedule", () => {
    // Schedule has the pump ON at 18 °C: way above the band.
    expect(decide({ temp_c: 18, power: "ON", manual: false }, s)).toBe("turn_off");
    // Inside the band without an overlay: pick the side of the target.
    expect(decide({ temp_c: 8.5, power: "OFF", manual: false }, s)).toBe("turn_on");
    expect(decide({ temp_c: 9.5, power: "OFF", manual: false }, s)).toBe("turn_off");
  });
});

describe("validateSettings", () => {
  it("accepts the defaults", () => {
    expect(validateSettings(s)).toEqual({ ok: true, value: s });
  });
  it("rounds to 0.1 °C", () => {
    expect(validateSettings({ target_c: 9.04, band_c: 1.26, enabled: false })).toEqual({
      ok: true,
      value: { target_c: 9, band_c: 1.3, enabled: false },
    });
  });
  it("rejects an on-threshold below 5 °C", () => {
    expect(validateSettings({ target_c: 5.5, band_c: 1, enabled: true }).ok).toBe(false);
  });
  it("rejects an off-threshold above 16 °C", () => {
    expect(validateSettings({ target_c: 15.5, band_c: 1, enabled: true }).ok).toBe(false);
  });
  it("rejects bands that are too narrow or too wide", () => {
    expect(validateSettings({ target_c: 9, band_c: 0.2, enabled: true }).ok).toBe(false);
    expect(validateSettings({ target_c: 10, band_c: 4, enabled: true }).ok).toBe(false);
  });
  it("rejects wrong types", () => {
    expect(validateSettings({ target_c: "9", band_c: 1, enabled: true }).ok).toBe(false);
    expect(validateSettings({ target_c: 9, band_c: 1 }).ok).toBe(false);
    expect(validateSettings(null).ok).toBe(false);
    expect(validateSettings({ target_c: NaN, band_c: 1, enabled: true }).ok).toBe(false);
  });
  it("computes thresholds", () => {
    expect(thresholds({ target_c: 9, band_c: 1 })).toEqual({ on: 8, off: 10 });
  });
});
