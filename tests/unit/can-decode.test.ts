import { describe, it, expect } from "vitest";
import { extractEdges, estimateCanBaud } from "../../src/analysis/can-baud.js";
import { decodeCanFrames } from "../../src/analysis/can-decode.js";
import { synthCanFrames, type SynthOptions } from "../can-synth.js";

function decode(opts: SynthOptions, baud = opts.baud) {
  const synth = synthCanFrames(opts);
  const edges = extractEdges(synth.samples, opts.sampleRate);
  return { synth, frames: decodeCanFrames(edges, 1 / baud) };
}

describe("decodeCanFrames", () => {
  it("decodes standard frames exactly", () => {
    const { synth, frames } = decode({ baud: 500_000, sampleRate: 25e6, frames: 20 });
    expect(frames).toHaveLength(20);
    frames.forEach((f, i) => {
      const want = synth.frames[i];
      expect(f.error).toBeUndefined();
      expect(f.id).toBe(want.id);
      expect(f.extended).toBe(false);
      expect(f.data).toEqual(want.data);
      expect(f.dlc).toBe(want.data.length);
      expect(f.crcOk).toBe(true);
      expect(f.acked).toBe(true);
      expect(f.time).toBeCloseTo(synth.sofTimes[i], 6);
    });
  });

  it("decodes extended (29-bit) frames", () => {
    const { synth, frames } = decode({
      baud: 250_000,
      sampleRate: 10e6,
      frames: 20,
      extendedRatio: 0.5,
      seed: 3,
    });
    expect(synth.frames.some((f) => f.extended)).toBe(true);
    expect(frames.map((f) => [f.id, f.extended, f.error])).toEqual(
      synth.frames.map((f) => [f.id, !!f.extended, undefined])
    );
  });

  it("decodes remote frames", () => {
    const { frames } = decode({
      baud: 125_000,
      sampleRate: 5e6,
      frameList: [
        { id: 0x123, rtr: true, data: [0, 0, 0, 0] },
        { id: 0x1abcdef, extended: true, rtr: true, data: [0, 0] },
      ],
    });
    expect(frames.map((f) => [f.id, f.rtr, f.dlc, f.data.length, f.crcOk])).toEqual([
      [0x123, true, 4, 0, true],
      [0x1abcdef, true, 2, 0, true],
    ]);
  });

  it("flags a CRC error without losing the following frames", () => {
    const { frames } = decode({
      baud: 500_000,
      sampleRate: 25e6,
      frames: 5,
      corrupt: [2],
    });
    expect(frames.map((f) => f.error)).toEqual([
      undefined,
      undefined,
      "crc",
      undefined,
      undefined,
    ]);
  });

  it("decodes through a slow release edge, noise, and a 1% bit-rate error", () => {
    // Decoding at the nominal 500k while the bus actually runs 1% slow
    const { synth, frames } = decode(
      {
        baud: 495_000,
        sampleRate: 20e6,
        frames: 30,
        noise: 0.06,
        recessiveTau: 0.12,
        extendedRatio: 0.3,
        seed: 9,
      },
      500_000
    );
    expect(frames.filter((f) => !f.error)).toHaveLength(30);
    expect(frames.map((f) => f.id)).toEqual(synth.frames.map((f) => f.id));
  });

  it("decodes using the estimated bit rate end to end", () => {
    const synth = synthCanFrames({ baud: 83_333, sampleRate: 2e6, frames: 15, seed: 4 });
    const est = estimateCanBaud(synth.samples, 2e6);
    const edges = extractEdges(synth.samples, 2e6);
    const frames = decodeCanFrames(edges, est.bitTime);
    expect(frames.map((f) => f.data)).toEqual(synth.frames.map((f) => f.data));
  });

  it("skips a frame cut off at the start of the record and marks one cut off at the end", () => {
    const synth = synthCanFrames({ baud: 500_000, sampleRate: 25e6, frames: 4, seed: 2 });
    const samplesPerBit = 50;
    // Start 20 bits into the first frame, end 20 bits into the last
    const startCut = Math.round((synth.sofTimes[0] * 500_000 + 20) * samplesPerBit);
    const endCut = Math.round((synth.sofTimes[3] * 500_000 + 20) * samplesPerBit);
    const s = synth.samples.subarray(startCut, endCut);
    const frames = decodeCanFrames(extractEdges(s, 25e6), 1 / 500_000);
    expect(frames.map((f) => [f.id, f.error])).toEqual([
      [synth.frames[1].id, undefined],
      [synth.frames[2].id, undefined],
      [expect.any(Number), "truncated"],
    ]);
  });
});
