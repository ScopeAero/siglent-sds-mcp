import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestServer, callTool, getText } from "../helpers.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const state = vi.hoisted(() => ({ triggered: false, latch: true, sent: [] as string[] }));

const mockConnection = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  getConnectionInfo: vi.fn(() => "192.168.1.126:5025"),
  connect: vi.fn(async () => ""),
  disconnect: vi.fn(),
  checkChannel: vi.fn(async () => {}),
  sendCommand: vi.fn(async (cmd: string) => {
    state.sent.push(cmd);
    if (cmd === "ARM" && state.latch) state.triggered = true;
  }),
  query: vi.fn(async (cmd: string) => {
    if (cmd === "INR?") {
      const v = state.triggered ? "1" : "0";
      state.triggered = false;
      return v;
    }
    const r: Record<string, string> = {
      "SAST?": "Ready",
      "C1:VDIV?": "1.00E+00",
      "C1:OFST?": "0.00E+00",
      "C2:VDIV?": "2.00E+00",
      "C2:OFST?": "0.00E+00",
      "TDIV?": "1.00E-06",
      "SARA?": "1.00E+06",
      "TRDL?": "0.00E+00",
    };
    return r[cmd] ?? "";
  }),
  // C1: codes 0,25,50 → 0,1,2 V; C2 (2 V/div): 25,25,25 → 2 V
  queryBinary: vi.fn(async (cmd: string) =>
    cmd === "C1:WF? DAT2" ? Buffer.from([0, 25, 50]) : Buffer.from([25, 25, 25])
  ),
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
  state.triggered = false;
  state.latch = true;
  state.sent = [];
  mockConnection.queryBinary.mockClear();
});

describe("capture", () => {
  it("arms, waits for the trigger, and summarises each channel", async () => {
    const result = await callTool(client, "capture", { channels: ["C1", "C2"] });
    expect(result.isError).toBeFalsy();
    const json = JSON.parse(getText(result));
    expect(state.sent.slice(0, 2)).toEqual(["TRMD SINGLE", "ARM"]);
    expect(json.points).toBe(3);
    expect(json.channels.C1).toMatchObject({ min: 0, max: 2, pkpk: 2, mean: 1 });
    expect(json.channels.C2).toMatchObject({ min: 2, max: 2, mean: 2 });
    expect(json).not.toHaveProperty("data");
  });

  it("writes full-resolution CSV on request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-"));
    const path = join(dir, "cap.csv");
    const json = JSON.parse(
      getText(await callTool(client, "capture", { channels: ["C1", "C2"], save_csv: path }))
    );
    expect(json.csv).toBe(path);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines[0]).toBe("time_s,C1_V,C2_V");
    expect(lines).toHaveLength(4);
    expect(lines[2].split(",").slice(1).map(Number)).toEqual([1, 2]);
  });

  it("never overwrites an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-"));
    const path = join(dir, "keep.csv");
    await writeFile(path, "precious\n");
    const result = await callTool(client, "capture", { channels: ["C1"], save_csv: path });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/already exists/);
    expect(await readFile(path, "utf8")).toBe("precious\n");
  });

  it("refuses output files without a .csv extension", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-"));
    const result = await callTool(client, "capture", {
      channels: ["C1"],
      save_csv: join(dir, ".zshrc"),
    });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/\.csv extension/);
  });

  it("reports no trigger and stops the scope on timeout", async () => {
    state.latch = false;
    const result = await callTool(client, "capture", { channels: ["C1"], timeout_s: 0.15 });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/no trigger/);
    expect(state.sent).toContain("STOP");
    expect(mockConnection.queryBinary).not.toHaveBeenCalledWith("C1:WF? DAT2");
  });

  it("reads the record in memory with arm=false", async () => {
    await callTool(client, "capture", { channels: ["C1"], arm: false });
    expect(state.sent).not.toContain("ARM");
  });
});
