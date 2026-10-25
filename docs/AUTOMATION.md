# Driving Mercury from a program

Drive Mercury from a program through the `mercury run --format rows` one-shot
stream or the `mercury runner` JSON-RPC session protocol over standard input
and output.

## Usage history

`mercury usage --history` prints tokens, cache-hit rate and estimated USD
across saved sessions, grouped by UTC day, model and project. Add `--days 30`
for today and the preceding 29 UTC days, `--project` for the current project,
or `--json` for the full report. Unpriced turns are counted separately;
their tokens are included but no dollar amount is invented.

The report reads local transcripts, including delegated work, without
contacting providers or changing transcripts. A bounded local cache reuses
unchanged transcript summaries: at most 4,096 files and 32,768 hourly rows.
Evicted summaries are rebuilt when needed; eviction does not truncate totals.
Provider meter readings are retained separately, one latest observation per
hour, account and window, up to 4,096 rows. Neither cache stores message text.

Costs are estimates at current local rates; they are not invoices. DeepSeek rates
were checked against its [pricing page](https://api-docs.deepseek.com/quick_start/pricing/)
on 2026-10-23: peak hours are Monday–Friday 01:00–04:00 and 06:00–10:00 UTC,
excluding Chinese public holidays; other hours cost half as much. Requests
use their start time; older records without that timestamp use the recorded
message time. The [2026 holiday calendar](https://en.bjhd.gov.cn/workinginhaidian/supportingservices/publicholidays/202512/t20251211_4797062.shtml)
is included. Peak-window estimates for other years use the full rate because
the holiday dates are not recorded.

Without `--history`, `mercury usage` samples the current provider meters,
like `/usage`; `--json` includes their windows, resets and observation times.

## One-shot runs: `mercury run --format rows`

The same build runs without the interactive interface.
`node dist/mercury.mjs --help` lists every flag.

`mercury run "<prompt>"` runs a prompt without a terminal UI:

```sh
mercury run "Summarise this repository." --format text
mercury run "Summarise this repository." --format json
mercury run "Summarise this repository." --format rows
```

- `text` prints the answer; a failed turn's reason goes to stderr.
- `json` prints the last `outcome` row as one JSON object.
- `rows` writes one JSON object per line (`schema: 1`): `session`, then a `turn` and its
  `text`, `reasoning`, `tool_call`, `tool_result` and `step` rows, ending in
  `outcome`. Waits, tool progress, background tasks and notices have their
  own rows. Every row carries `type`, `seq`, `timestamp` and `session_id`; rows
  within a turn also carry its `turn` number, and rows from a delegated
  crewmate carry `parent_call_id`. `seq` numbers this run's
  stream contiguously from 1; `turn` counts the session's turns, so a run that continues
  a stored conversation (`-c`, `-r`, `--fork`) numbers its turn after the
  turns already in it, and its `session` row names the conversation it
  continues in `resume_of`.

The output row types, by their `type` field:

- `session`: the opening row: `version`, `build` (the first twelve hex
  characters of the tree the bundle was built from, as `mercury daemon
  status` prints it; absent when no manifest sits beside the bundle),
  `resume_of` (on a continued run, the session id of the conversation it
  continues; the same id as `session_id` unless the run was forked), `cwd`,
  `model`, `mode`, the `tools`, `mcp_servers`, `commands`, `agents`,
  `skills` and `extensions` the session has, and `tools_withheld` (present
  when a deny rule withholds a tool by its bare name: each entry's `tool`,
  `rule` and `source`).
- `turn`: a turn `started` or `waiting`, with its `turn_id`; `model`,
  `message_ids` and the `agents` count when known.
- `text`: a settled text block: `message_id`, `block`, `text`, and its
  `phase` (`commentary` or `final_answer`).
- `reasoning`: a settled reasoning block: `message_id`, `block`, `text`, or
  `redacted: true`.
- `tool_call`: a tool call: `call_id`, `tool`, `input`, with its
  `message_id` and `block`.
- `tool_result`: the call's result: `call_id`, `status` (`ok`, `error`,
  `aborted` or `refused`) and `output`. A call the model shaped so badly that
  it was refused before execution (an unknown tool, arguments that are not
  valid JSON or do not fit the tool's schema) still gets its pair: a
  `tool_call` row with the arguments as delivered (`{}` when they were not an
  object) and a `tool_result` row with status `refused` whose `output` is the
  reason; the correction `notice` follows. Such a call never ran and is not a
  denial.
- `tool_update`: progress from a running tool: `call_id`, `tick`, `source`
  (`shell`, `powershell`, `mcp` or `eval`), and whichever of `line`,
  `elapsed_s`, `lines`, `bytes`, `budget_ms`, `progress` and `total` the call
  reports. A shell or PowerShell call ticks as its output arrives (a command
  that prints nothing never ticks), an MCP call when its server reports
  progress, an Eval call while its cell runs; no other tool ticks; a Browser
  or Crewmate call is silent until its result.
- `step`: one model call of the main thread: `message_id`, `model`, `usage`,
  and `stop` when the model said why it stopped.
- `outcome`: the turn's result, described below.
- `close`: the note left for the next session at close: `state` (`stored`,
  `skipped` or `none`), `note_chars`, and the `usage` and `models` of the model calls that
  wrote it, so a reader summing every row's usage reaches the outcome's. With
  the prompt given as an argument the note is asked inside the last turn, so
  `close` precedes that turn's `outcome` and the close ask's usage is counted
  in the outcome's totals; with `--input rows` it follows the last `outcome` once `stdin`
  closes.
- `wait`: a wait on the model: `state` (`first_byte`, `retry`, `silence`,
  `loading` or `done`) with the figures that state carries, such as
  `since_ms`, `attempt` and `of`, `delay_ms`, `reason` and `http_status`.
- `heartbeat`: the model stream showed life after at least a second without
  a parsed event: bytes arrived that produced no row. The row carries nothing
  else and comes at most once a second; how often depends on the provider's
  streaming shape, so a stream that never pauses between events emits none.
- `compaction`: a compaction `started`, in `progress` or `ended`: `trigger`
  (`manual`, `auto` or `overflow`), `stage`, `fill`, `summary_tokens` and, at
  the end, `exit` (`landed`, `cancelled` or `failed`).
- `mode`: the permission mode changed: `mode`.
- `rate_limit`: the provider's limit state: `status` (`allowed`, `warning` or
  `rejected`), `window`, `resets_at`, `utilization` and the overage fields.
- `task`: a background task `started`, in `progress` or `ended`: `task_id`,
  `task_type`, `description`, `usage`, `summary`, `status` (`completed`,
  `failed` or `stopped`) and `output_file` as they become known.
- `notice`: a `warning` or `error` for the reader: `text`, and a `code` such
  as `input_refused`.
- `command_output`: the output of a slash command that never reached the
  model: `command` and `text`.
- `mission_updated`: the session's task ledger changed; read it again.
- `samples_updated`: the session's samples changed; read them again.

`--partial` with `--format rows` adds `block_start`, `text_delta`,
`reasoning_delta`, `tool_input_delta` and `retracted` rows. Deltas belong to
`message_id` and `block`; a `retracted` row withdraws that message's deltas.
The settled text or tool row is the complete value.

Each turn ends with an `outcome` row carrying `schema`, `turn_id`, `status`,
`steps`, `wall_ms`, `usage`, `models` and `denials`, with `answer` on
completion or a turn limit and `error` (`message`, `class`, optional `detail`)
on failure. `stop`, `api_ms`, `cost_usd`, requested `structured` output and
`notices` are included when available. `wall_ms` is the turn's elapsed time.
`api_ms` is the sum of the durations of every model request the turn made
(including retries and the crewmates' requests that ran alongside the main
thread), so it can exceed `wall_ms` when requests overlapped. `cost_usd` is the
USD of the turn's priced requests, whatever the status: a request Mercury
cannot price (no rate on file, no cost stated in the response) adds nothing to
it and leaves its model listed in `models` without a `cost_usd` of its own; the
field is absent only when nothing in the turn was priced. On a Claude
subscription sign-in the Anthropic requests have no dollar price, so neither
they nor the row carry a `cost_usd`; the usage stays. Usage names
`input_tokens` (cached tokens included), `cached_input_tokens`,
`cache_write_input_tokens`, `output_tokens` and, when reported,
`reasoning_output_tokens`, summed over the main thread and the crewmates.
`models` breaks token usage down by model. `steps` counts only the main agent's
model calls; model calls made by crewmates appear as their own `step` rows
tagged with `parent_call_id`.

The status is `completed`, `blocked`, `refused`, `failed`, `interrupted`,
`turn_limit`, `budget_limit`, `time_limit`, `schema_unmet` or `loop_stopped`.
A run under `--max-time` (seconds, or `10m`, `1h`) ends `time_limit` at the
next step once the time is up; the model call or tool round under way is not
cut. A completed run (`status: "completed"`) exits `0`, other outcomes exit `1`,
and a command-line usage error exits `2`. SIGINT and SIGTERM exit 130 and 143
after the interrupted turn's outcome is flushed. A one-shot run has no host to
answer interactive permission asks: a refused tool call is listed in `denials`,
and when the refusal was an ask nobody could answer (a run with no host in a
mode that asks, `--mode dontAsk`, or a host's ask that expired) and no later
tool call in the turn succeeds, the turn ends `blocked` with its `answer` kept,
`error` naming the tool and how to resume (`--allowed-tools`, another `--mode`,
or a host that answers asks), and the run exits `1`. Pass `--mode` (`sovereign`,
`flow`, `implement` or `dontAsk`) or `--allowed-tools` to grant what the run
needs up front, and read `error.message` beside `answer` on an outcome that is
not `completed`. If a later tool call in the same turn succeeds, the turn
recovers and finishes `completed` (exit 0) with a warning `notice` (`"<Tool> was
not approved; the run continued with other tools."`). A refusal you did answer
(through a deny rule, a hook, or a host that said no) leaves a completed turn
completed. An unanswered `AskUserQuestion` call also ends the run `blocked`,
with the question quoted in `error`; Mercury reads the outcome from the run's
recorded asks, never from the reply text, so a question written only in the
reply finishes `completed`. An unknown slash command is `refused` with the same
sentence the interactive screen gives (`Unknown command: /name · /help lists
commands`) and exits 1.

Pass `--input rows` with `--format rows` to send one JSON input row per line on
`stdin`:

```sh
printf '%s\n' '{"type":"prompt","content":"Summarise this repository."}' | mercury run --input rows --format rows
```

- `{"type":"prompt","content":"Summarise this repository."}` where `content` is
  a string or an array of `{"type":"text","text":"..."}` and
  `{"type":"image","media_type":"image/png","data":"<base64>"}` blocks.
- `{"type":"shell","command":"git status --short"}` to run a shell command in
  the session.
- `{"type":"note","to":"<agent_id>","content":"..."}` to deliver a note to a
  running crewmate at its next tool boundary.

Each input row accepts an optional `id`; `prompt` and `shell` rows also accept
`priority` (`"now"`, `"next"` or `"later"`), `sent_at` and `origin`. An input
line whose shape is invalid emits a `notice` row with `code: "input_refused"`
and is skipped; a line that is not valid JSON ends the run with exit `1`.
These rows carry input only; permission answers use the runner protocol below.

A `prompt` row can also include `schema`, a JSON Schema object for that turn's
structured output. For that turn, Mercury binds the `StructuredOutput` tool to
`schema`, the model replies through the tool, and the `outcome` row returns
the validated object in `structured`. A prompt without `schema` uses the
session's default schema (`--schema` or `initialize.schema`), and a prompt with
its own `schema` never batches into another prompt's turn. If `schema` is not a
valid JSON Schema, only that row is rejected and the session continues:
`--input rows` emits a `notice` row (`code: "input_refused"`) naming the row
`id` and reason, and `queue/add` on the runner returns `-32602` with the same
message under `error.data.issues` (`path: ["schema"]`).

Use `mercury run -` or pipe text into `mercury run` to read the whole prompt
from stdin. Beside a prompt argument, piped text is appended as delimited
context: the pipe is read until it closes or has been silent for one second,
so a stream that keeps delivering is read to its end and a pipe that stays
open and silent does not hold the run. With no prompt and a terminal on
stdin, `run` prints its usage and exits 2.

`--mode <mode>` selects the permission posture. `--sovereign` runs without
permission prompts, and `--allow-sovereign` makes that posture available for
a later switch. Permission policy and deny rules still apply. A root user
entering sovereign mode gets one notice on stderr; the run continues.

Use `-c` to continue the most recent conversation, `-r` to resume by ID, title
or picker, `-w` to run in a managed worktree, and `--lean` for a minimal session.
A `run` has no host to answer permission asks: its permission rules and mode
decide what can run, and a call that still needs approval is denied.

### TypeScript (Node 24, zero dependencies)

```ts
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const proc = spawn('mercury', ['run', '--input', 'rows', '--format', 'rows', '--allowed-tools', 'Read', 'Glob', 'Grep'], {
  stdio: ['pipe', 'pipe', 'inherit'],
})
proc.stdin.write(`${JSON.stringify({ type: 'prompt', content: 'Summarise this repository.' })}\n`)
for await (const line of createInterface({ input: proc.stdout })) {
  const row = JSON.parse(line)
  if (row.type === 'outcome') {
    if (row.status !== 'completed') {
      console.error(row.error?.message ?? row.status)
      process.exitCode = 1
    }
    if (row.answer) console.log(row.answer)
    proc.stdin.end()
  }
}
```

### Python (3.10+, standard library only)

```py
import json, subprocess, sys

proc = subprocess.Popen(
    ["mercury", "run", "--input", "rows", "--format", "rows", "--allowed-tools", "Read", "Glob", "Grep"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)
assert proc.stdin is not None and proc.stdout is not None
proc.stdin.write(json.dumps({"type": "prompt", "content": "Summarise this repository."}) + "\n")
proc.stdin.flush()
for line in proc.stdout:
    row = json.loads(line)
    if row.get("type") == "outcome":
        if row.get("status") != "completed":
            print(row.get("error", {}).get("message", row.get("status")), file=sys.stderr)
        if row.get("answer"):
            print(row["answer"])
        proc.stdin.close()
raise SystemExit(proc.wait())
```

## Interactive sessions: `mercury runner`

`mercury runner` serves a multi-turn session over `stdin` and `stdout` using
newline-delimited JSON-RPC 2.0 messages (`protocol: 1`). Every request `id` is
a positive integer (`1`, `2`, `3`, and so on); a request with any other `id`
is answered `-32600` with `id: null`. A runner your script or the SDK drives
is a headless session: an ask the host leaves unanswered expires on its
clock, and a turn that ends on a question nobody answers ends `blocked`. The
sessions the Mercury screen hosts through the same door are oculus
([SESSIONS.md](SESSIONS.md), Oculus); the door and its frames are the same
for both.

The host sends `initialize` first and waits for the answer before sending work:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"name":"my-host","version":"1.0.0"},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}}
```

- **Initialise:** The host's name and version travel under `host`;
  `capabilities` declares `holds_asks`, `elicitation` and `partial_rows`. Wait
  for the `initialize` result (`{"protocol":1,"runner":{"version":"...","pid":123},"session_id":"..."}`)
  before sending other requests. A request sent before `initialize` answers
  `-32002`. `initialize` also accepts an optional `schema` (a JSON Schema object
  used for any turn that does not specify its own `schema`); an invalid schema
  returns `-32602` (`path: ["schema"]`), after which `initialize` can be sent
  again.
- **File checkpoints:** A hosted runner does not capture per-turn file
  checkpoints by default, so `session/rewind` with `mode: "code"` returns
  `capture-off`. Pass `"file_checkpoints": true` in `initialize` to enable
  them: each turn then records the pre-edit bytes of every file its tools
  modify, `session/rewind` can restore those files, and crewmates run
  normally. Both the `initialize` result and `session/facts` include
  `file_checkpoints` with `capture` (`true` or `false`) and `source`:
  `initialize` (enabled by `initialize`), `headless` (the default when not
  requested), `setting` (disabled by `fileCheckpointingEnabled: false`, which
  overrides all modes), `seat` (the interactive screen's session runner) or
  `interactive`. `session/facts` also includes `restorable`, the list of prompt
  IDs with saved checkpoints.
- **Send a prompt and read rows:** Call `queue/add` with a `prompt`, `shell` or
  `note` input row; the runner answers `{"accepted":true}` (or
  `{"accepted":false,"reason":"duplicate"}` when `id` was already processed, so
  give each row an `id` and a resend is harmless). `queue/withdraw` recalls an
  unconsumed queued row by `id`. Session rows arrive from the runner as `row`
  notifications (`{"jsonrpc":"2.0","method":"row","params":<Row>}`).
  `session/facts` reads the current session state. `session/set_mode` changes
  the permission mode at once, during a turn included, and answers
  `{"mode":"..."}`. `session/set_model`, `session/set_effort` and
  `session/set_spawn_switch` answer `at: "now"` when no turn is running; while
  a turn runs they answer `at: "turn_end"` and a `session/applied` notification
  (`request_id`, `verb`) follows when the turn ends.
- **Tell a reply from a request:** The runner numbers its own requests to the
  host (`permission/request`) from `1` as well, so a message with `id: 1` is
  either the reply to your `initialize` or the runner's first ask. A reply
  carries `result` or `error` and no `method`; a request carries `method`.
- **Answer a permission ask:** When a tool call needs approval, the runner
  sends a `permission/request` request to the host with `kind: "tool"`
  (`tool_use_id`, `tool_name`, `input`, optional `title`, `display_name`,
  `description`, `suggestions`, `cwd`, `reason`, `agent_id`, `mode`); that is
  the one kind of ask. Reply with the request's `id` and
  `{"outcome":"allow"}` (with optional modified `input` and `rules`) or
  `{"outcome":"deny"}` (with optional `message` and `stop`). When the runner
  withdraws a pending ask, it sends a `$/cancel_request` notification with
  `request_id`. `holds_asks` gives the host ownership of the ask's clock. An MCP
  question uses `elicitation/request` only when the host declares `elicitation`;
  otherwise it is answered `cancel`.
- **Interrupt and leave:** Send `turn/interrupt` (`{"hard":true}` also stops
  running background shells) to abort an active turn; the runner answers
  `{"interrupted":true}` and flushes an `outcome` row with
  `status: "interrupted"`. When no turn is running, send `session/leave` (`{}`)
  to write the session's handoff note (`{"note":"stored"|"skipped"|"none","ledger":"closed"|"absent"}`),
  then close `stdin` to exit the runner.
- **Errors:** Unknown methods answer `-32601`, invalid parameters `-32602`, an
  `id` that is not a positive integer `-32600`, a request before initialization
  `-32002`, cancelled requests `-32800`, and rule refusals `-32010` with a
  sentence in `error.message` and a reason in
  `error.data.kind` (`protocol`, `claim`, `model`, `effort`, `mode`,
  `spawn-switch`, `kit`, `rewind`, `pause-gate`, `quiesce`, `queue`, `agent`,
  `no-shell`, `nothing-to-resume`, `already-initialized` or `capability`). A
  malformed JSON line answers `-32700`; three consecutive malformed lines end
  the runner.

### TypeScript (Node 24, zero dependencies)

```ts
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const proc = spawn('mercury', ['runner'], { stdio: ['pipe', 'pipe', 'inherit'] })
const send = (msg: Record<string, unknown>) => proc.stdin.write(`${JSON.stringify(msg)}\n`)
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocol: 1, host: { name: 'example-host', version: '1.0.0' }, capabilities: { holds_asks: true, elicitation: false, partial_rows: false } },
})
for await (const line of createInterface({ input: proc.stdout })) {
  const msg = JSON.parse(line)
  const reply = msg.method === undefined
  if (reply && msg.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'queue/add', params: { type: 'prompt', id: 'note-1', content: 'Write note.txt and confirm.' } })
  if (msg.method === 'permission/request') send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'allow' } })
  if (msg.method === 'row' && msg.params.type === 'outcome') {
    console.log(msg.params.answer)
    send({ jsonrpc: '2.0', id: 3, method: 'session/leave', params: {} })
  }
  if (reply && msg.id === 3) proc.stdin.end()
}
```

### Python (3.10+, standard library only)

```py
import json, subprocess

proc = subprocess.Popen(["mercury", "runner"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
def send(msg: dict) -> None:
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()

send({
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocol": 1, "host": {"name": "example-host", "version": "1.0.0"}, "capabilities": {"holds_asks": True, "elicitation": False, "partial_rows": False}},
})
assert proc.stdout is not None
for line in proc.stdout:
    msg = json.loads(line)
    reply = "method" not in msg
    if reply and msg.get("id") == 1:
        send({"jsonrpc": "2.0", "id": 2, "method": "queue/add", "params": {"type": "prompt", "id": "note-1", "content": "Write note.txt and confirm."}})
    if msg.get("method") == "permission/request":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": "allow"}})
    if msg.get("method") == "row" and msg["params"].get("type") == "outcome":
        print(msg["params"].get("answer", ""))
        send({"jsonrpc": "2.0", "id": 3, "method": "session/leave", "params": {}})
    if reply and msg.get("id") == 3 and proc.stdin is not None:
        proc.stdin.close()
raise SystemExit(proc.wait())
```

### The headless image

The `Dockerfile` at the repository root builds a Linux x64 image for CI and
servers. Its entry point is `mercury` and its default verb is `run`, so the
image runs one prompt against a mounted tree and exits with the run's code:

```sh
docker build -t mercury .
docker run --rm -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" -v "$PWD":/work mercury run "Summarise this repository." --format text
docker run --rm mercury --version
```

The image carries the bundle, its Node 24 runtime (on `PATH`), the vendored
search, shell, debugger, language and image tools, `git` and the certificate
store; no enter screen and no sign-in flow. It runs as the non-root user
`mercury` with its config home inside the container (`MERCURY_CONFIG_DIR`),
and `/work` is its working directory. Colour and mouse follow the product's
own terminal detection, and `--user 0` runs as root with the one sovereign
notice above.

A provider key arrives as an environment variable, the same spellings the
product reads everywhere: `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`,
`OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `XAI_API_KEY` (and
`XAI_MANAGEMENT_API_KEY` for its usage meter), `DEEPSEEK_API_KEY`,
`MOONSHOT_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`,
`MISTRAL_API_KEY` (and `MISTRAL_ADMIN_API_KEY` for its organisation meter),
`NOUS_API_KEY`, `OPENCODE_API_KEY`, `MINIMAX_API_KEY`,
`TOGETHER_API_KEY` or `TOGETHER_AI_API_KEY`, `COHERE_API_KEY` or `CO_API_KEY`,
`GROQ_API_KEY`, `MELIOUS_API_KEY`, `ORCAROUTER_API_KEY`, `CEREBRAS_API_KEY`,
`FIREWORKS_API_KEY`, `DASHSCOPE_API_KEY`,
`MODEL_API_KEY` or `META_API_KEY`, `MERCURY_COMPAT_API_KEY` for a custom
OpenAI-compatible endpoint and `MERCURY_LOCAL_API_KEY` for a local server.
With no key the run refuses in one line and exits 1. `docker run -i … mercury
run -` reads the prompt from stdin.

### Other commands

Available commands include:

- **`mercury health`**: diagnostic report, also called the
  health certificate. `--json` returns the full report, `--deep` runs the deep
  inventory, and `--fix` runs guided fixes.
- **`mercury auth login [<family>]|list|status [<family>]|logout [<family>]|mint`**:
  sign in (`login [<family>]`), list provider families (`list`), check whether
  an account is signed in (`status [<family>]`), sign out (`logout [<family>]`),
  or mint a long-lived Anthropic token (`mint`).
- **`mercury models [--json]`**: print the models the signed-in accounts reach
  (the same facts as `mercury://models`).
- **`mercury mcp`**: manage MCP servers with `add`, `import`, `list`, `get`,
  `remove`, `trust-reset` and `serve`.
- **`mercury extensions`**: install extensions and manage their sources.
  Actions: `list`, `sources`, `add`, `remove`, `refresh`, `install`, `trust`,
  `enable`, `disable`, `update`, `uninstall`, `fence`, `unfence`, `inspect`
  and `scaffold`.
- **`mercury roster`**: list the agent inventory.
- **`mercury usage`**: print the compact figures line the `/usage` screen
  shows; `--json` prints the whole reading: each signed-in provider's windows
  with used and reset, the figures and credits it stated, each with its source
  and age, and the session spend per model, read the way the screen reads it
  (each signed-in provider's reader sampled once, as on open).
- **`mercury daemon run|status|stop|restart`**: run, inspect, stop or restart
  the background daemon. Its session seats are `mercury runner` children; the
  daemon sends their prompts and hosts their permission asks.
- **`mercury sessions list`** (also a bare `mercury sessions`): list this
  project's saved sessions, newest first: the id, when it was last written,
  its size, `live` when the daemon hosts it now, and its title or first
  prompt; `--all` reads every project, `--limit <n>` bounds the list. The id
  is what `mercury --resume <id>` reopens and `sessions delete` removes.
- **`mercury sessions delete <id>`**: delete one saved session on purpose —
  its transcript and the records kept beside it (receipts, resume snapshot) —
  after a question; `--yes` skips the question for scripts. A session the
  daemon hosts now is refused, and an unknown id is refused with a hint to the
  roster (`/sessions` inside Mercury). Saved sessions are otherwise never
  deleted on their own.
- **`mercury host [status|start|stop|restart|logs|uninstall|add|recipes]`**:
  run a local or SSH computer as a model server for every session sharing the
  config home (`compat/box-<name>/<model>`), using a verified local weight bank
  or a confirmed download. See [LLM-HOST.md](LLM-HOST.md).
- **`mercury lsp list`** and **`mercury lsp install <server>`**: the
  language-server catalogue, each server installed (with its binary) or
  absent (with its install remedy); `install` shows a server's remedy, asks,
  runs exactly it (`--yes` skips the question for scripts) and reports where
  the binary landed. An unknown server is refused with the roster. Mercury
  never installs a language server on its own; opening a file only starts a
  server that is already installed.
- **`mercury acp`**: serve an editor over the Agent Client Protocol, with a
  runner child for each session. `mercury bridge install` installs the
  VS Code extension; `mercury bridge status` checks it;
  `mercury bridge uninstall` removes it.
- **`mercury godot run|check|capture|frames|profile|tour|jobs|cancel|result`**:
  manage engine jobs for the Godot project in the current directory. Mercury
  runs suites on its own headless workers from a frozen project copy. The
  service includes a compilation gate, captures, frame statistics, settled
  profiles, job queue access, cancellation and results by ID. See
  [VULCAN-GODOT-TOOLS.md](VULCAN-GODOT-TOOLS.md).
- **`mercury image <image>`**: display an image in the terminal.
- **`mercury install`** and **`mercury update`** (alias `upgrade`): install or
  update release archives; with `--json` the document is on stdout whatever
  the verdict, and the exit code says whether it failed. See [INSTALL.md](INSTALL.md).
- **`mercury version`** and **`mercury help [command]`**: print the version
  line or a help page, the same as `--version` and `--help`; neither starts a
  session.
