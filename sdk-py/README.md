# Mercury CLI SDK

`mercury-cli-sdk` 0.1.0 is a zero-runtime-dependency Python client for Mercury CLI, requiring Python 3.11 or later. Install Mercury separately and sign in through the CLI; the SDK uses its configuration and credentials. The package is Apache-2.0 and versioned separately from the CLI.

```sh
python -m pip install mercury-cli-sdk
```

On Windows run that as `py -3 -m pip install mercury-cli-sdk` (or with the full path of `python.exe`): the `python3` name there is often the Store stub, which answers with exit code 9009. If `python -m venv` fails because `ensurepip` is missing, install `python3-venv` (Debian and Ubuntu: `apt install python3-venv`), or create the environment with `--without-pip` and install into it from an interpreter that has pip: `python -m pip --python .venv/bin/python install mercury-cli-sdk`.

## Quickstart

```python
from mercury_cli_sdk import run_sync

print(run_sync('Explain the README').outcome.get('answer'))
```

For asynchronous programs and streaming, use `run`.

```python
import asyncio
from mercury_cli_sdk import run

async def main():
    task = await run('Explain the README', partial=True)
    async for row in task:
        if row['type'] == 'text_delta':
            print(row['text'], end='', flush=True)
    result = await task.outcome
    print(result['status'], result.get('answer'))
asyncio.run(main())
```

`run()` returns an async row iterator with listeners. Its `session`, `outcome` and `exit` are awaitable; `rows` retains received rows. Whole blocks arrive as `text`; `partial=True` also streams `text_delta`. `outcome` settles after the process exits and owned tool servers close. `run_sync` returns `RunResult(outcome, rows, exit)`. `connect_sync` returns a typed `SyncSession` with the same control methods and blocking row iteration. Use it as a context manager; host callbacks run on its background loop and must not call the synchronous wrapper recursively.

## Host a session

```python
import asyncio
from mercury_cli_sdk import connect

async def main():
    async with await connect(on_permission_request=lambda ask, context: {'outcome': 'deny', 'message': 'Read-only host'}) as session:
        print((await session.prompt('Inspect the tests'))['status'])
        print((await session.prompt('Explain the result')).get('answer'))
        print((await session.facts())['usage']['total_cost_usd'])
asyncio.run(main())
```

`prompt` awaits its own correlated turn. Only one prompt wait may be active; `steer(content, id=..., schema=...)` queues priority `now` and `follow_up(content, id=..., schema=...)` queues `later`; both keyword options are optional. `send_prompt`, `send_shell` and `send_note` expose ids and all priorities; `withdraw(id)` removes queued input. Cancelling the awaiting task cancels the wait, not the turn; `interrupt()` ends the turn. Typed `request(method, params, timeout=seconds)` and `notify` cover protocol 1, including pause, quiesce, leave, MCP and schedules. `timeout=None` disables its timer. `connect(timeout=seconds)` bounds a boot that never answers; cancelling the awaiting task ends the child too.

`on_permission_request` and `on_elicitation` receive `RequestContext` with `id` and a `cancelled` event; absent handlers deny and decline respectively. `on_read_text_file` and `on_write_text_file` route native file tools to host buffers and infer their capabilities. The equivalent `handlers` entries work too. Supplying all five `terminal/*` handlers infers terminal support; partial terminal sets do not. Explicit `capabilities` override inference.

### Checkpoints, warm workers and control

`connect` asks the CLI to capture file checkpoints (`file_checkpoints: true` on `initialize`); `checkpoints=False` opts out. The CLI answers with what it does: `session.file_checkpoints` (the `initialize` answer) and `(await session.facts())['file_checkpoints']` carry `capture` and `source`, where `initialize` means the request is honoured, `setting` that the CLI's file-checkpoint setting turned it off, `headless` that nothing asked, and `seat` or `interactive` name the CLI's own sessions; `facts` adds `restorable`, the user-message ids a rewind can return to. `run` has no `initialize` and captures nothing. After any accepted prompt input, including `send_prompt`, `steer` and `follow_up`, `last_prompt_id` is its user-message id. Pass it to `rewind(user_message_id, 'both', dry_run=True)`, then omit `dry_run` to restore. Modes are `code`, `conversation` and `both`; the typed receipt reports changed files and removed conversation rows.

`prewarm(**options)` or `connect(warm=True)` returns an unclaimed runner with `initialized['session_id'] is None`. Call `claim(session_id=..., model=..., effort=..., mode=..., resume=...)` before prompting. Warm workers reject boot-time identity flags; ordinary, resumed and continued sessions already have an identity. The unclaimed boot runs in the CLI's session-runner role, which withholds subagents and workflows unless the CLI setting `Crewmates while backgrounded` is on, offers the Contract tool and refuses `Sleep` beyond 300 seconds. `facts`, `rewind`, `stop_agent` and `resume_agent` return generated result types. Model, effort, permission mode and kit changes use `set_model`, `set_effort`, `set_mode` and `set_kit`.

## Inline tools and agents

```python
import asyncio
from mercury_cli_sdk import define_tool, run

async def main():
    greeting = define_tool('greeting', 'Return a greeting', {}, lambda _: 'Hello')
    task = await run('Use greeting to say hello', tools=[greeting])
    result = await task.outcome
    print(result['status'], result.get('answer'))
asyncio.run(main())
```

Both doors own the authenticated loopback MCP server for `tools`, close it on exit or failed startup, and merge it with `mcp`. Tool names `mcp__sdk-tools__<name>` are added to `allowed_tools` and existing inline custom-agent `tools` allowlists without mutating your options. `auto_allow_tools=False` keeps serving but leaves permission grants to you; explicit denials still apply. An unanswered headless ask produces `blocked`. `define_agent` validates definitions passed in `agent_defs`. `serve_tools(tools, name)` remains available for manually owned servers. Tool callbacks may accept a second `ToolContext` with a `cancelled` event for cooperative cancellation; keep the event loop running. `define_tool` accepts JSON Schema, a mapping such as `{'query': str, 'limit': int}`, or a TypedDict with NotRequired, Required and Annotated descriptions.

## Inputs, output schemas and launch options

A prompt accepts text, `list[InputBlock]` or an `AsyncIterable[str | InputRow]`. Block and iterable prompts automatically use input rows and close stdin when complete. `text_block(text)` builds text; `image_block(data, media_type)` accepts base64 text, bytes or `pathlib.Path`. For manual streaming use `input='rows'`, `send(row)` and `close_input()`. On the rows door the CLI writes nothing, not even `session`, until the first input row arrives, so `session`, `cancel` and `interrupt()` take effect once the first prompt is sent; `close_input()` on a run that sent no row ends it without an outcome. `outcome` is the final run outcome; listen to individual outcome rows for multi-turn input.

`structured_schema(json_schema, decode)` infers `TypedOutcome[T]` from the decoder when passed as `schema=` to `run`, `connect` or `session.prompt`; a `schema` also accepts a JSON Schema dictionary, JSON text or a schema file path. On `run` it is the `--schema` flag and shapes every turn; on `connect` it travels on `initialize` and shapes every turn of the session; `prompt(content, schema=...)` sends that turn's schema on its prompt row and overrides the session's for that turn, so one session can ask for a different shape each turn, and a turn without one carries no `structured`. Mercury holds the model to the schema and settles the turn with `structured`; a schema that is not a JSON Schema is refused before the turn starts, and `prompt` or `connect` raises `MercurySchemaError` with the CLI's issue at path `schema` and `outcome` None. A completed `structured` is decoded by the descriptor and read once more by the package (types, scalar constants/enums, object fields, array items, numeric ranges and string lengths), so a replayed fixture is held to the same shape; a mismatch raises `MercurySchemaError` with exact `issues` and the raw `outcome`. `validate_outcome` also validates recorded outcomes.

`RunOptions` includes `replay_to`, `restore_files`, `worktree`, `reasoning_mode`, `brief_file`, `brief_add_file` and `debug`. The keyword options of `run`, `run_sync`, `connect`, `connect_sync` and `prewarm` are typed by `RunKwargs` and `ConnectKwargs`, so a type checker reports a wrong name or value. `argv_of` previews flags; `extra_args` passes additional flags. Both doors accept an explicit executable or prefix array such as `mercury=['ssh', 'host', 'mercury']`. Otherwise discovery uses `MERCURY_BIN`; then the managed install, read as Mercury's own command reads it: `current.txt` under `MERCURY_VERSIONS_DIR`, else `versions` in the Mercury home (`MERCURY_CONFIG_DIR`, `MERCURY_HOME` or `~/.mercury`; `%USERPROFILE%\.mercury` on Windows), whose version directory's `mercury.mjs` is run on the Node runtime vendored beside it; then `mercury` on PATH; then the stable command the installer writes (`~/.local/bin/mercury`; `%LOCALAPPDATA%\Mercury\bin\mercury.cmd` on Windows) and `~/.mercury/bin/mercury`. No shell is involved: Mercury's managed command (`mercury`, `mercury.cmd`, `mercury.ps1`) resolves to that bundle, an npm-style `.cmd` shim to its JavaScript entry point, and a `mercury.cmd` beside a `mercury.mjs` to that bundle; any other command shim requires an explicit `[node, script]` array, and a managed command whose install is missing is refused with the pointer file it looked for. A `.mjs`, `.cjs` or `.js` executable such as a built `mercury.mjs` runs on `MERCURY_NODE` when set, else the runtime bundled beside it under `vendor/node`, else `node` from PATH.

## Test without a model

```python
import asyncio
from mercury_cli_sdk import run
from mercury_cli_sdk.testing import start_fixture_server, fixture_session_row, fixture_outcome_row

async def main():
    rows = [fixture_session_row(), fixture_outcome_row(answer='ok')]
    async with await start_fixture_server({'rows': rows}) as fixture:
        task = await run('test', mercury=fixture.mercury)
        assert (await task.outcome)['answer'] == 'ok'
asyncio.run(main())
```

`fixture_turn(overrides, prompt_id)` builds a correlated turn/outcome pair. You can also replay `task.rows`. Fixtures validate rows and RPC replies before listening; `'validate': False` in the fixture dictionary is for deliberately malformed-wire tests. `methods` holds ordered `{ result, before?, after? }` or `{ error }` replies; before/after and `answers` contain RPC messages. `received` records inputs and `inputCount` delays replay. Missing methods return method-not-found. Fixtures use neither a CLI nor model credentials and do not simulate the CLI's internal behaviour.

## Rows, errors and cleanup

`parse_row`, `row_of`, `input_row_of` and `validate` use generated schemas. `is_main_thread` separates subagent rows. Unknown types become `unknown_row` with `original_type`, raw payload and envelope; known extra fields are preserved. Schema-version changes and malformed known rows are rejected.

Non-completed turns resolve their outcome status (including failed authentication); refusals throw `MercuryRefusal`. Other specific `MercuryError` subclasses are `MercuryUsageError`, `MercuryExitError`, `MercurySpawnError`, `MercuryWireError` and `MercurySchemaError`. Exit/usage errors preserve the door and exit receipt; RPC errors preserve code and data. Check status rather than only exit code.

`cancel=asyncio.Event()` interrupts a run when the event is set. `interrupt`, `terminate` and `kill` are synchronous (not awaited) and signal the child with SIGINT, SIGTERM and SIGKILL; the exit is awaited through `exit`. On Windows, which delivers no signal, they end the process the way Node's child_process does, and `exit.signal` names the one the package sent. An interrupt the package sent always settles the turn as an `interrupted` outcome: the CLI writes that row itself where SIGINT reaches it, and where the child ends by the signal before writing one the package completes the turn with an `interrupted` outcome row folded from the rows it received. A signal the package did not send, and `terminate` or `kill`, raise `MercuryExitError`. Close handles in finally or with `async with`; `close` ends stdin, escalates after five seconds to termination, and after ten to killing. Normal host exit sends SIGTERM to live children; an unhandled killing signal cannot run cleanup, so long-running hosts should handle SIGTERM and close sessions.

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
