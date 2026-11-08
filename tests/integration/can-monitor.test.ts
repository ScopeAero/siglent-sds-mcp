import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestServer, callTool, getText } from "../helpers.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { synthCanFrames, toScopeCodes, type SynthFrame } from "../can-synth.js";

const VDIV = 0.5;
const OFST = -3.0;
const SARA = 25e6;

/**
 * Fake scope: a single-shot ARM "triggers" immediately and loads the next
 * synthetic capture into memory. Frame 0x100 counts in byte 1; 0x200 is static.
 */
const scope = vi.hoisted(() => ({
  armed: false,
  captureNo: 0,
  memory: Buffer.alloc(0),
  sent: [] as string[],
  next: (_n: number): Buffer => Buffer.alloc(0),
}));

function capturesFor(n: number): Buffer {
  const frameList: SynthFrame[] = [];
  for (let k = 0; k < 6; k++) {
    frameList.push({ id: 0x100, data: [0xaa, n * 6 + k, 0x55] });
    frameList.push({ id: 0x200, data: [1, 2, 3, 4, 5, 6, 7, 8] });
  }
  frameList.push({ id: 0x18fef100, extended: true, data: [0x10, 0x20] });
  const { samples } = synthCanFrames({ baud: 500_000, sampleRate: SARA, frameList, seed: n + 1 });
  return toScopeCodes(samples, VDIV, OFST);
}

const mockConnection = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  getConnectionInfo: vi.fn(() => "192.168.1.126:5025"),
  connect: vi.fn(async () => "Siglent,SDS1104X-E,SDS1ECAX12345,8.2.6.1.37R1"),
  disconnect: vi.fn(),
  checkChannel: vi.fn(async () => {}),
  sendCommand: vi.fn(async (cmd: string) => {
    scope.sent.push(cmd);
    if (cmd === "ARM") {
      scope.memory = scope.next(scope.captureNo++);
      scope.armed = true;
    }
  }),
  query: vi.fn(async (cmd: string) => {
    if (cmd === "INR?") {
      const v = scope.armed ? "8193" : "0";
      scope.armed = false;
      return v;
    }
    const responses: Record<string, string> = {
      "SAST?": "Stop",
      "C2:VDIV?": String(VDIV),
      "C2:OFST?": String(OFST),
      "TDIV?": "1.00E-04",
      "SARA?": SARA.toExponential(2),
      "TRDL?": "0.00E+00",
      "TRSE?": "EDGE,SR,C1,HT,OFF",
      "TRMD?": "AUTO",
      "C1:TRLV?": "1.50E-01",
      "C1:TRSL?": "POS",
      "C2:TRLV?": "0.00E+00",
      "C2:TRSL?": "NEG",
    };
    return responses[cmd] ?? "";
  }),
  queryBinary: vi.fn(async () => scope.memory),
}));

vi.mock("../../src/connection.js", () => ({ connection: mockConnection }));

let client: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const ctx = await createTestServer();
  client = ctx.client;
  cleanup = ctx.cleanup;
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  scope.armed = false;
  scope.captureNo = 0;
  scope.sent = [];
  scope.next = capturesFor;
});

async function runToCompletion(args: Record<string, unknown>) {
  const start = await callTool(client, "can_monitor_start", args);
  expect(start.isError).toBeFalsy();
  return waitUntilStopped();
}

/** Poll status until the session ends on its own (max_captures / duration) */
async function waitUntilStopped() {
  for (let i = 0; i < 200; i++) {
    const status = JSON.parse(getText(await callTool(client, "can_monitor_status", {})));
    if (status.state !== "running") return status;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("session did not stop");
}

describe("CAN monitor session", () => {
  it("decodes captures in the background and summarises per ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "can-mon-"));
    const log = join(dir, "frames.csv");
    const summary = await runToCompletion({
      channel: "C2",
      max_captures: 3,
      log_csv: log,
    });

    expect(summary.captures).toBe(3);
    expect(summary.baud.measured).toBeGreaterThan(499_000);
    expect(summary.baud.measured).toBeLessThan(501_000);
    expect(summary.baud.standard).toBe(500_000);
    expect(summary.frames.ok).toBe(39);
    expect(summary.frames.errors).toEqual({});

    const byId = Object.fromEntries(summary.ids.map((r: { id: string }) => [r.id, r]));
    expect(byId["0x100"]).toMatchObject({ count: 18, dlc: 3, changing: "-X-" });
    expect(byId["0x200"]).toMatchObject({ count: 18, changing: "--------" });
    expect(byId["0x200"].period_ms).toBeGreaterThan(0);
    expect(byId["0x18FEF100"]).toMatchObject({ count: 3, data: "10 20" });

    const csv = (await readFile(log, "utf8")).trim().split("\n");
    expect(csv).toHaveLength(1 + 39);
    expect(csv[1]).toMatch(/^1,[-\d.e]+,0x100,0,0,3,aa0055,1,1,$/);
  });

  it("sets a start-of-frame trigger and restores the old one on stop", async () => {
    await runToCompletion({ channel: "C2", max_captures: 1, signal: "CAN_H" });
    const sent = scope.sent;
    expect(sent).toContain("TRSE EDGE,SR,C2,HT,OFF");
    expect(sent).toContain("C2:TRLV 3.0V");
    expect(sent).toContain("C2:TRSL POS");
    // Restored afterwards: C2's own settings, then the original source and mode
    const restoreStart = sent.indexOf("C2:TRLV 0.00E+00");
    expect(restoreStart).toBeGreaterThan(sent.indexOf("C2:TRLV 3.0V"));
    expect(sent.slice(restoreStart)).toEqual([
      "C2:TRLV 0.00E+00",
      "C2:TRSL NEG",
      "C1:TRLV 1.50E-01",
      "C1:TRSL POS",
      "TRSE EDGE,SR,C1,HT,OFF",
      "TRDL 0.00E+00",
      "TRMD AUTO",
    ]);
  });

  it("counts trigger timeouts when the bus is quiet", async () => {
    // Quiet bus: ARM never latches a new acquisition
    const sendImpl = mockConnection.sendCommand.getMockImplementation()!;
    mockConnection.sendCommand.mockImplementation(async (cmd: string) => {
      scope.sent.push(cmd);
    });
    const queryImpl = mockConnection.query.getMockImplementation()!;
    mockConnection.query.mockImplementation(async (cmd: string) =>
      cmd === "SAST?" ? "Ready" : queryImpl(cmd)
    );
    try {
      const summary = await runToCompletion({
        channel: "C2",
        trigger_timeout_s: 0.1,
        duration_s: 0.35,
        configure_trigger: false,
      });
      expect(summary.state).toBe("stopped");
      expect(summary.stop_reason).toMatch(/duration/);
      expect(summary.captures).toBe(0);
      expect(summary.trigger_timeouts).toBeGreaterThanOrEqual(2);
      expect(scope.sent.filter((c) => c === "STOP").length).toBe(summary.trigger_timeouts);
    } finally {
      mockConnection.sendCommand.mockImplementation(sendImpl);
      mockConnection.query.mockImplementation(queryImpl);
    }
  });

  it("refuses a second session while one is running", async () => {
    await callTool(client, "can_monitor_start", { channel: "C2", configure_trigger: false });
    const second = await callTool(client, "can_monitor_start", { channel: "C2" });
    expect(second.isError).toBe(true);
    expect(getText(second)).toMatch(/already running/);
    await callTool(client, "can_monitor_stop", {});
  });

  it("returns recent frames on request", async () => {
    await runToCompletion({ channel: "C2", max_captures: 1 });
    const status = JSON.parse(
      getText(await callTool(client, "can_monitor_status", { recent_frames: 3 }))
    );
    expect(status.recent_frames).toHaveLength(3);
    expect(status.recent_frames[2]).toMatchObject({ id: "0x18FEF100", data: "10 20" });
  });
});
