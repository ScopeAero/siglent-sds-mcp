import { open, type FileHandle } from "node:fs/promises";
import { extname, resolve } from "node:path";

/**
 * Create a new CSV output file for a tool. Paths come from the MCP client,
 * i.e. ultimately from a model that may be acting on injected instructions,
 * so this only ever *creates* files: it requires a .csv extension and opens
 * with O_CREAT|O_EXCL ("wx"), which refuses existing files and symlinks
 * rather than truncating or appending to them.
 */
export async function createCsvFile(
  path: string
): Promise<{ path: string; handle: FileHandle }> {
  const abs = resolve(path);
  if (extname(abs).toLowerCase() !== ".csv") {
    throw new Error(`Output file must have a .csv extension: ${abs}`);
  }
  try {
    return { path: abs, handle: await open(abs, "wx") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${abs} already exists; choose a new file name (existing files are never overwritten)`);
    }
    throw err;
  }
}
