import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SERVER_NAME,
  bundleFile,
  desktopConfigPath,
  formatConfig,
  mergeServer,
  parseDesktopConfig,
  serverEntry,
  type DesktopConfig,
} from "../mcp/desktop-config.js";
import { flagString, parseArgs } from "./args.js";

/**
 * `npm run mcp:install` — register this knowledge base with Claude Desktop.
 *
 * Claude Desktop reads `claude_desktop_config.json` at startup and that one file also holds the
 * app's own settings and any other MCP server, so the entry is merged in and the previous file is
 * backed up first. `--print` / `--out` cover the other half of the question: a standalone file to
 * copy, paste or hand to another machine.
 */

const { flags } = parseArgs();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const name = flagString(flags, "name") ?? DEFAULT_SERVER_NAME;
const entry = serverEntry(root);

if (flags["help"]) {
  console.log(`Usage: npm run mcp:install [-- --print | --out <file>] [--config <path>] [--name ${DEFAULT_SERVER_NAME}] [--dry-run]

Registers the ai-wiki MCP server (retrieval only: search, fetch_document, related) with Claude Desktop
by merging an "mcpServers" entry into its configuration file, keeping every other setting and every
other server in that file untouched. The previous file is backed up next to it.

  --print        print the entry as JSON and write nothing
  --out <file>   write a standalone one-server file (to copy by hand, or take to another machine)
  --config <p>   merge into this file instead of the platform default
  --name <n>     name to register the server under (default: ${DEFAULT_SERVER_NAME})
  --dry-run      report what would change, write nothing

Claude Code is registered separately: see \`npm run mcp -- --help\`.`);
  process.exit(0);
}

if (flags["print"]) {
  console.log(formatConfig(bundleFile(entry, name)).trimEnd());
  process.exit(0);
}

const outFile = flagString(flags, "out");
if (outFile) {
  const target = path.resolve(outFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, formatConfig(bundleFile(entry, name)), "utf8");
  console.log(`Wrote ${target}`);
  console.log(
    `This is a one-server file. Claude Desktop's own configuration usually holds other settings too,\n` +
      `so merge it rather than copying it over: \`npm run mcp:install\` does exactly that.`,
  );
  process.exit(0);
}

const configFile = path.resolve(flagString(flags, "config") ?? desktopConfigPath());
const dryRun = Boolean(flags["dry-run"]);

let current: DesktopConfig | null = null;
try {
  current = parseDesktopConfig(await readFile(configFile, "utf8"), configFile);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
    console.error((err as Error).message);
    process.exit(1);
  }
  console.log(`No configuration at ${configFile} yet — it will be created.`);
}

const { config, previous, unchanged, otherServers } = mergeServer(current, entry, name);

console.log(`Config:  ${configFile}`);
console.log(`Server:  ${name}`);
console.log(`Command: ${entry.command} ${entry.args.join(" ")}`);
if (otherServers.length) console.log(`Keeping: ${otherServers.join(", ")} (and every other setting in the file)`);

if (unchanged) {
  console.log(`\nAlready registered exactly like this — nothing to do.`);
  process.exit(0);
}
if (previous) console.log(`Replacing the existing "${name}" entry: ${previous.command} ${previous.args.join(" ")}`);

if (dryRun) {
  console.log(`\n--dry-run: nothing written. The merged file would be:\n`);
  console.log(formatConfig(config).trimEnd());
  process.exit(0);
}

if (current) {
  const backup = `${configFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  await copyFile(configFile, backup);
  console.log(`Backup:  ${backup}`);
}
await mkdir(path.dirname(configFile), { recursive: true });
await writeFile(configFile, formatConfig(config), "utf8");

console.log(`\nRegistered. Quit Claude Desktop completely (⌘Q, not just the window) and start it again;`);
console.log(`the three tools then show up under the tools icon in a new chat.`);
console.log(`It needs Ollama running and the index built (\`npm run ingest\` in ${root}).`);
