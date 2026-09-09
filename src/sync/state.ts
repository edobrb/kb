import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SyncState } from "./types.js";

export function emptyState(source: string): SyncState {
  return { version: 1, source, lastRunAt: null, items: {}, meta: {} };
}

export function stateFile(stateDir: string, source: string): string {
  return path.join(stateDir, `${source}.json`);
}

export async function readState(stateDir: string, source: string): Promise<SyncState | null> {
  try {
    const raw = await readFile(stateFile(stateDir, source), "utf8");
    const s = JSON.parse(raw) as SyncState;
    if (s.version !== 1 || typeof s.items !== "object") return null;
    s.meta ??= {};
    return s;
  } catch {
    return null;
  }
}

export async function writeState(stateDir: string, state: SyncState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const file = stateFile(stateDir, state.source);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, file);
}
