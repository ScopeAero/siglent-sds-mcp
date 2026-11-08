import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { once } from "node:events";
import { armAndWait } from "../acquire.js";
import { captureWaveform, type CapturedWaveform } from "./waveform.js";

const channelEnum = z.enum(["C1", "C2", "C3", "C4"]);

export function registerCaptureTools(server: McpServer): void {
  server.tool(
    "capture",
    "Arm a single-shot acquisition, wait for the trigger, and download one or more channels from that same acquisition (time-aligned). " +
      "Returns compact per-channel statistics rather than raw points; set save_csv to write the full-resolution data to a file for offline analysis. " +
      "Leaves the scope stopped on the captured record.",
    {
      channels: z
        .array(channelEnum)
        .min(1)
        .describe("Channels to download, e.g. ['C1','C2']"),
      arm: z
        .boolean()
        .optional()
        .describe(
          "Arm a new single acquisition and wait for it (default true). False reads the record already in memory."
        ),
      timeout_s: z
        .number()
        .positive()
        .optional()
        .describe("How long to wait for a trigger (default 5 s)"),
      save_csv: z
        .string()
        .optional()
        .describe(
          "Write time plus one column per channel at full resolution to this file path"
        ),
    },
    { readOnlyHint: false },
    async ({ channels, arm, timeout_s, save_csv }) => {
      try {
        if (arm !== false) {
          const triggered = await armAndWait((timeout_s ?? 5) * 1000);
          if (!triggered) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: no trigger within ${timeout_s ?? 5} s. Check the trigger source/level, or use arm=false to read the record in memory.`,
                },
              ],
              isError: true,
            };
          }
        }

        const waves: CapturedWaveform[] = [];
        for (const ch of channels) waves.push(await captureWaveform(ch));

        const first = waves[0];
        const result: Record<string, unknown> = {
          sample_rate: first.sampleRate,
          points: first.voltages.length,
          time_start_s: first.startTime,
          time_end_s: first.startTime + first.voltages.length / first.sampleRate,
          channels: Object.fromEntries(
            channels.map((ch, i) => [ch, summarize(waves[i].voltages)])
          ),
        };

        if (save_csv) {
          const path = resolve(save_csv);
          await writeCsv(path, channels, waves);
          result.csv = path;
        }

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
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
}

export function summarize(v: Float32Array) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
    sum += x;
    sumSq += x * x;
  }
  const n = v.length || 1;
  const r = (x: number) => Number(x.toPrecision(5));
  return {
    min: r(min),
    max: r(max),
    pkpk: r(max - min),
    mean: r(sum / n),
    rms: r(Math.sqrt(sumSq / n)),
  };
}

async function writeCsv(
  path: string,
  channels: string[],
  waves: CapturedWaveform[]
): Promise<void> {
  const out = createWriteStream(path);
  const failed = once(out, "error").then(([e]) => {
    throw e;
  });
  failed.catch(() => {}); // surfaced through the races below, not as unhandled

  const { sampleRate, startTime } = waves[0];
  const n = Math.max(...waves.map((w) => w.voltages.length));
  out.write(`time_s,${channels.map((c) => `${c}_V`).join(",")}\n`);
  const CHUNK = 10_000;
  for (let i = 0; i < n; i += CHUNK) {
    let block = "";
    for (let j = i; j < Math.min(n, i + CHUNK); j++) {
      block += (startTime + j / sampleRate).toPrecision(9);
      for (const w of waves) {
        block += j < w.voltages.length ? `,${w.voltages[j].toPrecision(5)}` : ",";
      }
      block += "\n";
    }
    // Respect backpressure so a 14 Mpt capture doesn't buffer in memory
    if (!out.write(block)) await Promise.race([once(out, "drain"), failed]);
  }
  out.end();
  await Promise.race([once(out, "finish"), failed]);
}
