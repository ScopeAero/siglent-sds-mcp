import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestServer, callTool, getText } from "../helpers.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { synthCan, toScopeCodes } from "../can-synth.js";

const VDIV = 0.5; // V/div → 0.02 V per ADC code
const OFST = -3.0; // centres 2.5–3.5 V CAN_H on screen

const toCodes = (v: Float64Array) => toScopeCodes(v, VDIV, OFST);

const mockConnection = vi.hoisted(() => ({
  isConnected: vi.fn(() => true),
  getConnectionInfo: vi.fn(() => "192.168.1.126:5025"),
  connect: vi.fn(async () => "Siglent,SDS1104X-E,SDS1ECAX12345,8.2.6.1.37R1"),
  disconnect: vi.fn(),
  checkChannel: vi.fn(async () => {}),
  sendCommand: vi.fn(async () => {}),
  query: vi.fn(async () => ""),
  queryBinary: vi.fn(async () => Buffer.alloc(0)),
}));

vi.mock("../../src/connection.js", () => ({
  connection: mockConnection,
}));

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

function scopeReturns(wave: Float64Array, sampleRate: number) {
  mockConnection.query.mockImplementation(async (cmd: string) => {
    const responses: Record<string, string> = {
      "C2:VDIV?": String(VDIV),
      "C2:OFST?": String(OFST),
      "TDIV?": "1.00E-03",
      "SARA?": sampleRate.toExponential(2),
      "TRDL?": "0.00E+00",
    };
    return responses[cmd] ?? "";
  });
  const codes = toCodes(wave);
  mockConnection.queryBinary.mockImplementation(async (cmd: string) =>
    cmd === "C2:WF? DAT2" ? codes : Buffer.alloc(0)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("detect_can_baud", () => {
  it("detects 500 kbit/s from the scope's 8-bit capture", async () => {
    scopeReturns(synthCan({ baud: 500_000, sampleRate: 25e6, noise: 0.02 }), 25e6);
    const result = await callTool(client, "detect_can_baud", { channel: "C2" });
    const text = getText(result);
    expect(result.isError).toBeFalsy();
    const json = JSON.parse(text.slice(text.indexOf("{")));
    expect(Math.abs(json.measured_baud - 500_000) / 500_000).toBeLessThan(0.002);
    expect(json.probable_signal).toBe("CAN_H or differential");
  });

  it("configures the decode bus when asked", async () => {
    scopeReturns(synthCan({ baud: 250_000, sampleRate: 25e6 }), 25e6);
    await callTool(client, "detect_can_baud", { channel: "C2", apply_to_decoder: "B1" });
    const sent = mockConnection.sendCommand.mock.calls.map((c) => c[0]);
    const dccn = sent.find((c: string) => c.startsWith("B1:DCCN"));
    expect(dccn).toMatch(/CANH,C2,CANHT,[\d.]+V,SRC,CAN_H,BAUD,250000/);
    expect(sent).toContain("DCST ON");
  });

  it("reports a flat channel as an error", async () => {
    scopeReturns(new Float64Array(10_000).fill(2.5), 25e6);
    const result = await callTool(client, "detect_can_baud", { channel: "C2" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/flat/);
  });
});

describe("can_decode", () => {
  it("decodes frames from the record in memory", async () => {
    scopeReturns(
      synthCan({ baud: 250_000, sampleRate: 25e6, frames: 8, extendedRatio: 0.5, seed: 5 }),
      25e6
    );
    const result = await callTool(client, "can_decode", { channel: "C2", max_frames: 3 });
    expect(result.isError).toBeFalsy();
    const json = JSON.parse(getText(result));
    expect(json.baud_source).toBe("measured");
    expect(Math.abs(json.baud - 250_000)).toBeLessThan(500);
    expect(json.frames_decoded).toBe(8);
    expect(json.frame_errors).toBe(0);
    expect(json.frames).toHaveLength(3);
    expect(json.frames_omitted).toBe(5);
    expect(json.frames[0]).toMatchObject({ id: expect.stringMatching(/^0x[0-9A-F]+$/) });
  });

  it("uses a given bit rate instead of measuring", async () => {
    scopeReturns(synthCan({ baud: 125_000, sampleRate: 10e6, frames: 4 }), 10e6);
    const json = JSON.parse(
      getText(await callTool(client, "can_decode", { channel: "C2", baud: 125_000 }))
    );
    expect(json).toMatchObject({ baud: 125_000, baud_source: "given", frames_decoded: 4 });
  });
});
