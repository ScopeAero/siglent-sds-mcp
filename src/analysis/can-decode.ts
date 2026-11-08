/**
 * Classic CAN (2.0A/2.0B) frame decoder working on an edge list.
 *
 * Bits are recovered by dividing each run between edges by the bit time and
 * rounding. Re-aligning on every edge is what a CAN controller's
 * resynchronisation does, and since bit stuffing guarantees an edge at least
 * every 5 bits inside a frame, a bit-time error of several percent can't
 * accumulate into a wrong bit count.
 */

import type { EdgeList } from "./can-baud.js";

export interface CanFrame {
  /** SOF time in seconds from the start of the capture */
  time: number;
  id: number;
  extended: boolean;
  rtr: boolean;
  dlc: number;
  data: number[];
  crcOk: boolean;
  acked: boolean;
  /** Set when the frame couldn't be fully decoded or broke a format rule */
  error?: CanErrorKind;
}

export type CanErrorKind =
  | "stuff" // 6 equal consecutive bits inside the stuffed region (also how error frames show up)
  | "form" // a fixed-form bit (CRC delimiter, ACK delimiter, EOF) had the wrong value
  | "crc" // CRC mismatch
  | "fd" // CAN FD frame (FDF bit set) — not decoded
  | "truncated"; // capture ended mid-frame

const DOMINANT = 0;
const RECESSIVE = 1;
/** Recessive bits that must precede a start-of-frame (in-frame runs are ≤5) */
const MIN_IDLE_BEFORE_SOF = 7;
/** Long idle runs are capped to this many bits to bound memory */
const MAX_RUN_BITS = 64;

class Truncated extends Error {}
class StuffError extends Error {}

export function decodeCanFrames(edges: EdgeList, bitTime: number): CanFrame[] {
  const { bits, times } = toBitStream(edges, bitTime);
  const frames: CanFrame[] = [];

  let idle = 0; // recessive bits seen in a row
  let i = 0;
  while (i < bits.length) {
    if (bits[i] === RECESSIVE) {
      idle++;
      i++;
      continue;
    }
    if (idle < MIN_IDLE_BEFORE_SOF) {
      // Dominant bit not preceded by bus idle: mid-frame at capture start,
      // or the remainder of a frame we gave up on
      idle = 0;
      i++;
      continue;
    }
    const { frame, next } = decodeOne(bits, times, i);
    frames.push(frame);
    // A frame decoded through its EOF leaves the bus in intermission, where
    // the next SOF may come after just 2–3 more recessive bits; otherwise
    // wait for real bus idle before trusting a dominant bit as SOF.
    const reachedEof = frame.error !== "stuff" && frame.error !== "truncated" && frame.error !== "fd";
    idle = reachedEof ? MIN_IDLE_BEFORE_SOF : 0;
    i = Math.max(next, i + 1);
  }
  return frames;
}

/** Expand the edge list into one entry per bit (0 = dominant) */
function toBitStream(
  edges: EdgeList,
  bitTime: number
): { bits: Uint8Array; times: Float64Array } {
  const { edgeTimes, edgeRising, initialHigh, duration, recessive } = edges;
  const recessiveHigh = recessive === "high";
  const bounds = [0, ...edgeTimes, duration];
  const out: number[] = [];
  const t: number[] = [];
  for (let r = 0; r + 1 < bounds.length; r++) {
    const start = bounds[r];
    const len = bounds[r + 1] - start;
    const isHigh = r === 0 ? initialHigh : edgeRising[r - 1];
    const level = isHigh === recessiveHigh ? RECESSIVE : DOMINANT;
    // The partial runs at the ends of the record are floored, not rounded,
    // so a run cut off by the record boundary never gains a bit
    const edgeRun = r > 0 && r + 2 < bounds.length;
    let nBits = edgeRun ? Math.round(len / bitTime) : Math.floor(len / bitTime);
    if (edgeRun) nBits = Math.max(1, nBits);
    nBits = Math.min(nBits, MAX_RUN_BITS);
    for (let k = 0; k < nBits; k++) {
      out.push(level);
      t.push(start + k * bitTime);
    }
  }
  return { bits: Uint8Array.from(out), times: Float64Array.from(t) };
}

function decodeOne(
  bits: Uint8Array,
  times: Float64Array,
  sof: number
): { frame: CanFrame; next: number } {
  let pos = sof;
  let sameCount = 0;
  let last = -1;
  const crcBits: number[] = []; // destuffed bits from SOF through data

  const raw = (): number => {
    if (pos >= bits.length) throw new Truncated();
    return bits[pos++];
  };
  // Read one bit from the stuffed region, removing stuff bits
  const stuffed = (): number => {
    if (sameCount === 5) {
      const s = raw();
      if (s === last) throw new StuffError();
      last = s;
      sameCount = 1;
    }
    const b = raw();
    if (b === last) sameCount++;
    else {
      last = b;
      sameCount = 1;
    }
    return b;
  };
  const field = (width: number, intoCrc = true): number => {
    let v = 0;
    for (let k = 0; k < width; k++) {
      const b = stuffed();
      if (intoCrc) crcBits.push(b);
      v = v * 2 + b;
    }
    return v;
  };

  const frame: CanFrame = {
    time: times[sof],
    id: 0,
    extended: false,
    rtr: false,
    dlc: 0,
    data: [],
    crcOk: false,
    acked: false,
  };

  try {
    field(1); // SOF
    const idA = field(11);
    const rtrOrSrr = field(1);
    const ide = field(1);
    if (ide === 0) {
      frame.id = idA;
      frame.rtr = rtrOrSrr === RECESSIVE;
      const fdf = field(1); // r0 in classic CAN, FDF in CAN FD
      if (fdf === RECESSIVE) {
        frame.error = "fd";
        return { frame, next: pos };
      }
    } else {
      frame.extended = true;
      frame.id = (idA << 18) | field(18);
      frame.rtr = field(1) === RECESSIVE;
      const fdf = field(1); // r1 in classic CAN, FDF in CAN FD
      field(1); // r0
      if (fdf === RECESSIVE) {
        frame.error = "fd";
        return { frame, next: pos };
      }
    }
    frame.dlc = field(4);
    const nData = frame.rtr ? 0 : Math.min(frame.dlc, 8);
    for (let k = 0; k < nData; k++) frame.data.push(field(8));

    const crc = field(15, false);
    frame.crcOk = crc === crc15(crcBits);

    // The stuffed region ends with the CRC; a stuff bit may still follow it
    if (sameCount === 5) {
      const s = raw();
      if (s === last) throw new StuffError();
    }
    const crcDelim = raw();
    frame.acked = raw() === DOMINANT;
    const ackDelim = raw();
    let eofOk = true;
    for (let k = 0; k < 7 && pos < bits.length; k++) {
      if (raw() !== RECESSIVE) eofOk = false;
    }
    if (!frame.crcOk) frame.error = "crc";
    else if (crcDelim !== RECESSIVE || ackDelim !== RECESSIVE || !eofOk) {
      frame.error = "form";
    }
  } catch (e) {
    if (e instanceof Truncated) frame.error = "truncated";
    else if (e instanceof StuffError) frame.error = "stuff";
    else throw e;
  }
  return { frame, next: pos };
}

/** CAN CRC-15 (polynomial 0x4599) */
export function crc15(bits: number[]): number {
  let crc = 0;
  for (const b of bits) {
    const next = b ^ ((crc >> 14) & 1);
    crc = (crc << 1) & 0x7fff;
    if (next) crc ^= 0x4599;
  }
  return crc;
}
