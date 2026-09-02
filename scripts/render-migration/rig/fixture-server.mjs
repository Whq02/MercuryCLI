// Loopback LLM fixture: OpenAI chat-completions SSE + Anthropic messages SSE.
// Deterministic canonical markdown answer, fixed chunk cadence, so every
// client under test receives byte-identical content at identical timing.
import http from "node:http";

const PORT = Number(process.env.FIXTURE_PORT || 8123);
const TPS = Number(process.env.FIXTURE_TPS || 40); // chunks per second
const TTFB_MS = Number(process.env.FIXTURE_TTFB_MS || 350);

const DOC = `# Plan: tighten the parser

The tokenizer currently allocates one buffer per line. Under streaming load that
is the dominant cost. We can hold a single scratch buffer and reuse it across
lines, resetting the write head instead of reallocating.

Three steps get us there safely:

- Measure the baseline with the existing corpus so the win is provable.
- Introduce the scratch buffer behind a flag and mirror writes to both paths.
- Flip the flag once the mirror diff stays empty for a full corpus run.

Here is the core of the change:

\`\`\`ts
export class LineScanner {
  private scratch: Uint8Array = new Uint8Array(4096);
  private head = 0;

  push(chunk: Uint8Array): Token[] {
    const tokens: Token[] = [];
    for (const byte of chunk) {
      if (byte === NEWLINE) {
        tokens.push(this.take());
        this.head = 0;
      } else {
        this.ensure(this.head + 1);
        this.scratch[this.head++] = byte;
      }
    }
    return tokens;
  }

  private ensure(n: number): void {
    if (n <= this.scratch.length) return;
    const grown = new Uint8Array(this.scratch.length * 2);
    grown.set(this.scratch);
    this.scratch = grown;
  }
}
\`\`\`

The corpus results before and after:

| Corpus | Before | After | Delta |
| ------ | ------ | ----- | ----- |
| small  | 41ms   | 39ms  | -5%   |
| medium | 210ms  | 168ms | -20%  |
| large  | 1.9s   | 1.3s  | -32%  |
| mixed  | 640ms  | 501ms | -22%  |

The large-corpus win comes almost entirely from allocation pressure: the old
path triggered a collection roughly every four hundred lines, and the new one
completes the whole corpus inside a single young generation.

Rollout is a one-line flag flip, and the mirror stays in the tree for one more
release so a regression report can re-arm it instantly.
`;

// Split into chunks of 1-3 words, whitespace-preserving.
function chunkDoc(doc) {
  const parts = doc.split(/(?<=\s)/); // keep trailing whitespace on each token
  const chunks = [];
  let i = 0;
  let take = 1;
  while (i < parts.length) {
    chunks.push(parts.slice(i, i + take).join(""));
    i += take;
    take = (take % 3) + 1; // 1,2,3,1,2,3...
  }
  return chunks;
}
const REPEAT = Math.max(1, Number(process.env.FIXTURE_REPEAT || 1));
const LONG_DOC = Array.from({ length: REPEAT }, (_, i) => (REPEAT > 1 ? `\n\n## Section ${i + 1}\n\n` : "") + DOC).join("");
const CHUNKS = chunkDoc(LONG_DOC);

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function sseNamed(res, event, obj) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamOpenAI(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const id = "chatcmpl-fixture";
  const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1e3), model: "fixture-model" };
  await sleep(TTFB_MS);
  sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  const interval = 1000 / TPS;
  for (const c of CHUNKS) {
    await sleep(interval);
    sse(res, { ...base, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] });
  }
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: CHUNKS.length, total_tokens: 40 + CHUNKS.length } });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function streamAnthropic(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  await sleep(TTFB_MS);
  sseNamed(res, "message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } });
  sseNamed(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const interval = 1000 / TPS;
  for (const c of CHUNKS) {
    await sleep(interval);
    sseNamed(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: c } });
  }
  sseNamed(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sseNamed(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: CHUNKS.length } });
  sseNamed(res, "message_stop", { type: "message_stop" });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const t = new Date().toISOString();
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    console.error(`[fixture ${t}] ${req.method} ${req.url} bytes=${body.length} wall_ms=${Date.now()}`);
    try {
      if (req.method === "GET" && req.url.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model", created: 0, owned_by: "fixture" }] }));
        return;
      }
      if (req.method === "POST" && req.url.includes("/chat/completions")) {
        const parsed = JSON.parse(body || "{}");
        if (parsed.stream === false) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion", model: "fixture-model", choices: [{ index: 0, message: { role: "assistant", content: DOC }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 700, total_tokens: 740 } }));
          return;
        }
        await streamOpenAI(res);
        return;
      }
      if (req.method === "POST" && req.url.includes("/messages")) {
        await streamAnthropic(res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no fixture route for ${req.method} ${req.url}` } }));
    } catch (e) {
      console.error("[fixture] handler error", e);
      try { res.destroy(); } catch {}
    }
  });
});
server.listen(PORT, "127.0.0.1", () => console.error(`[fixture] listening on 127.0.0.1:${PORT} tps=${TPS} ttfb=${TTFB_MS}ms chunks=${CHUNKS.length}`));
