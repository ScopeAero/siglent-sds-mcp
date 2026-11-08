import { describe, it, expect } from "vitest";
import { estimateCanBaud, snapToStandardRate } from "../../src/analysis/can-baud.js";
import { rng, synthCan } from "../can-synth.js";

const relErr = (got: number, want: number) => Math.abs(got - want) / want;

// ---------------------------------------------------------------------------

describe("estimateCanBaud", () => {
  it("measures a clean 500 kbit/s CAN_H capture", () => {
    const est = estimateCanBaud(
      synthCan({ baud: 500_000, sampleRate: 50e6 }),
      50e6
    );
    expect(relErr(est.baud, 500_000)).toBeLessThan(0.001);
    expect(est.confidence).toBe("high");
    expect(est.recessive).toBe("low");
    expect(est.frames).toBe(10);
  });

  it("reports the true rate of an off-nominal clock rather than the nominal one", () => {
    // 125k node whose oscillator is 1% fast
    const est = estimateCanBaud(
      synthCan({ baud: 126_250, sampleRate: 10e6 }),
      10e6
    );
    expect(relErr(est.baud, 126_250)).toBeLessThan(0.001);
  });

  it("handles CAN_L (recessive high)", () => {
    const est = estimateCanBaud(
      synthCan({ baud: 250_000, sampleRate: 25e6, wire: "CANL" }),
      25e6
    );
    expect(relErr(est.baud, 250_000)).toBeLessThan(0.001);
    expect(est.recessive).toBe("high");
  });

  it("is not biased by a slow passive dominant→recessive edge", () => {
    // Release edge time constant of 15% of a bit shifts falling crossings
    // late; same-polarity intervals should cancel it.
    const est = estimateCanBaud(
      synthCan({ baud: 500_000, sampleRate: 100e6, recessiveTau: 0.15 }),
      100e6
    );
    expect(relErr(est.baud, 500_000)).toBeLessThan(0.002);
  });

  it("copes with noise", () => {
    const est = estimateCanBaud(
      synthCan({ baud: 1_000_000, sampleRate: 50e6, noise: 0.08, frames: 20 }),
      50e6
    );
    expect(relErr(est.baud, 1_000_000)).toBeLessThan(0.003);
    expect(est.confidence).not.toBe("low");
  });

  it("works at 10 samples per bit", () => {
    const est = estimateCanBaud(
      synthCan({ baud: 1_000_000, sampleRate: 10e6, frames: 20 }),
      10e6
    );
    expect(relErr(est.baud, 1_000_000)).toBeLessThan(0.005);
  });

  it("measures slow non-power-of-two rates like 83.333 kbit/s", () => {
    const est = estimateCanBaud(
      synthCan({ baud: 83_333, sampleRate: 5e6 }),
      5e6
    );
    expect(relErr(est.baud, 83_333)).toBeLessThan(0.001);
  });

  it("warns when undersampled", () => {
    const est = estimateCanBaud(
      synthCan({ baud: 1_000_000, sampleRate: 5e6, frames: 20 }),
      5e6
    );
    expect(est.warnings.some((w) => /samples per bit/.test(w))).toBe(true);
    expect(est.confidence).not.toBe("high");
  });

  it("finds the dominant level on a mostly idle bus", () => {
    // Two 1 Mbit/s frames, then ~10 ms of idle: <1% of samples are dominant
    const burst = synthCan({ baud: 1_000_000, sampleRate: 20e6, frames: 2 });
    const s = new Float64Array(burst.length + 200_000).fill(2.5);
    s.set(burst);
    const est = estimateCanBaud(s, 20e6);
    expect(relErr(est.baud, 1_000_000)).toBeLessThan(0.003);
  });

  it("rejects idle-bus noise with no traffic", () => {
    const rand = rng(7);
    const s = Float64Array.from({ length: 50_000 }, () => 2.5 + (rand() - 0.5) * 0.02);
    expect(() => estimateCanBaud(s, 1e6)).toThrow(/flat/);
  });

  it("rejects a flat signal", () => {
    expect(() => estimateCanBaud(new Float64Array(1000).fill(2.5), 1e6)).toThrow(
      /flat/
    );
  });

  it("rejects a capture with too few edges", () => {
    const s = new Float64Array(1000).fill(2.5);
    s.fill(3.5, 400, 410);
    expect(() => estimateCanBaud(s, 1e6)).toThrow(/edges/);
  });
});

describe("snapToStandardRate", () => {
  it("matches the nearest standard rate and reports the error", () => {
    const m = snapToStandardRate(126_250);
    expect(m?.baud).toBe(125_000);
    expect(m?.errorPct).toBeCloseTo(1, 6);
  });

  it("matches slow non-round rates", () => {
    expect(snapToStandardRate(83_400)?.baud).toBe(83_333);
    expect(snapToStandardRate(33_300)?.baud).toBe(33_333);
  });

  it("returns null when nothing is within tolerance", () => {
    expect(snapToStandardRate(115_200)).toBeNull();
    expect(snapToStandardRate(900_000)).toBeNull();
  });

  it("accepts a custom rate list and tolerance", () => {
    expect(snapToStandardRate(666_000, [666_666])?.baud).toBe(666_666);
    expect(snapToStandardRate(130_000, undefined, 5)?.baud).toBe(125_000);
  });
});
