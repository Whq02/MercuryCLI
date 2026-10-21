# Mercury CLI SDK

`mercury-cli-sdk` 0.1.0 is a zero-runtime-dependency TypeScript client for Mercury CLI, requiring Node.js 22 or later. Install Mercury separately and sign in through the CLI; the SDK uses its configuration and credentials. The package is Apache-2.0 and versioned separately from the CLI.

```sh
npm install mercury-cli-sdk
```

## Quickstart

```ts
import { run } from 'mercury-cli-sdk'

const task = run({ prompt: 'Explain the README', partial: true })
task.on('text_delta', row => process.stdout.write(row.text))
const result = await task.outcome
console.log(result.status, result.answer)
```

`run()` returns an async row iterator with typed listeners. Its `session`, `outcome` and `exit` are promises; `rows` retains received rows. Use one consumption style: listeners or `for await`. Whole blocks arrive as `text`; `partial: true` also streams `text_delta`. `outcome` settles after the process exits and owned tool servers close. With inline tools, `ready` resolves once the server and child have started; inspect `child` and `args` after that promise.

## Host a session

```ts
import { connect } from 'mercury-cli-sdk'

const session = await connect({
  onPermissionRequest: () => ({ outcome: 'deny', message: 'Read-only host' }),
})
try {
  console.log((await session.prompt('Inspect the tests')).status)
  console.log((await session.prompt('Explain the result')).answer)
  console.log((await session.facts()).usage.total_cost_usd)
} finally { await session.close() }
```

`prompt` awaits its own correlated turn. Only one prompt wait may be active; `steer(content, { id?, schema? })` queues priority `now` and `followUp(content, { id?, schema? })` queues `later`. `sendPrompt`, `sendShell` and `sendNote` expose ids and all priorities; `withdraw(id)` removes queued input. `prompt(content, { signal })` cancels the wait, not the turn; `interrupt()` ends the turn. Typed `request(method, params, { signal, deadlineMs })` and `notify` cover protocol 1, including pause, quiesce, leave, MCP and schedules. A null deadline disables its timer. `connect({ signal })` cancels a boot that never answers and closes the session once connected when the signal aborts.

`onPermissionRequest` and `onElicitation` receive `{ id, signal }`; absent handlers deny and decline respectively. `onReadTextFile` and `onWriteTextFile` route native file tools to host buffers and infer their capabilities. The equivalent `handlers` entries work too. Supplying all five `terminal/*` handlers infers terminal support; partial terminal sets do not. Explicit `capabilities` override inference.

### Checkpoints, warm workers and control

`connect` asks the CLI to capture file checkpoints (`file_checkpoints: true` on `initialize`); `checkpoints: false` opts out. The CLI answers with what it does: `session.fileCheckpoints` (the `initialize` answer) and `(await session.facts()).file_checkpoints` carry `capture` and `source`, where `initialize` means the request is honoured, `setting` that the CLI's file-checkpoint setting turned it off, `headless` that nothing asked, and `seat` or `interactive` name the CLI's own sessions; `facts` adds `restorable`, the user-message ids a rewind can return to. `run` has no `initialize` and captures nothing. After any accepted prompt input, including `sendPrompt`, `steer` and `followUp`, `lastPromptId` is its user-message id. Pass it to `rewind({ user_message_id, mode: 'both', dry_run: true })`, then omit `dry_run` to restore. Modes are `code`, `conversation` and `both`; the typed receipt reports changed files and removed conversation rows.

`prewarm(options)` or `connect({ warm: true })` returns an unclaimed runner. `session.sessionId` reflects `initialized.session_id`: both are null until `claim({ session_id, model?, effort?, mode?, resume? })` succeeds and updates them from the CLI's reply. Prompt input before a claim fails immediately with `MercuryError('session is unclaimed; call claim() before prompting')`. Warm workers reject boot-time identity flags; ordinary, resumed and continued sessions already have an identity. The unclaimed boot runs in the CLI's session-runner role, which withholds subagents and workflows unless the CLI setting `Crewmates while backgrounded` is on, offers the Contract tool and refuses `Sleep` beyond 300 seconds. `facts`, `rewind`, `stopAgent` and `resumeAgent` return generated result types. Model, effort, permission mode and kit changes use `setModel`, `setEffort`, `setMode` and `setKit`.

## Inline tools and agents

```ts
import { defineTool, run } from 'mercury-cli-sdk'

const greeting = defineTool({
  name: 'greeting', description: 'Return a greeting',
  inputSchema: { type: 'object', properties: {} },
  execute: (_input, { signal }) => signal.aborted ? 'Cancelled' : 'Hello',
})
const result = await run({ prompt: 'Use greeting to say hello', tools: [greeting] }).outcome
console.log(result.status, result.answer)
```

Both doors own the authenticated loopback MCP server for `tools`, close it on exit or failed startup, and merge it with `mcp`. Tool names `mcp__sdk-tools__<name>` are added to `allowedTools` and existing inline custom-agent `tools` allowlists without mutating your options. `autoAllowTools: false` keeps serving but leaves permission grants to you; explicit denials still apply. An unanswered headless ask produces `blocked`. `defineAgent` validates definitions passed in `agentDefs`. `serveTools(tools, name)` remains available for manually owned servers. Tool callbacks receive `{ signal }` for cooperative cancellation; keep the event loop running.

## Inputs, output schemas and launch options

A prompt accepts text, readonly `InputBlock[]` or an `AsyncIterable<string | InputRow>`. Block and iterable prompts automatically use input rows and close stdin when complete. `textBlock(text)` builds text; `imageBlock(data, mediaType)` accepts base64 text, bytes (including Buffer), or `{ path }`. For manual streaming use `input: 'rows'`, `send(row)` and `closeInput()`. On the rows door the CLI writes nothing, not even `session`, until the first input row arrives, so `session`, `signal` and `interrupt()` take effect once the first prompt is sent; `closeInput()` on a run that sent no row ends it without an outcome. `outcome` is the final run outcome; listen to individual outcome rows for multi-turn input.

`run<T>` and `session.prompt<T>` return `OutcomeRow<T>`. A `schema` accepts JSON Schema, JSON text, a schema file path or `structuredSchema(jsonSchema, decode)`, whose decoder infers T. On `run` it is the `--schema` flag and shapes every turn; on `connect` it travels on `initialize` and shapes every turn of the session; `prompt(content, { schema })` sends that turn's schema on its prompt row and overrides the session's for that turn, so one session can ask for a different shape each turn, and a turn without one carries no `structured`. Mercury holds the model to the schema and settles the turn with `structured`; a schema that is not a JSON Schema is refused before the turn starts, and `prompt` or `connect` throws `MercurySchemaError` with the CLI's issue at path `schema` and `outcome` null. A completed `structured` is decoded by the descriptor and read once more by the package (types, scalar constants/enums, object fields, array items, numeric ranges and string lengths), so a replayed fixture is held to the same shape; a mismatch throws `MercurySchemaError` with exact `issues` and the raw `outcome`. A generic alone is a type assertion, not validation.

`RunOptions` includes `replayTo`, `restoreFiles`, `worktree`, `reasoningMode`, `briefFile`, `briefAddFile` and `debug`. `argvOf` previews flags; `extraArgs` passes additional flags. Both doors accept an explicit executable or prefix array such as `mercury: ['ssh', 'host', 'mercury']`. Otherwise discovery uses `MERCURY_BIN`; then the managed install, read as Mercury's own command reads it: `current.txt` under `MERCURY_VERSIONS_DIR`, else `versions` in the Mercury home (`MERCURY_CONFIG_DIR`, `MERCURY_HOME` or `~/.mercury`; `%USERPROFILE%\.mercury` on Windows), whose version directory's `mercury.mjs` is run on the Node runtime vendored beside it; then `mercury` on PATH; then the stable command the installer writes (`~/.local/bin/mercury`; `%LOCALAPPDATA%\Mercury\bin\mercury.cmd` on Windows) and `~/.mercury/bin/mercury`; then, on macOS and Linux, the Homebrew command (`$HOMEBREW_PREFIX/bin/mercury`, `/opt/homebrew/bin/mercury`, `/usr/local/bin/mercury`, `/home/linuxbrew/.linuxbrew/bin/mercury`), for a host launched with a stripped PATH (an empty PATH skips this rung). No shell is involved: Mercury's managed command (`mercury`, `mercury.cmd`, `mercury.ps1`) resolves to that bundle, the Homebrew wrapper to the keg's `mercury.mjs` on its vendored runtime, an npm-style `.cmd` shim to its JavaScript entry point, and a `mercury.cmd` beside a `mercury.mjs` to that bundle; any other command shim requires an explicit `[node, script]` array, and a managed command whose install is missing is refused with the pointer file it looked for. A relative executable with a slash (`./bin/mercury`) is resolved against `cwd`; on Windows the `env` keys are read without regard to case, so a spread of `process.env` (`Path`, `Pathext`) still resolves. A `.mjs`, `.cjs` or `.js` executable such as a built `mercury.mjs` runs on `MERCURY_NODE` when set (one that names no executable file is refused by name, as the launcher refuses it), else the runtime bundled beside it under `vendor/node`, else `node` from PATH.

## Test without a model

```ts
import { run } from 'mercury-cli-sdk'
import { startFixtureServer, fixtureSessionRow, fixtureOutcomeRow } from 'mercury-cli-sdk/testing'

const fixture = await startFixtureServer({ rows: [fixtureSessionRow(), fixtureOutcomeRow({ answer: 'ok' })] })
try {
  const result = await run({ mercury: fixture.mercury, prompt: 'test' }).outcome
  if (result.answer !== 'ok') throw new Error('unexpected answer')
} finally { await fixture.close() }
```

`fixtureTurn(overrides, promptId)` builds a correlated turn/outcome pair. You can also replay `task.rows`. Fixtures validate rows and RPC replies before listening; `validate: false` is for deliberately malformed-wire tests. `methods` holds ordered `{ result, before?, after? }` or `{ error }` replies; before/after and `answers` contain RPC messages. `received` records inputs and `inputCount` delays replay. Missing methods return method-not-found. Fixtures use neither a CLI nor model credentials and do not simulate the CLI's internal behaviour.

## Rows, errors and cleanup

`parseRow`, `rowOf`, `inputRowOf` and `validate` use generated schemas. `isMainThread` separates subagent rows. Unknown types become `unknown_row` with `original_type`, raw payload and envelope; known extra fields are preserved. Schema-version changes and malformed known rows are rejected.

Non-completed turns resolve their outcome status (including failed authentication); refusals throw `MercuryRefusal`. Other specific `MercuryError` subclasses are `MercuryUsageError`, `MercuryExitError`, `MercurySpawnError`, `MercuryWireError` and `MercurySchemaError`. Exit/usage errors preserve the door and exit receipt; RPC errors preserve code and data. Check status rather than only exit code.

`stderr` holds what the child has written to standard error so far; `onStderr` (or an `on('stderr', …)` listener) receives each chunk as it arrives, on both doors. `signal` interrupts a run. `interrupt`, `terminate` and `kill` are synchronous and signal the child with SIGINT, SIGTERM and SIGKILL; the exit is awaited through `exit`. An interrupt the package sent always settles the turn as an `interrupted` outcome: the CLI writes that row itself where SIGINT reaches it, and where the child ends by the signal before writing one (Windows delivers no signal, so Node ends the process and reports `signal: 'SIGINT'`) the package completes the turn with an `interrupted` outcome row folded from the rows it received. A signal the package did not send, and `terminate` or `kill`, surface as `MercuryExitError`. Close handles in finally or with `await using`; `close` ends stdin, escalates after five seconds to termination, and after ten to killing. Normal host exit sends SIGTERM to live children; an unhandled killing signal cannot run cleanup, so long-running hosts should handle SIGTERM and close sessions.

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
