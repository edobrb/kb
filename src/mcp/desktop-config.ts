import path from "node:path";

/**
 * Registering the MCP server with Claude Desktop.
 *
 * Claude Desktop has no "import a server" dialog: it reads one JSON file at startup, and that file
 * also holds the app's own settings (deployment mode, preferences, folder grants…) plus any other
 * MCP server already registered. So the configuration is *merged* into it, never written over it —
 * dropping a bare `{ "mcpServers": … }` document on top would silently delete the rest.
 *
 * This module is the pure half of `npm run mcp:install`: where the file lives, what our entry looks
 * like and how it folds into an existing document. The CLI does the reading, backing up and writing.
 */

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The shape we care about; every other key of the file is carried through untouched. */
export interface DesktopConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export const DEFAULT_SERVER_NAME = "ai-wiki";

/**
 * Where Claude Desktop keeps that file. Windows/Linux are here for completeness — the app is
 * macOS/Windows only, but a config written on one machine is readable on another.
 */
export function desktopConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = env["HOME"] ?? env["USERPROFILE"] ?? "",
): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

/**
 * The entry itself.
 *
 * `command` is the *absolute* path of a Node binary and not `node`, `npx` or the `tsx` shim: the
 * desktop app starts its servers from launchd with a minimal PATH, where none of those resolve —
 * and `node_modules/.bin/tsx` is a `#!/usr/bin/env node` script, so it fails for the same reason.
 * Running tsx's own entry point through that Node avoids the whole question. Every path is absolute
 * because the app spawns servers from an arbitrary working directory (src/cli/mcp.ts then moves to
 * the project root itself, which is why no `env` is needed here: `.env` is read from there).
 */
export function serverEntry(projectRoot: string, nodeBin: string = process.execPath, env?: Record<string, string>): McpServerEntry {
  return {
    command: nodeBin,
    args: [path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(projectRoot, "src", "cli", "mcp.ts")],
    ...(env && Object.keys(env).length ? { env } : {}),
  };
}

/** The standalone one-server document: what `--out` writes and what another machine can be handed. */
export function bundleFile(entry: McpServerEntry, name = DEFAULT_SERVER_NAME): DesktopConfig {
  return { mcpServers: { [name]: entry } };
}

export interface MergeResult {
  config: DesktopConfig;
  /** What was registered under this name before, when anything was. */
  previous: McpServerEntry | null;
  /** True when the file already said exactly this, so writing it would change nothing. */
  unchanged: boolean;
  /** The other servers in the file, which the merge leaves alone. */
  otherServers: string[];
}

/** Fold our entry into an existing config, preserving every other key and every other server. */
export function mergeServer(current: DesktopConfig | null, entry: McpServerEntry, name = DEFAULT_SERVER_NAME): MergeResult {
  const servers = { ...(current?.mcpServers ?? {}) };
  const previous = servers[name] ?? null;
  const unchanged = previous !== null && JSON.stringify(previous) === JSON.stringify(entry);
  servers[name] = entry;
  return {
    config: { ...(current ?? {}), mcpServers: servers },
    previous,
    unchanged,
    otherServers: Object.keys(servers).filter((k) => k !== name),
  };
}

/**
 * Parse a config file. An unreadable one is reported rather than replaced: the file holds settings
 * this project did not write, so "it did not parse, so I rewrote it" is not an acceptable outcome.
 */
export function parseDesktopConfig(raw: string, file: string): DesktopConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix or move it, then run this again.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} does not contain a JSON object.`);
  }
  return parsed as DesktopConfig;
}

/** 2-space JSON with a trailing newline — the format the app itself writes. */
export function formatConfig(config: DesktopConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}
