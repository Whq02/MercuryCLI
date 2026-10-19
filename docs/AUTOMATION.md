# Driving Mercury from a program

Drive Mercury from a program through the `mercury run --format rows` one-shot
stream or the `mercury runner` JSON-RPC session protocol over standard input
and output.

## One-shot runs: `mercury run --format rows`

`mercury run "<prompt>" --format rows` runs a prompt without a terminal
interface and writes one newline-delimited JSON object per line to `stdout`
(`schema: 1`). Every row carries `type`, `seq` (numbered contiguously from `1`
for the stream), `timestamp` and `session_id`; rows within a turn also carry
`turn`, and rows from a delegated crewmate carry `parent_call_id`.

The stream opens with a `session` row (`version`, optional `build` and
`resume_of`, `cwd`, `model`, `mode`, `tools`, optional `tools_withheld`,
`mcp_servers`, `commands`, `agents`, `skills`, `extensions`), followed by
`turn` (`state: "started"` or `"waiting"`, `turn_id`) and the turn's settled
blocks and progress rows (`text`, `reasoning`, `tool_call`, `tool_result`,
`tool_update`, `step`, `wait`, `heartbeat`, `compaction`, `mode`,
`rate_limit`, `task`, `notice`, `command_output`, `mission_updated`,
`samples_updated`). Adding `--partial` emits streaming delta rows
(`block_start`, `text_delta`, `reasoning_delta`, `tool_input_delta`,
`retracted`) ahead of each settled block.

Each turn ends with an `outcome` row (`status`, `turn_id`, `steps`, `wall_ms`,
optional `api_ms` and `cost_usd`, `usage`, `models`, `denials`, `answer` when
the turn produced one, `error` with `message`, `class` and optional `detail`
on failure, and optional `structured` and `notices`). A `close` row (`state`:
`"stored"`, `"skipped"` or `"none"`, optional `note_chars`, `usage` and
`models`) carries the note left for the next session: with the prompt given
as an argument the note is asked inside the last turn, so `close` precedes
that turn's `outcome` and the close ask's usage is counted in the outcome's
totals; with `--input rows` it follows the last `outcome` once `stdin`
closes. A completed run (`status: "completed"`) exits `0`, other turn
outcomes exit `1`, and a command-line usage error exits `2`. A one-shot run
has no host to answer interactive permission asks: a tool call that would ask
is refused, and a turn whose later tool calls never succeed ends `blocked`
with its `answer` kept and `error.message` naming the tool. Pass `--mode`
(`sovereign`, `flow`, `implement` or `dontAsk`) or `--allowed-tools` to grant
what the run needs up front, and read `error.message` beside `answer` on an
outcome that is not `completed`.

Pass `--input rows` with `--format rows` to send one JSON input row per line on
`stdin`:

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

- **Initialise:** Send `initialize` first with
  `{"protocol":1,"host":{"name":"...","version":"..."},"capabilities":{"holds_asks":true,"elicitation":false,"partial_rows":false}}`
  and wait for its result (`{"protocol":1,"runner":{"version":"...","pid":123},"session_id":"..."}`)
  before sending other requests. A request sent before `initialize` answers
  `-32002`.
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
  `request_id`.
- **Interrupt and leave:** Send `turn/interrupt` (`{"hard":true}` also stops
  running background shells) to abort an active turn; the runner answers
  `{"interrupted":true}` and flushes an `outcome` row with
  `status: "interrupted"`. When no turn is running, send `session/leave` (`{}`)
  to write the session's handoff note (`{"note":"stored"|"skipped"|"none","ledger":"closed"|"absent"}`),
  then close `stdin` to exit the runner.
- **Errors:** Unknown methods answer `-32601`, invalid parameters `-32602`,
  cancelled requests `-32800`, and rule refusals `-32010` with a reason in
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
