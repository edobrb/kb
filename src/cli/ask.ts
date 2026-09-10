import { ask } from "../generation/ask.js";
import type { Authority, ChatMessage } from "../types.js";
import { flagList, flagString, parseArgs } from "./args.js";

const { flags, positional } = parseArgs();
const question = positional.join(" ").trim();

if (!question || flags["help"]) {
  console.log(`Usage: npm run ask -- "your question" [--k 6] [--source-type adr,gitlab] [--kind code,doc] [--authority binding] [--lang en] [--json]

Runs the full pipeline: hybrid retrieval -> Ollama chat model -> answer with [n] citations.`);
  process.exit(question ? 0 : 1);
}

const messages: ChatMessage[] = [{ role: "user", content: question }];
const req = {
  messages,
  topK: flags["k"] ? Number(flagString(flags, "k")) : undefined,
  filters: {
    sourceTypes: flagList(flags, "source-type"),
    kinds: flagList(flags, "kind"),
    authorities: flagList(flags, "authority") as Authority[] | undefined,
    langs: flagList(flags, "lang"),
  },
};

if (flags["json"]) {
  const { askOnce } = await import("../generation/ask.js");
  console.log(JSON.stringify(await askOnce(req), null, 2));
  process.exit(0);
}

let sources: { n: number; title: string; headingPath: string; sourceUrl: string | null; relPath: string; sourceType: string; authority: string }[] = [];
for await (const ev of ask(req)) {
  switch (ev.type) {
    case "status":
      process.stderr.write(`\x1b[2m${ev.message}\x1b[0m\n`);
      break;
    case "sources":
      sources = ev.citations;
      break;
    case "tool":
      process.stderr.write(
        `\x1b[2m${ev.ok ? "tool" : "tool!"} ${ev.name}(${JSON.stringify(ev.args)}) → ${ev.summary}\x1b[0m\n`,
      );
      break;
    case "thinking":
      // Reasoning tokens (CHAT_THINK=true) go to stderr, dimmed, so `npm run ask > file` stays clean.
      process.stderr.write(`\x1b[2m${ev.text}\x1b[0m`);
      break;
    case "token":
      process.stdout.write(ev.text);
      break;
    case "done": {
      if (ev.thinking) process.stderr.write("\n");
      process.stdout.write("\n\n");
      const used = new Set(ev.usedCitations);
      const shown = sources.filter((s) => used.has(s.n));
      const list = shown.length ? shown : sources;
      console.log(shown.length ? "Sources:" : "Retrieved (not explicitly cited):");
      for (const s of list) {
        console.log(`  [${s.n}] ${s.headingPath}  (${s.sourceType}, ${s.authority})`);
        console.log(`      ${s.sourceUrl ?? s.relPath}`);
      }
      process.stderr.write(
        `\x1b[2mretrieve ${ev.timings.retrieveMs ?? 0}ms · generate ${ev.timings.generateMs ?? 0}ms · total ${ev.timings.totalMs ?? 0}ms\x1b[0m\n`,
      );
      break;
    }
    case "error":
      console.error(`\nError: ${ev.message}`);
      process.exit(1);
  }
}
