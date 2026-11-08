/**
 * Estimate a CAN bus bit rate from a sampled waveform (CAN_H, CAN_L or a
 * differential probe). Pure function of the samples — no scope I/O — so it
 * can be unit-tested against synthetic frames.
 *
 * Method:
 *  1. Find the two logic levels as the two main peaks of the sample histogram
 *     (works for a mostly-idle bus where dominant samples are <1% of the
 *     record) and slice with hysteresis, timing each edge by interpolating
 *     the mid-level crossing.
 *  2. Work on *same-polarity* intervals (rising→rising, falling→falling). On
 *     CAN the dominant→recessive edge is passive and much slower than the
 *     driven edge, which shifts one kind of crossing relative to the other.
 *     Edge-to-edge runs inherit that skew (a 1-bit dominant run can measure
 *     1.1 bits and a recessive one 0.9); same-polarity intervals cancel it and
 *     are always a whole number of bits, at least 2.
 *  3. Seed the bit time from the shortest common interval, which is 2 bits:
 *     every ACKed frame has one (CRC delimiter + ACK slot), and stuff bits
 *     make many more. That rules out locking onto a multiple of the bit time.
 *  4. Refine by least squares with each interval assigned an integer bit
 *     count, widening the allowed counts gradually (≤3, ≤5, ≤10 bits) so a
 *     few-percent seed error can't misassign the long intervals.
 */

export interface StandardRateMatch {
  /** The standard bit rate the measurement was matched to, bit/s */
  baud: number;
  /** (measured - standard) / standard, in percent */
  errorPct: number;
}

export interface CanBaudEstimate {
  /** Measured bit rate, bit/s */
  baud: number;
  /** Measured bit time, seconds */
  bitTime: number;
  confidence: "high" | "medium" | "low";
  /** RMS deviation of the intervals from integer bit counts, in bits */
  residualBits: number;
  edges: number;
  intervalsUsed: number;
  /** Frames seen (bursts separated by ≥10 recessive bits) */
  frames: number;
  samplesPerBit: number;
  levels: { low: number; high: number; threshold: number };
  /**
   * Which level is recessive (the bus idle level). Low for CAN_H or a
   * differential probe, high for CAN_L.
   */
  recessive: "low" | "high";
  warnings: string[];
}

/** Common CAN / CAN-based (CANopen, J1939, ARINC 825, CANaerospace) bit rates */
export const STANDARD_CAN_RATES = [
  10_000, 20_000, 33_333, 50_000, 62_500, 83_333, 100_000, 125_000, 250_000,
  500_000, 800_000, 1_000_000,
];

/**
 * Match a measured bit rate to a standard one.
 *
 * Returns the nearest entry of `rates` together with the measurement's
 * percentage error from it, or null when the measurement isn't close enough
 * to any of them to call it that rate (a non-standard bus, or a bad capture).
 *
 * The tolerance covers CAN's oscillator budget (ISO 11898 allows up to ~1.58%
 * combined) plus measurement error. A node further off than that wouldn't
 * communicate reliably anyway, so reporting "no standard rate" (alongside the
 * measured value) is more useful than silently rounding it.
 */
export const STANDARD_RATE_TOLERANCE_PCT = 2;

export function snapToStandardRate(
  measured: number,
  rates: readonly number[] = STANDARD_CAN_RATES,
  tolerancePct: number = STANDARD_RATE_TOLERANCE_PCT
): StandardRateMatch | null {
  let best: StandardRateMatch | null = null;
  for (const baud of rates) {
    const errorPct = ((measured - baud) / baud) * 100;
    if (!best || Math.abs(errorPct) < Math.abs(best.errorPct)) {
      best = { baud, errorPct };
    }
  }
  return best && Math.abs(best.errorPct) <= tolerancePct ? best : null;
}

const MAX_INTERVAL_BITS = 10; // bit stuffing caps in-frame same-polarity intervals at 5+5
const INTERFRAME_BITS = 10; // EOF (7) + intermission (3) recessive bits

export function estimateCanBaud(
  samples: ArrayLike<number>,
  sampleRate: number
): CanBaudEstimate {
  const { edgeTimes, edgeRising, levels, recessive } = extractEdges(
    samples,
    sampleRate
  );
  const { low, high, threshold } = levels;

  const edges = edgeTimes.length;
  if (edges < 8) {
    throw new Error(
      `Only ${edges} edges found — capture a longer window containing several CAN frames.`
    );
  }

  const runs: number[] = [];
  for (let i = 1; i < edges; i++) runs.push(edgeTimes[i] - edgeTimes[i - 1]);

  // 2. Same-polarity intervals (edges alternate, so i and i-2 share polarity)
  const intervals: number[] = [];
  for (let i = 2; i < edges; i++) {
    intervals.push(edgeTimes[i] - edgeTimes[i - 2]);
  }

  // 3. Seed: the shortest common interval is 2 bits. Take the median of the
  // cluster around the 10th percentile so a stray short glitch can't set it.
  const ivSorted = [...intervals].sort((x, y) => x - y);
  const p10 = ivSorted[Math.floor(ivSorted.length * 0.1)];
  const cluster = ivSorted.filter((iv) => iv > p10 * 0.75 && iv < p10 * 1.25);
  let bitTime = cluster[Math.floor(cluster.length / 2)] / 2;

  // 4. Least squares with integer bit counts, widening the allowed range
  let used: Array<[number, number]> = [];
  for (const maxBits of [3, 5, MAX_INTERVAL_BITS, MAX_INTERVAL_BITS]) {
    const fit = fitBitTime(intervals, bitTime, maxBits);
    if (fit.used.length === 0) break;
    bitTime = fit.bitTime;
    used = fit.used;
  }

  if (used.length === 0) {
    throw new Error(
      "Edges don't fall on a consistent bit grid — this doesn't look like CAN traffic (or the sample rate is far too low)."
    );
  }

  let sq = 0;
  for (const [iv, k] of used) {
    const e = iv / bitTime - k;
    sq += e * e;
  }
  const residualBits = Math.sqrt(sq / used.length);

  // Frames: bursts separated by a long recessive run
  let frames = 1;
  for (let i = 1; i < edges; i++) {
    const wasHigh = edgeRising[i - 1];
    const isRecessive = (recessive === "high") === wasHigh;
    if (isRecessive && runs[i - 1] >= INTERFRAME_BITS * bitTime) frames++;
  }

  const baud = 1 / bitTime;
  const samplesPerBit = bitTime * sampleRate;
  // Intervals spanning bus idle are legitimately unusable; judge the fit only
  // on the ones short enough to be inside a frame.
  const inFrame = intervals.filter(
    (iv) => iv < (MAX_INTERVAL_BITS + 0.5) * bitTime
  ).length;
  const usedFraction = inFrame > 0 ? used.length / inFrame : 0;

  const warnings: string[] = [];
  if (samplesPerBit < 8) {
    warnings.push(
      `Only ${samplesPerBit.toFixed(1)} samples per bit — use a faster timebase or more memory depth for a reliable estimate.`
    );
  }
  if (used.length < 30) {
    warnings.push(
      `Only ${used.length} usable intervals — capture more frames (slower timebase) for a better estimate.`
    );
  }
  if (usedFraction < 0.6) {
    warnings.push(
      `Only ${(usedFraction * 100).toFixed(0)}% of edge intervals fit a bit grid — noisy signal, multiple buses, or not CAN.`
    );
  }

  let confidence: CanBaudEstimate["confidence"] = "low";
  if (residualBits < 0.05 && used.length >= 50 && usedFraction > 0.8 && samplesPerBit >= 8) {
    confidence = "high";
  } else if (residualBits < 0.1 && used.length >= 20 && usedFraction > 0.6) {
    confidence = "medium";
  }

  return {
    baud,
    bitTime,
    confidence,
    residualBits,
    edges,
    intervalsUsed: used.length,
    frames,
    samplesPerBit,
    levels: { low, high, threshold },
    recessive,
    warnings,
  };
}

export interface EdgeList {
  /** Edge times in seconds from the first sample, alternating polarity */
  edgeTimes: number[];
  /** true = low→high */
  edgeRising: boolean[];
  /** Level of the signal before the first edge */
  initialHigh: boolean;
  /** Capture length, seconds */
  duration: number;
  levels: { low: number; high: number; threshold: number };
  /** Which level is recessive (the idle level) */
  recessive: "low" | "high";
}

/**
 * Slice a two-level signal into edges. Levels are the two main histogram
 * peaks — percentiles would miss the dominant level on a mostly-idle bus, and
 * min/max would track overshoot. A Schmitt trigger rejects noise, and each
 * edge is timed at its last interpolated mid-level crossing.
 */
export function extractEdges(
  samples: ArrayLike<number>,
  sampleRate: number
): EdgeList {
  const n = samples.length;
  if (n < 16) throw new Error(`Too few samples (${n}) to analyse`);
  const dt = 1 / sampleRate;

  const { low, high } = findLevels(samples);
  const threshold = (low + high) / 2;
  const hyst = (high - low) * 0.15;

  const edgeTimes: number[] = [];
  const edgeRising: boolean[] = [];
  const initialHigh = samples[0] > threshold;
  let state = initialHigh;
  let crossing = -1; // interpolated time of the most recent mid-level crossing
  for (let i = 1; i < n; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if ((a <= threshold) !== (b <= threshold)) {
      crossing = (i - 1 + (threshold - a) / (b - a)) * dt;
    }
    if (!state && b > threshold + hyst) {
      state = true;
      if (crossing >= 0) {
        edgeTimes.push(crossing);
        edgeRising.push(true);
      }
    } else if (state && b < threshold - hyst) {
      state = false;
      if (crossing >= 0) {
        edgeTimes.push(crossing);
        edgeRising.push(false);
      }
    }
  }
  const duration = n * dt;

  // The bus idles recessive, so the longest run — including the partial runs
  // at either end of the record, which are usually idle — is recessive.
  let longest = 0;
  let longestHigh = initialHigh;
  const consider = (len: number, isHigh: boolean) => {
    if (len > longest) {
      longest = len;
      longestHigh = isHigh;
    }
  };
  if (edgeTimes.length === 0) {
    consider(duration, initialHigh);
  } else {
    consider(edgeTimes[0], initialHigh);
    for (let i = 1; i < edgeTimes.length; i++) {
      consider(edgeTimes[i] - edgeTimes[i - 1], edgeRising[i - 1]);
    }
    const last = edgeTimes.length - 1;
    consider(duration - edgeTimes[last], edgeRising[last]);
  }

  return {
    edgeTimes,
    edgeRising,
    initialHigh,
    duration,
    levels: { low, high, threshold },
    recessive: longestHigh ? "high" : "low",
  };
}

/** Least-squares bit time over intervals assigned an integer bit count ≤ maxBits */
function fitBitTime(
  intervals: number[],
  seed: number,
  maxBits: number
): { bitTime: number; used: Array<[number, number]> } {
  const used: Array<[number, number]> = [];
  let num = 0;
  let den = 0;
  for (const iv of intervals) {
    const ratio = iv / seed;
    const k = Math.round(ratio);
    if (k >= 2 && k <= maxBits && Math.abs(ratio - k) < 0.3) {
      used.push([iv, k]);
      num += iv * k;
      den += k * k;
    }
  }
  return { bitTime: den > 0 ? num / den : seed, used };
}

/**
 * The bus's two logic levels: the tallest histogram peak (usually recessive,
 * since the bus idles there) and the tallest peak well separated from it.
 */
function findLevels(samples: ArrayLike<number>): { low: number; high: number } {
  const n = samples.length;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const flat = new Error(
    "Signal is flat — no CAN traffic captured. Check the probe and that the bus is active."
  );
  if (!(max > min)) throw flat;

  // 256 bins matches the scope's 8-bit ADC, so every code gets its own bin
  const BINS = 256;
  const width = (max - min) / BINS;
  const hist = new Uint32Array(BINS);
  for (let i = 0; i < n; i++) {
    hist[Math.min(BINS - 1, Math.floor((samples[i] - min) / width))]++;
  }
  let p1 = 0;
  for (let b = 1; b < BINS; b++) if (hist[b] > hist[p1]) p1 = b;
  // Second level: tallest peak at least a quarter of the range away, so the
  // noise skirt of the first peak isn't mistaken for it
  let p2 = -1;
  for (let b = 0; b < BINS; b++) {
    if (Math.abs(b - p1) > BINS / 4 && (p2 < 0 || hist[b] > hist[p2])) p2 = b;
  }
  if (p2 < 0 || hist[p2] === 0) throw flat;
  // Two real levels have a valley between them; a single noisy level just
  // tails off. Require the floor between the peaks to be well below both.
  const [lo, hi] = p1 < p2 ? [p1, p2] : [p2, p1];
  let valley = Infinity;
  for (let b = lo + 1; b < hi; b++) valley = Math.min(valley, hist[b]);
  if (!(valley < hist[p2] * 0.5)) throw flat;
  const a = min + (p1 + 0.5) * width;
  const b = min + (p2 + 0.5) * width;
  return { low: Math.min(a, b), high: Math.max(a, b) };
}
