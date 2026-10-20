# Mercury CLI SDK

`mercury-cli-sdk` 0.1.0 is a zero-runtime-dependency TypeScript client for Mercury CLI. It drives an installed `mercury` process, not an embedded model runtime. Install Mercury separately and sign in through the CLI. The SDK uses that CLI's configuration and credentials; it does not bundle a CLI or sign you in.

Requires Node.js 22 or later. The package is Apache-2.0; the CLI has its own licence. The SDK is versioned and released separately from the CLI.

```sh
npm install mercury-cli-sdk
```

## Run a task

```ts
import { run, MercuryRefusal } from 'mercury-cli-sdk'

const task = run({
  prompt: 'Explain the failing test without changing files',
  mode: 'default',
  partial: true,
})
task.on('text_delta', row => process.stdout.write(row.text))
try {
  for await (const row of task) {
    if (row.type === 'tool_call') console.log(row.tool)
    if (row.type === 'unknown_row') console.log(row.original_type)
  }
  const outcome = await task.outcome
  if (outcome.status !== 'completed') console.error(outcome.status, outcome.error?.message)
  console.log(outcome.answer, outcome.usage, (await task.exit).code)
} catch (error) {
  if (error instanceof MercuryRefusal) console.error(error.message)
  else throw error
}
```

`run()` returns `MercuryRun`, an async row iterator with typed `.on()` listeners. `.session`, `.outcome` and `.exit` are promises; `.rows` retains received rows. `interrupt()`, `terminate()` and `kill()` signal the child; `close()` (or `await using`) ends stdin and waits for the exit. An `AbortSignal` in the options interrupts a run. A turn that did not complete resolves an outcome with another status and an `error` (a CLI that is not signed in answers `failed` with `error.class === 'auth'`); a refused request throws `MercuryRefusal`. `text` rows carry whole blocks; with `partial: true` the `text_delta` rows stream them as they arrive.

For streaming stdin, use `run({ input: 'rows' })`, then await `sendPrompt(content)`, `sendShell(command)` or `sendNote(agentId, content)`. `send(row)` accepts any generated `InputRow`. Call `closeInput()` when input is complete. The process stays open while stdin is open; `.outcome` resolves to its final outcome when it exits. Observe individual outcomes with `.on('outcome', ...)`.

## Host a session

```ts
import { connect } from 'mercury-cli-sdk'

const session = await connect({
  onPermissionRequest: async (ask, { signal }) => {
    if (signal.aborted) return { outcome: 'deny' }
    console.log(ask.tool_name, ask.input)
    return { outcome: 'deny', message: 'This host is read-only' }
  },
})
try {
  session.on('text', row => process.stdout.write(row.text))
  const first = await session.prompt('Inspect the tests')
  console.log(first.status)
  const second = await session.prompt('Explain the result')
  console.log(second.answer)
  console.log(await session.facts())
  await session.request('session/pause_gate', { paused: false })
} finally {
  await session.close()
}
```

`connect()` initializes JSON-RPC protocol 1. `MercurySession` exposes `prompt`, `sendPrompt`, `sendShell`, `sendNote`, `withdraw`, `interrupt`, `facts`, `setModel`, `setEffort`, `setMode`, `setKit`, `rewind`, `stopAgent`, `resumeAgent` and `claim`. Typed `request(method, params)` and `notify(method, params)` cover every declared host method, including MCP inspection, pause/quiesce/leave and schedule updates. `prompt` resolves with the outcome of the turn its words started, even when other input is queued; a second `prompt` while one is pending throws, so queue mid-turn words with `sendPrompt`. `prompt(content, { signal })` stops waiting when the signal aborts (the turn itself continues; `interrupt()` ends it), and `request(method, params, { signal, deadlineMs })` bounds one request.

`onPermissionRequest` and `onElicitation` answer asks. `handlers` covers all runner-to-host requests, including files, terminals and schedules; explicitly advertise the corresponding capabilities when supplying those handlers. No permission handler means deny; no elicitation handler means decline. The callback receives an abort signal when the runner cancels its ask. Input rewriting and rule grants use generated answer types. `claim` works only when the runner permits it; a normal standalone runner already has a session identity.

Both doors accept `mercury: ['ssh', 'host', 'mercury']` or another executable/argument array. `argvOf()` previews run arguments. `extraArgs` passes additional CLI flags without a shell. Close sessions in `finally`, or use `await using`. `close()` ends stdin and terminates an unresponsive child after five seconds, then kills it after ten seconds if it still has not exited. A host process that exits (`process.exit()` or an uncaught exception) sends SIGTERM to the children it still has; a host killed by a signal it does not handle cannot, so handle `SIGTERM` and call `close()` in long-running hosts.

## Inline tools and agents

```ts
import { defineAgent, defineTool, serveTools, run } from 'mercury-cli-sdk'

const tools = await serveTools([defineTool({
  name: 'greeting', description: 'Return a greeting',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: () => 'Hello',
})])
try {
  const agent = defineAgent({ description: 'Read-only reviewer', prompt: 'Review; do not edit.', tools: ['Read', 'mcp__sdk-tools__greeting'] })
  const task = run({
    prompt: 'Review the README', agent: 'reviewer', agentDefs: { reviewer: agent },
    mcp: [tools.mcp], allowedTools: ['mcp__sdk-tools__greeting'],
  })
  const outcome = await task.outcome
  console.log(outcome.status, outcome.answer ?? outcome.denials)
} finally { await tools.close() }
```

Tools use authenticated loopback MCP HTTP through the existing `--mcp` option, not a private runner method. `serveTools(tools, name = 'sdk-tools')` provides `.config`, `.mcp` and `.close()`; each tool is named `mcp__<name>__<tool>` in the session. Keep the host event loop running while tools execute. Agent definitions become `--agent-defs` JSON; an agent's `tools` list is an allowlist, so name the inline tool there or omit `tools` to inherit everything. Normal Mercury tool permissions still apply: a headless run cannot ask, so grant the tool with `allowedTools` (or host a session and answer the ask), otherwise the call is denied and the outcome is `blocked` with the call in `denials`.

## Test without a model

The `testing` subpath replays recorded rows and JSON-RPC messages on loopback. It returns an executable array usable in either client; no installed CLI or model credentials are involved.

```ts
import { run } from 'mercury-cli-sdk'
import { startFixtureServer } from 'mercury-cli-sdk/testing'

const fixture = await startFixtureServer({ rows: recordedRows })
try {
  const result = await run({ mercury: fixture.mercury, prompt: 'test' }).outcome
  console.log(result.answer)
} finally { await fixture.close() }
```

Supply rows captured from `task.rows` as `recordedRows`. For runner tests, `methods` maps method names to ordered `{ result, before?, after? }` or `{ error }` replies. `before` and `after` hold complete RPC messages. `answers` maps a host-request id to messages emitted after its answer. `received` records consumer inputs; `inputCount` delays run-row replay until that many stdin rows arrive. Missing recorded methods answer method-not-found instead of calling a provider. Fixtures model only the recording, not the CLI's internal behaviour.

## Rows and errors

The generator reads Mercury's schemas for both language packages. `parseRow`, `rowOf`, `inputRowOf` and `validate` expose the readers; `isMainThread(row)` tells the main conversation's rows from a subagent's. Known malformed rows fail validation; a changed session/outcome schema version is rejected. An unfamiliar type is delivered as `{ type: 'unknown_row', original_type, raw }` with its envelope fields copied beside it, without losing its payload. Extra fields on known rows are retained.

Five specific errors derive from `MercuryError`: `MercuryRefusal` (run outcome or RPC refusal), `MercuryUsageError` (the CLI refused the command line, exit 2), `MercuryExitError` (the process ended before an outcome row or before the session was closed), `MercurySpawnError` (cannot launch: no such executable or working directory) and `MercuryWireError` (invalid frame). `MercuryUsageError` and `MercuryExitError` carry `.door` (`'run'` or `'runner'`) and `.exit` (code, signal, stderr) and quote the CLI's own stderr line; RPC errors retain `.code` and `.data`; RPC refusals have a null `.outcome`. Read the outcome's status rather than treating an exit code alone as a completed turn.

<!-- vocabulary:start -->
| Row | Required fields |
| --- | --- |
| `session` | `type`, `seq`, `timestamp`, `session_id`, `schema`, `version`, `cwd`, `model`, `mode`, `tools`, `mcp_servers`, `commands`, `agents`, `skills`, `extensions` |
| `turn` | `type`, `seq`, `timestamp`, `session_id`, `state`, `turn_id` |
| `text` | `type`, `seq`, `timestamp`, `session_id`, `message_id`, `block`, `text` |
| `reasoning` | `type`, `seq`, `timestamp`, `session_id`, `message_id`, `block`, `text` |
| `tool_call` | `type`, `seq`, `timestamp`, `session_id`, `call_id`, `tool`, `input`, `message_id`, `block` |
| `tool_result` | `type`, `seq`, `timestamp`, `session_id`, `call_id`, `status`, `output` |
| `tool_update` | `type`, `seq`, `timestamp`, `session_id`, `call_id`, `tick`, `source` |
| `step` | `type`, `seq`, `timestamp`, `session_id`, `message_id`, `model`, `usage` |
| `outcome` | `type`, `seq`, `timestamp`, `session_id`, `turn`, `schema`, `turn_id`, `status`, `steps`, `wall_ms`, `usage`, `models`, `denials` |
| `close` | `type`, `seq`, `timestamp`, `session_id`, `state` |
| `wait` | `type`, `seq`, `timestamp`, `session_id`, `state` |
| `heartbeat` | `type`, `seq`, `timestamp`, `session_id` |
| `compaction` | `type`, `seq`, `timestamp`, `session_id`, `state`, `trigger` |
| `mode` | `type`, `seq`, `timestamp`, `session_id`, `mode` |
| `rate_limit` | `type`, `seq`, `timestamp`, `session_id`, `status` |
| `task` | `type`, `seq`, `timestamp`, `session_id`, `state`, `task_id` |
| `notice` | `type`, `seq`, `timestamp`, `session_id`, `level`, `text` |
| `command_output` | `type`, `seq`, `timestamp`, `session_id`, `text` |
| `mission_updated` | `type`, `seq`, `timestamp`, `session_id` |
| `samples_updated` | `type`, `seq`, `timestamp`, `session_id` |
| `block_start` | `type`, `seq`, `timestamp`, `session_id`, `message_id`, `block`, `of` |
| `text_delta` | `type`, `seq`, `timestamp`, `session_id`, `message_id`, `block`, `text` |
| `reasoning_delta` | `type`, `seq`, `timestamp`, `session_id`, `message_id`, `block`, `text` |
| `tool_input_delta` | `type`, `seq`, `timestamp`, `session_id`, `message_id`, `block`, `json` |
| `retracted` | `type`, `seq`, `timestamp`, `session_id`, `message_id` |
<!-- vocabulary:end -->
