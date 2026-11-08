import { connection } from "./connection.js";

const POLL_MS = 50;

/**
 * Arm a single-shot acquisition and wait until it has triggered and finished.
 * Returns false if nothing triggered within `timeoutMs` (the scope is then
 * stopped, so the previous record stays in memory).
 *
 * Completion is detected two ways because firmware differs: INR? bit 0 ("new
 * signal acquired", cleared on read), or SAST? reading "Stop" after it was
 * seen armed. Either is enough.
 */
export async function armAndWait(timeoutMs: number): Promise<boolean> {
  await connection.query("INR?"); // clear the latched bits
  await connection.sendCommand("TRMD SINGLE");
  await connection.sendCommand("ARM");

  const deadline = Date.now() + timeoutMs;
  let sawArmed = false;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const inr = parseInt(await connection.query("INR?"), 10);
    if (Number.isFinite(inr) && (inr & 1) !== 0) return true;
    const sast = await connection.query("SAST?");
    if (/stop/i.test(sast)) {
      if (sawArmed) return true;
    } else {
      sawArmed = true;
    }
  }
  await connection.sendCommand("STOP");
  return false;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
