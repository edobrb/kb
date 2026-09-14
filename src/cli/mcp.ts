/**
 * `npm run mcp` — the knowledge base as an MCP server on stdio, for Claude Code / Claude Desktop.
 * Retrieval only: search, fetch_document, related (see src/mcp/tools.ts).
 *
 * Two things have to happen before anything imports the config, which is why this entry point is
 * separate and the real server is imported dynamically (static imports are hoisted above all
 * statements, dynamic ones are not):
 *
 *  1. cwd. config.ts resolves KB_DIR / DATA_DIR and dotenv reads .env against process.cwd(), and an
 *     MCP client spawns its servers from wherever it happens to be running — the user's other
 *     project, or `/`. So move to the project root first; the server then works from any cwd.
 *  2. stdout. It carries the JSON-RPC frames, and one stray `console.log` from anywhere in the
 *     process would corrupt the stream, so console output is pointed at stderr (where MCP clients
 *     collect server logs) for good.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    `Usage: npm run mcp\n\n` +
      `Speaks the Model Context Protocol on stdin/stdout, exposing the knowledge base as three\n` +
      `read-only tools: search, fetch_document, related. Meant to be spawned by an MCP client:\n\n` +
      `  claude mcp add ai-wiki --scope user -- ${root}/node_modules/.bin/tsx ${root}/src/cli/mcp.ts\n\n` +
      `Needs the index (\`npm run ingest\`) and, for query embeddings, Ollama running.\n`,
  );
  process.exit(0);
}

process.chdir(root);

const toStderr = (...parts: unknown[]): void => {
  process.stderr.write(`${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`);
};
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

const { startMcpServer } = await import("../mcp/server.js");

try {
  await startMcpServer();
} catch (err) {
  process.stderr.write(`ai-wiki mcp: failed to start — ${(err as Error).message}\n`);
  process.exit(1);
}
