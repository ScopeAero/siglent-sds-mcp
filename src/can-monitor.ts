/**
 * Background CAN monitoring session. Runs inside the MCP server: repeatedly
 * arms a single-shot capture, downloads it, estimates the bit rate, decodes
 * frames and accumulates per-ID statistics, so a client only ever sees a
 * compact summary instead of raw waveforms.
 *
 * This is sampling, not lossless logging: traffic between captures (while
 * the record downloads and is analysed) is missed. `live_time_fraction` in
 * the summary says how much of the bus time was actually observed; message
 * periods are measured only between frames inside the same capture.
 */

import type { FileHandle } from "node:fs/promises";
import { createCsvFile } from "./output-file.js";
import { connection } from "./connection.js";
import { armAndWait } from "./acquire.js";
import { captureWaveform } from "./tools/waveform.js";
import {
  estimateCanBaud,
  extractEdges,
  snapToStandardRate,
} from "./analysis/can-baud.js";
import {
  decodeCanFrames,
  type CanErrorKind,
  type CanFrame,
} from "./analysis/can-decode.js";

export type CanSignal = "CAN_H" | "CAN_L" | "DIFF";

export interface MonitorOptions {
  channel: string;
  /** What the probe is on — sets the trigger slope and default level */
  signal: CanSignal;
  /** Known bit rate; when omitted it is measured from the traffic */
  baud?: number;
  /** Stop automatically after this long */
  durationS?: number;
  /** Stop automatically after this many captures */
  maxCaptures?: number;
  /** How long each capture waits for traffic before re-arming */
  triggerTimeoutS?: number;
  /** Set an edge trigger on the channel (restored on stop). Default true. */
  configureTrigger?: boolean;
  /** Trigger level override, e.g. "3.0V" */
  triggerLevel?: string;
  /** Write every decoded frame to this new CSV file */
  logPath?: string;
}

interface IdStats {
  id: number;
  extended: boolean;
  count: number;
  rtr: number;
  dlc: number;
  firstData: number[];
  lastData: number[];
  /** Bit k set = byte k has changed at some point */
  changedMask: number;
  periods: number[];
  /** Trigger-relative time of the last frame in the current capture */
  lastTimeInCapture?: number;
}

interface RecentFrame extends CanFrame {
  capture: number;
}

const TRIGGER_DEFAULTS: Record<CanSignal, { level: string; slope: string }> = {
  // SOF is recessive→dominant: CAN_H rises 2.5→3.5 V, CAN_L falls 2.5→1.5 V,
  // and the differential voltage rises 0→2 V
  CAN_H: { level: "3.0V", slope: "POS" },
  CAN_L: { level: "2.0V", slope: "NEG" },
  DIFF: { level: "0.9V", slope: "POS" },
};

const MAX_RECENT = 200;
const MAX_PERIODS = 256;
const MAX_ESTIMATES = 50;

let nextId = 1;
let active: CanMonitorSession | null = null;
const sessions = new Map<string, CanMonitorSession>();

export function getSession(id?: string): CanMonitorSession | undefined {
  if (id) return sessions.get(id);
  return active ?? [...sessions.values()].pop();
}

export async function startSession(
  opts: MonitorOptions
): Promise<CanMonitorSession> {
  if (active && active.state === "running") {
    throw new Error(
      `CAN monitor ${active.id} is already running on ${active.opts.channel}; stop it first (one scope, one session).`
    );
  }
  const s = new CanMonitorSession(`can-${nextId++}`, opts);
  // Register only once started, so a failed start (bad log path, scope
  // error) doesn't leave a phantom "running" session blocking the next one
  await s.start();
  sessions.set(s.id, s);
  active = s;
  return s;
}

export class CanMonitorSession {
  state: "running" | "stopped" | "failed" = "running";
  stopReason = "";
  readonly startedAt = Date.now();
  stoppedAt?: number;

  private captures = 0;
  private triggerTimeouts = 0;
  private liveTime = 0;
  private analysisFailures = 0;
  private lastError = "";
  private baudEstimates: number[] = [];
  private ids = new Map<string, IdStats>();
  private recent: RecentFrame[] = [];
  private errorCounts: Partial<Record<CanErrorKind, number>> = {};
  private framesOk = 0;
  private unacked = 0;
  private stopRequested = false;
  private loop: Promise<void> = Promise.resolve();
  private saved: Array<string> = [];
  private logPath?: string;
  /** Kept open for the session so writes can't be redirected via the path */
  private logHandle?: FileHandle;

  constructor(
    readonly id: string,
    readonly opts: MonitorOptions
  ) {}

  async start(): Promise<void> {
    // Create the log before touching the trigger, so a bad path fails cleanly
    if (this.opts.logPath) {
      const { path, handle } = await createCsvFile(this.opts.logPath);
      this.logPath = path;
      this.logHandle = handle;
    }
    try {
      await this.logHandle?.write(
        "capture,time_s,id_hex,extended,rtr,dlc,data_hex,crc_ok,acked,error\n"
      );
      if (this.opts.configureTrigger !== false) await this.configureTrigger();
    } catch (err) {
      await this.logHandle?.close().catch(() => {});
      throw err;
    }
    this.loop = this.run();
  }

  async stop(reason = "stopped by request"): Promise<void> {
    if (this.state !== "running") return;
    this.stopRequested = true;
    this.stopReason = reason;
    await this.loop;
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopRequested) {
        if (this.opts.durationS && Date.now() - this.startedAt >= this.opts.durationS * 1000) {
          this.stopReason = `duration of ${this.opts.durationS} s reached`;
          break;
        }
        if (this.opts.maxCaptures && this.captures >= this.opts.maxCaptures) {
          this.stopReason = `${this.opts.maxCaptures} captures done`;
          break;
        }
        const triggered = await armAndWait((this.opts.triggerTimeoutS ?? 2) * 1000);
        if (!triggered) {
          this.triggerTimeouts++;
          continue;
        }
        await this.analyseCapture();
      }
      this.state = "stopped";
    } catch (err) {
      // Connection-level failure: the scope is gone, so stop the session
      this.state = "failed";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.stopReason = `failed: ${this.lastError}`;
    } finally {
      this.stoppedAt = Date.now();
      if (active === this) active = null;
      await this.restoreTrigger().catch(() => {});
      await this.logHandle?.close().catch(() => {});
      this.logHandle = undefined;
    }
  }

  private async analyseCapture(): Promise<void> {
    const wf = await captureWaveform(this.opts.channel);
    const capture = ++this.captures;
    this.liveTime += wf.voltages.length / wf.sampleRate;

    let bitTime: number | undefined;
    let edges;
    try {
      edges = extractEdges(wf.voltages, wf.sampleRate);
      if (this.opts.baud) {
        bitTime = 1 / this.opts.baud;
      } else {
        try {
          const est = estimateCanBaud(wf.voltages, wf.sampleRate);
          if (est.confidence !== "low") {
            this.baudEstimates.push(est.baud);
            if (this.baudEstimates.length > MAX_ESTIMATES) this.baudEstimates.shift();
          }
        } catch (e) {
          // Too few edges in this capture to estimate; decode with consensus
          this.lastError = e instanceof Error ? e.message : String(e);
        }
        const consensus = this.consensusBaud();
        if (consensus) bitTime = 1 / consensus;
      }
    } catch (e) {
      this.analysisFailures++;
      this.lastError = e instanceof Error ? e.message : String(e);
      return;
    }
    if (!bitTime) {
      this.analysisFailures++;
      return;
    }

    const frames = decodeCanFrames(edges, bitTime);
    for (const s of this.ids.values()) s.lastTimeInCapture = undefined;
    let log = "";
    for (const f of frames) {
      const t = wf.startTime + f.time;
      if (f.error) this.errorCounts[f.error] = (this.errorCounts[f.error] ?? 0) + 1;
      this.recent.push({ ...f, time: t, capture });
      if (this.recent.length > MAX_RECENT) this.recent.shift();
      if (this.logHandle) log += csvRow(capture, t, f);
      if (f.error) continue;
      this.framesOk++;
      if (!f.acked) this.unacked++;
      this.addToIdStats(f, t);
    }
    if (log && this.logHandle) await this.logHandle.write(log);
  }

  private addToIdStats(f: CanFrame, t: number): void {
    const key = `${f.extended ? "x" : "s"}${f.id}`;
    let s = this.ids.get(key);
    if (!s) {
      s = {
        id: f.id,
        extended: f.extended,
        count: 0,
        rtr: 0,
        dlc: f.dlc,
        firstData: f.data,
        lastData: f.data,
        changedMask: 0,
        periods: [],
      };
      this.ids.set(key, s);
    }
    s.count++;
    if (f.rtr) {
      s.rtr++;
      return;
    }
    s.dlc = f.dlc;
    f.data.forEach((b, k) => {
      if (s.firstData[k] !== b) s.changedMask |= 1 << k;
    });
    s.lastData = f.data;
    if (s.lastTimeInCapture !== undefined) {
      s.periods.push(t - s.lastTimeInCapture);
      if (s.periods.length > MAX_PERIODS) s.periods.shift();
    }
    s.lastTimeInCapture = t;
  }

  private consensusBaud(): number | undefined {
    if (this.baudEstimates.length === 0) return undefined;
    return median(this.baudEstimates);
  }

  private async configureTrigger(): Promise<void> {
    const ch = this.opts.channel;
    const [trse, trmd, trdl, chLevel, chSlope, tdiv] = await Promise.all([
      connection.query("TRSE?"),
      connection.query("TRMD?"),
      connection.query("TRDL?"),
      connection.query(`${ch}:TRLV?`),
      connection.query(`${ch}:TRSL?`),
      connection.query("TDIV?"),
    ]);
    // Restore order matters: <ch>:TRLV also switches the trigger source, so
    // put back the per-channel settings first and the trigger select last.
    const restore = [`${ch}:TRLV ${chLevel}`, `${ch}:TRSL ${chSlope}`];
    const src = /SR,(C\d)/.exec(trse)?.[1];
    if (src && src !== ch) {
      const [lv, sl] = await Promise.all([
        connection.query(`${src}:TRLV?`),
        connection.query(`${src}:TRSL?`),
      ]);
      restore.push(`${src}:TRLV ${lv}`, `${src}:TRSL ${sl}`);
    }
    restore.push(`TRSE ${trse}`, `TRDL ${trdl}`, `TRMD ${trmd}`);
    this.saved = restore;

    const def = TRIGGER_DEFAULTS[this.opts.signal];
    // Trigger one division from the left edge so ~13 of 14 divisions of the
    // record are traffic after the SOF that triggered it
    const delay = -parseFloat(tdiv) * 6;
    for (const cmd of [
      `TRSE EDGE,SR,${ch},HT,OFF`,
      `${ch}:TRLV ${this.opts.triggerLevel ?? def.level}`,
      `${ch}:TRSL ${def.slope}`,
      ...(Number.isFinite(delay) ? [`TRDL ${delay.toExponential(3)}S`] : []),
    ]) {
      await connection.sendCommand(cmd);
    }
  }

  private async restoreTrigger(): Promise<void> {
    for (const cmd of this.saved) await connection.sendCommand(cmd);
    this.saved = [];
  }

  summary(recentFrames = 0): Record<string, unknown> {
    const end = this.stoppedAt ?? Date.now();
    const elapsed = (end - this.startedAt) / 1000;
    const consensus = this.consensusBaud();
    const std = consensus ? snapToStandardRate(consensus) : null;

    const ids = [...this.ids.values()]
      .sort((a, b) => Number(a.extended) - Number(b.extended) || a.id - b.id)
      .map((s) => ({
        id: hexId(s),
        count: s.count,
        ...(s.rtr ? { remote_frames: s.rtr } : {}),
        dlc: s.dlc,
        data: hexBytes(s.lastData),
        // X = byte has changed since first seen; useful for spotting counters/signals
        changing: s.lastData.map((_, k) => (s.changedMask & (1 << k) ? "X" : "-")).join(""),
        period_ms: s.periods.length ? Number((median(s.periods) * 1e3).toFixed(3)) : null,
      }));

    const errors = { ...this.errorCounts };
    const truncated = errors.truncated ?? 0;
    delete errors.truncated;

    const out: Record<string, unknown> = {
      session: this.id,
      state: this.state,
      ...(this.state !== "running" ? { stop_reason: this.stopReason } : {}),
      channel: this.opts.channel,
      elapsed_s: Number(elapsed.toFixed(1)),
      captures: this.captures,
      trigger_timeouts: this.triggerTimeouts,
      live_time_fraction: elapsed > 0 ? Number((this.liveTime / elapsed).toFixed(4)) : 0,
      baud: this.opts.baud
        ? { configured: this.opts.baud }
        : {
            measured: consensus ? Math.round(consensus) : null,
            standard: std?.baud ?? null,
            error_pct: std ? Number(std.errorPct.toFixed(3)) : null,
            captures_estimated: this.baudEstimates.length,
          },
      frames: {
        ok: this.framesOk,
        errors,
        unacked: this.unacked,
        // Frames cut off by the record boundary, expected and not bus errors
        cut_at_capture_edge: truncated,
      },
      unique_ids: ids.length,
      ids,
    };
    if (this.analysisFailures) out.analysis_failures = this.analysisFailures;
    if (this.lastError) out.last_error = this.lastError;
    if (this.logPath) out.log_file = this.logPath;
    if (recentFrames > 0) {
      out.recent_frames = this.recent.slice(-recentFrames).map((f) => ({
        capture: f.capture,
        t_ms: Number((f.time * 1e3).toFixed(4)),
        id: hexId(f),
        dlc: f.dlc,
        data: hexBytes(f.data),
        ...(f.rtr ? { rtr: true } : {}),
        ...(f.error ? { error: f.error } : {}),
      }));
    }
    return out;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hexId(f: { id: number; extended: boolean }): string {
  return "0x" + f.id.toString(16).toUpperCase().padStart(f.extended ? 8 : 3, "0");
}

function hexBytes(data: number[]): string {
  return data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

function csvRow(capture: number, t: number, f: CanFrame): string {
  return [
    capture,
    t.toPrecision(9),
    hexId(f),
    f.extended ? 1 : 0,
    f.rtr ? 1 : 0,
    f.dlc,
    f.data.map((b) => b.toString(16).padStart(2, "0")).join(""),
    f.crcOk ? 1 : 0,
    f.acked ? 1 : 0,
    f.error ?? "",
  ].join(",") + "\n";
}

