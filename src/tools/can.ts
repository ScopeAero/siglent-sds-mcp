import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connection } from "../connection.js";
import { captureWaveform } from "./waveform.js";
import { armAndWait } from "../acquire.js";
import {
  estimateCanBaud,
  extractEdges,
  snapToStandardRate,
} from "../analysis/can-baud.js";
import { decodeCanFrames } from "../analysis/can-decode.js";
import { getSession, startSession } from "../can-monitor.js";

const channelEnum = z.enum(["C1", "C2", "C3", "C4"]);

export function registerCanTools(server: McpServer): void {
  server.tool(
    "detect_can_baud",
    "Measure the bit rate of CAN traffic on an analog channel by analysing the captured waveform's edge timing, and match it to a standard rate. " +
      "Probe CAN_H, CAN_L, or CAN_H−CAN_L with a differential probe. Analyses the record in memory (or a fresh one with arm=true), so first set the timebase " +
      "to capture several frames (e.g. 1MS/div) with at least ~10 samples per bit (10 MSa/s for 1 Mbit/s). " +
      "Optionally configures a decode bus with the result.",
    {
      channel: channelEnum.describe("Channel probing the CAN bus"),
      arm: armParam,
      apply_to_decoder: z
        .enum(["B1", "B2"])
        .optional()
        .describe(
          "If set, configure this serial decode bus (already set to CAN on the scope) for the channel at the detected rate and turn decode on"
        ),
    },
    { readOnlyHint: false },
    async ({ channel, arm, apply_to_decoder }) => {
      try {
        await maybeArm(arm);
        const wf = await captureWaveform(channel);
        const est = estimateCanBaud(wf.voltages, wf.sampleRate);
        const standard = snapToStandardRate(est.baud);

        const result: Record<string, unknown> = {
          channel,
          measured_baud: Math.round(est.baud),
          standard_baud: standard?.baud ?? null,
          error_from_standard_pct: standard
            ? Number(standard.errorPct.toFixed(3))
            : null,
          confidence: est.confidence,
          bit_time_s: est.bitTime,
          frames_seen: est.frames,
          edges: est.edges,
          intervals_used: est.intervalsUsed,
          residual_bits_rms: Number(est.residualBits.toFixed(4)),
          samples_per_bit: Number(est.samplesPerBit.toFixed(1)),
          sample_rate: wf.sampleRate,
          levels_v: {
            low: Number(est.levels.low.toFixed(3)),
            high: Number(est.levels.high.toFixed(3)),
            threshold: Number(est.levels.threshold.toFixed(3)),
          },
          // Recessive is the idle level: low on CAN_H/differential, high on CAN_L
          recessive_level: est.recessive,
          probable_signal:
            est.recessive === "high" ? "CAN_L" : "CAN_H or differential",
          warnings: est.warnings,
        };

        if (apply_to_decoder) {
          const baud = standard?.baud ?? Math.round(est.baud);
          if (baud < 5000 || baud > 1_000_000) {
            result.decoder = `Not applied: ${baud} bit/s is outside the decoder's 5000–1000000 range`;
          } else {
            const thr = `${est.levels.threshold.toFixed(3)}V`;
            const cmd =
              est.recessive === "high"
                ? `${apply_to_decoder}:DCCN DIS,ON,CANL,${channel},CANLT,${thr},SRC,CAN_L,BAUD,${baud}`
                : `${apply_to_decoder}:DCCN DIS,ON,CANH,${channel},CANHT,${thr},SRC,CAN_H,BAUD,${baud}`;
            // The guide documents no SCPI command for choosing the bus's
            // protocol; if the bus isn't already CAN, select it on the scope.
            await connection.sendCommand(`DCPA BUS,${apply_to_decoder}`);
            await connection.sendCommand(cmd);
            await connection.sendCommand("DCST ON");
            result.decoder = {
              bus: apply_to_decoder,
              baud,
              commands: [
                `DCPA BUS,${apply_to_decoder}`,
                cmd,
                "DCST ON",
              ],
            };
          }
        }

        const headline = standard
          ? `${channel}: ${fmtBaud(standard.baud)} CAN (measured ${fmtBaud(est.baud)}, ${standard.errorPct >= 0 ? "+" : ""}${standard.errorPct.toFixed(2)}%), confidence ${est.confidence}`
          : `${channel}: measured ${fmtBaud(est.baud)}, which matches no standard CAN rate; confidence ${est.confidence}`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${headline}\n${JSON.stringify(result, null, 2)}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "can_decode",
    "Decode classic CAN 2.0A/B frames from one capture on an analog channel and return them with a per-ID summary. " +
      "The bit rate is measured from the traffic unless given. For continuous monitoring use can_monitor_start instead.",
    {
      channel: channelEnum.describe("Channel probing the CAN bus"),
      baud: baudParam,
      arm: armParam,
      max_frames: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum frames to list (default 50); the summary covers all"),
    },
    { readOnlyHint: false },
    async ({ channel, baud, arm, max_frames }) => {
      try {
        await maybeArm(arm);
        const wf = await captureWaveform(channel);
        const edges = extractEdges(wf.voltages, wf.sampleRate);
        const rate = baud ?? estimateCanBaud(wf.voltages, wf.sampleRate).baud;
        const frames = decodeCanFrames(edges, 1 / rate);
        const limit = max_frames ?? 50;
        const counts = new Map<string, number>();
        let errors = 0;
        for (const f of frames) {
          if (f.error) {
            if (f.error !== "truncated") errors++;
            continue;
          }
          const id = hexId(f.id, f.extended);
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        const result = {
          channel,
          baud: Math.round(rate),
          baud_source: baud ? "given" : "measured",
          frames_decoded: frames.filter((f) => !f.error).length,
          frame_errors: errors,
          ids: Object.fromEntries([...counts].sort()),
          frames: frames.slice(0, limit).map((f) => ({
            t_ms: Number(((wf.startTime + f.time) * 1e3).toFixed(4)),
            id: hexId(f.id, f.extended),
            dlc: f.dlc,
            data: f.data.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" "),
            ...(f.rtr ? { rtr: true } : {}),
            ...(!f.acked && !f.error ? { acked: false } : {}),
            ...(f.error ? { error: f.error } : {}),
          })),
          ...(frames.length > limit ? { frames_omitted: frames.length - limit } : {}),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "can_monitor_start",
    "Start a background CAN monitoring session. The server repeatedly captures the bus, measures the bit rate, decodes frames, " +
      "and builds per-ID statistics (count, period, latest data, which bytes change) — poll can_monitor_status for the summary " +
      "and call can_monitor_stop when done. Sets an edge trigger on the channel for start-of-frame (restored on stop). " +
      "Set the timebase first so one capture holds several frames (e.g. 1-2 ms/div). Traffic is sampled, not logged losslessly.",
    {
      channel: channelEnum.describe("Channel probing the CAN bus"),
      signal: z
        .enum(["CAN_H", "CAN_L", "DIFF"])
        .optional()
        .describe("What the probe measures (default CAN_H); sets trigger slope and level"),
      baud: baudParam,
      duration_s: z.number().positive().optional().describe("Stop automatically after this many seconds"),
      max_captures: z.number().int().positive().optional().describe("Stop automatically after this many captures"),
      trigger_timeout_s: z
        .number()
        .positive()
        .optional()
        .describe("Seconds each capture waits for traffic before re-arming (default 2)"),
      trigger_level: z.string().optional().describe("Trigger level override, e.g. '3.0V'"),
      configure_trigger: z
        .boolean()
        .optional()
        .describe("Set up the edge trigger automatically (default true); false keeps your trigger settings"),
      log_csv: z
        .string()
        .optional()
        .describe("Write every decoded frame to this new .csv file (never overwrites an existing file)"),
    },
    { readOnlyHint: false },
    async (args) => {
      try {
        await connection.checkChannel(args.channel);
        const s = await startSession({
          channel: args.channel,
          signal: args.signal ?? "CAN_H",
          baud: args.baud,
          durationS: args.duration_s,
          maxCaptures: args.max_captures,
          triggerTimeoutS: args.trigger_timeout_s,
          triggerLevel: args.trigger_level,
          configureTrigger: args.configure_trigger,
          logPath: args.log_csv,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `CAN monitor ${s.id} started on ${args.channel}. Poll can_monitor_status for results.`,
            },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "can_monitor_status",
    "Get the current summary of a CAN monitoring session: bit rate, frame/error counts, and a per-ID table.",
    {
      session: z.string().optional().describe("Session id (default: the active or most recent session)"),
      recent_frames: z
        .number()
        .int()
        .min(0)
        .max(200)
        .optional()
        .describe("Also return the last N decoded frames (default 0)"),
    },
    { readOnlyHint: true },
    async ({ session, recent_frames }) => {
      const s = getSession(session);
      if (!s) return errorResult(new Error("No CAN monitor session. Start one with can_monitor_start."));
      try {
        return { content: [{ type: "text" as const, text: JSON.stringify(s.summary(recent_frames ?? 0), null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "can_monitor_stop",
    "Stop a CAN monitoring session, restore the trigger settings, and return the final summary.",
    {
      session: z.string().optional().describe("Session id (default: the active or most recent session)"),
    },
    { readOnlyHint: false },
    async ({ session }) => {
      const s = getSession(session);
      if (!s) return errorResult(new Error("No CAN monitor session to stop."));
      try {
        await s.stop();
        return { content: [{ type: "text" as const, text: JSON.stringify(s.summary(), null, 2) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

const armParam = z
  .boolean()
  .optional()
  .describe("Arm a new single acquisition and wait for traffic first (default false: use the record in memory)");

const baudParam = z
  .number()
  .int()
  .min(5000)
  .max(1_000_000)
  .optional()
  .describe("Known bit rate in bit/s; measured from the traffic when omitted");

async function maybeArm(arm: boolean | undefined, timeoutS = 5): Promise<void> {
  if (arm && !(await armAndWait(timeoutS * 1000))) {
    throw new Error(`no trigger within ${timeoutS} s — is there traffic, and does the trigger match it?`);
  }
}

function hexId(id: number, extended: boolean): string {
  return "0x" + id.toString(16).toUpperCase().padStart(extended ? 8 : 3, "0");
}

function errorResult(err: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

function fmtBaud(b: number): string {
  if (b >= 1e6) return `${(b / 1e6).toFixed(3).replace(/\.?0+$/, "")} Mbit/s`;
  return `${(b / 1e3).toFixed(3).replace(/\.?0+$/, "")} kbit/s`;
}
