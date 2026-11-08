/** Synthetic CAN bus waveforms for testing baud detection and decoding */

/** Deterministic PRNG (mulberry32) so tests are reproducible */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function crc15(bits: number[]): number[] {
  let crc = 0;
  for (const b of bits) {
    const next = b ^ ((crc >> 14) & 1);
    crc = (crc << 1) & 0x7fff;
    if (next) crc ^= 0x4599;
  }
  return Array.from({ length: 15 }, (_, i) => (crc >> (14 - i)) & 1);
}

function toBits(value: number, width: number): number[] {
  return Array.from({ length: width }, (_, i) => (value >> (width - 1 - i)) & 1);
}

export interface SynthFrame {
  id: number;
  extended?: boolean;
  rtr?: boolean;
  /** For a remote frame, only the length is used (as the DLC) */
  data: number[];
}

/**
 * Bit stream (0 = dominant) of one ACKed frame plus intermission. With
 * `corrupt`, the first data/DLC bit is flipped after the CRC is computed,
 * giving a CRC error with otherwise valid stuffing.
 */
function canFrame(f: SynthFrame, corrupt = false): number[] {
  const rtr = f.rtr ? 1 : 0;
  const header = f.extended
    ? [
        ...toBits(f.id >>> 18, 11),
        1, // SRR
        1, // IDE
        ...toBits(f.id & 0x3ffff, 18),
        rtr,
        0, // r1
        0, // r0
      ]
    : [...toBits(f.id, 11), rtr, 0 /* IDE */, 0 /* r0 */];
  const body = [
    0, // SOF
    ...header,
    ...toBits(f.data.length, 4),
    ...(f.rtr ? [] : f.data.flatMap((d) => toBits(d, 8))),
  ];
  const crc = crc15(body);
  if (corrupt) body[body.length - 1] ^= 1;
  const withCrc = [...body, ...crc];
  // Bit stuffing: after 5 equal bits insert the complement
  const stuffed: number[] = [];
  let run = 0;
  let last = -1;
  for (const b of withCrc) {
    stuffed.push(b);
    run = b === last ? run + 1 : 1;
    last = b;
    if (run === 5) {
      stuffed.push(1 - b);
      last = 1 - b;
      run = 1;
    }
  }
  return [...stuffed, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  //                  ^CRC delim, ACK, ACK delim, EOF x7, IFS x3
}

export interface SynthOptions {
  baud: number;
  sampleRate: number;
  /** Number of random frames (ignored when `frameList` is given) */
  frames?: number;
  /** Explicit frames to send, in order */
  frameList?: SynthFrame[];
  /** Fraction of random frames with 29-bit IDs */
  extendedRatio?: number;
  /** Indices of frames to send with a CRC error */
  corrupt?: number[];
  /** Which wire is probed */
  wire?: "CANH" | "CANL";
  /** Noise RMS in volts */
  noise?: number;
  /** Time constant of the passive dominant→recessive edge, in bits */
  recessiveTau?: number;
  seed?: number;
}

export interface SynthResult {
  samples: Float64Array;
  frames: SynthFrame[];
  /** Start-of-frame time of each frame, seconds from the first sample */
  sofTimes: number[];
}

export function synthCan(opts: SynthOptions): Float64Array {
  return synthCanFrames(opts).samples;
}

export function synthCanFrames(opts: SynthOptions): SynthResult {
  const { baud, sampleRate } = opts;
  const rand = rng(opts.seed ?? 1);
  const frames: SynthFrame[] =
    opts.frameList ??
    Array.from({ length: opts.frames ?? 10 }, () => {
      const extended = rand() < (opts.extendedRatio ?? 0);
      const len = 1 + Math.floor(rand() * 8);
      return {
        id: Math.floor(rand() * (extended ? 0x20000000 : 0x800)),
        extended,
        data: Array.from({ length: len }, () => Math.floor(rand() * 256)),
      };
    });

  const bits: number[] = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]; // idle lead-in
  const sofTimes: number[] = [];
  frames.forEach((f, idx) => {
    sofTimes.push(bits.length / baud);
    bits.push(...canFrame(f, opts.corrupt?.includes(idx)));
    const idle = Math.floor(rand() * 30); // random bus idle between frames
    for (let i = 0; i < idle; i++) bits.push(1);
  });

  const [dom, rec] = opts.wire === "CANL" ? [1.5, 2.5] : [3.5, 2.5];
  const n = Math.floor((bits.length / baud) * sampleRate);
  const out = new Float64Array(n);
  // Driven (recessive→dominant) edges are fast; the release is RC-limited
  const tauSamples = ((opts.recessiveTau ?? 0) / baud) * sampleRate;
  const alphaRelease = tauSamples > 0 ? 1 - Math.exp(-1 / tauSamples) : 1;
  let v = rec;
  for (let i = 0; i < n; i++) {
    const bit = bits[Math.min(bits.length - 1, Math.floor((i / sampleRate) * baud))];
    const target = bit === 0 ? dom : rec;
    v += (target - v) * (bit === 0 ? 1 : alphaRelease);
    // Box-Muller gaussian noise
    const g =
      Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand());
    out[i] = v + g * (opts.noise ?? 0);
  }
  return { samples: out, frames, sofTimes };
}

/** Encode volts as the scope's signed 8-bit WF? codes (inverse of captureWaveform) */
export function toScopeCodes(v: Float64Array, vdiv: number, ofst: number): Buffer {
  const buf = Buffer.alloc(v.length);
  for (let i = 0; i < v.length; i++) {
    const code = Math.max(-127, Math.min(127, Math.round((v[i] + ofst) / (vdiv / 25))));
    buf[i] = code < 0 ? code + 255 : code;
  }
  return buf;
}
