import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config, paths } from "../config.js";
import { appendJsonl, logEvent, readReports } from "../feedback/index.js";
import { getGraph } from "../graph/index.js";
import { DocumentStore } from "../retrieval/documents.js";
import { Retriever } from "../retrieval/retriever.js";
import { REPORT_INSTRUCTIONS, SERVER_INSTRUCTIONS, mcpTools, runMcpTool, type McpContext } from "./tools.js";

/**
 * The MCP server: the knowledge base's retrieval layer over stdio, for Claude Code and the Claude
 * desktop app (see src/mcp/tools.ts for what it exposes and why generation is left out).
 *
 * Two rules the transport imposes:
 *  - stdout carries JSON-RPC frames, so nothing else may be written to it. `src/cli/mcp.ts` points
 *    console.* at stderr before this module is even imported.
 *  - `initialize` must answer promptly, so the index, the document store and the graph are opened
 *    on the first tool call rather than at startup (opening LanceDB and the BM25 index takes a
 *    moment, and a client that only lists tools should not pay for it).
 *
 * Every tool call is also logged to data/feedback/events.jsonl (FEEDBACK_EVENTS), under a session id
 * that is this process — one per client connection — so a later review can follow one agent's
 * searches in order and join them with the reports it filed (see src/feedback).
 */

async function packageVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** True when `data/graph.json.gz` exists, which is what makes `related` worth advertising. */
async function graphOnDisk(): Promise<boolean> {
  try {
    await stat(paths.graph);
    return config.graph.enabled;
  } catch {
    return false;
  }
}

let contextPromise: Promise<McpContext> | null = null;

function kbContext(): Promise<McpContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const [searcher, store] = await Promise.all([Retriever.open(), DocumentStore.open()]);
      const stats = await searcher.stats();
      process.stderr.write(
        `ai-wiki mcp: ${stats.chunks} chunks, ${store.size} documents, ${config.embedding.model} @ ${config.ollama.host}\n`,
      );
      return { searcher, store, graph: () => (config.graph.enabled ? getGraph() : Promise.resolve(null)) };
    })().catch((err) => {
      // Do not cache a failure: Ollama may be down, or the index not built yet, and both are fixed
      // without restarting the server.
      contextPromise = null;
      throw err;
    });
  }
  return contextPromise;
}

export async function startMcpServer(): Promise<void> {
  const report = config.feedback.reportTool;
  const server = new Server(
    { name: "ai-wiki", version: await packageVersion() },
    { capabilities: { tools: {} }, instructions: report ? `${SERVER_INSTRUCTIONS} ${REPORT_INSTRUCTIONS}` : SERVER_INSTRUCTIONS },
  );

  const session = randomUUID();
  let seq = 0;
  /** "name/version" as the client introduced itself in `initialize`. */
  const client = (): string | null => {
    const info = server.getClientVersion();
    return info ? `${info.name}/${info.version}` : null;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools({ graph: await graphOnDisk(), report }) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const started = Date.now();
    let ctx: McpContext;
    try {
      ctx = await kbContext();
    } catch (err) {
      const message = (err as Error).message;
      process.stderr.write(`ai-wiki mcp: cannot open the knowledge base: ${message}\n`);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `The ai-wiki knowledge base is not available: ${message}\n` +
              `Check that Ollama is running (${config.ollama.host}) and that the index has been built ` +
              `(\`npm run ingest\` in ${process.cwd()}).`,
          },
        ],
      };
    }

    const callArgs = (args ?? {}) as Record<string, unknown>;
    const result = await runMcpTool(name, callArgs, {
      ...ctx,
      ...(report
        ? { feedback: { session, client: client(), append: (r) => appendJsonl(paths.feedbackReports, r), existing: () => readReports(paths.feedbackReports) } }
        : {}),
    });
    const ms = Date.now() - started;
    process.stderr.write(
      `ai-wiki mcp: ${name}(${JSON.stringify(callArgs).slice(0, 160)}) → ${result.isError ? "error, " : ""}${result.text.length} chars in ${ms}ms\n`,
    );
    await logEvent({
      ts: new Date(started).toISOString(),
      event: name,
      session,
      seq: ++seq,
      client: client(),
      ms,
      // A recorded report's text is in reports.jsonl already, and its trace says which one; a refused
      // one keeps its args, since they are the only trace of what the agent tried to file.
      args: name === "report" && !result.isError ? {} : callArgs,
      ...(result.trace ? { result: result.trace } : {}),
      ...(result.isError ? { error: result.text.slice(0, 300) } : {}),
    });
    return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) };
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`ai-wiki mcp: ready on stdio (kb=${config.kbDir}, data=${config.dataDir})\n`);
}
