# Mercury CLI SDK

`mercury-cli-sdk` 0.1.0 is a zero-runtime-dependency Python client for Mercury CLI, requiring Python 3.11 or later. Install Mercury separately and sign in through the CLI; the SDK uses its configuration and credentials. The package is Apache-2.0 and versioned separately from the CLI.

```sh
python -m pip install mercury-cli-sdk
```

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

`prompt` awaits its own correlated turn. Only one prompt wait may be active; `steer(content)` queues priority `now` and `follow_up(content)` queues `later`. `send_prompt`, `send_shell` and `send_note` expose ids and all priorities; `withdraw(id)` removes queued input. Cancelling the awaiting task cancels the wait, not the turn; `interrupt()` ends the turn. Typed `request(method, params, timeout=seconds)` and `notify` cover protocol 1, including pause, quiesce, leave, MCP and schedules. `timeout=None` disables its timer.

`on_permission_request` and `on_elicitation` receive `RequestContext` with `id` and a `cancelled` event; absent handlers deny and decline respectively. `on_read_text_file` and `on_write_text_file` route native file tools to host buffers and infer their capabilities. The equivalent `handlers` entries work too. Supplying all five `terminal/*` handlers infers terminal support; partial terminal sets do not. Explicit `capabilities` override inference.

### Checkpoints, warm workers and control

Headless sessions do not capture file checkpoints. `checkpoint_files=True` on either door boots the CLI in its session-runner role, which captures them; that role also withholds subagents and workflows unless the CLI setting `Crewmates while backgrounded` is on, offers the Contract tool and refuses `Sleep` beyond 300 seconds, so leave it off for a session that delegates. The CLI's file-checkpoint setting still applies: inspect `(await session.facts()).get('file_checkpoints')`. After an accepted `prompt`, `last_prompt_id` is its user-message id. Pass it to `rewind(user_message_id, 'both', dry_run=True)`, then omit `dry_run` to restore. Modes are `code`, `conversation` and `both`; the typed receipt reports changed files and removed conversation rows.

`prewarm(**options)` or `connect(warm=True)` returns an unclaimed runner with `initialized['session_id'] is None`. Call `claim(session_id=..., model=..., effort=..., mode=..., resume=...)` before prompting. Warm workers run in the session-runner role above and reject boot-time identity flags; ordinary, resumed and continued sessions already have an identity. `facts`, `rewind`, `stop_agent` and `resume_agent` return generated result types. Model, effort, permission mode and kit changes use `set_model`, `set_effort`, `set_mode` and `set_kit`.

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

A prompt accepts text, `list[InputBlock]` or an `AsyncIterable[str | InputRow]`. Block and iterable prompts automatically use input rows and close stdin when complete. `text_block(text)` builds text; `image_block(data, media_type)` accepts base64 text, bytes or `pathlib.Path`. For manual streaming use `input='rows'`, `send(row)` and `close_input()`. `outcome` is the final run outcome; listen to individual outcome rows for multi-turn input.

`structured_schema(json_schema, decode)` infers `TypedOutcome[T]` from the decoder when passed as `schema=` to `run` or `session.prompt`. A boot-time `schema` also accepts a JSON Schema dictionary, JSON text or a schema file path. Completed structured results are validated locally; failures raise `MercurySchemaError` with exact `issues` and the raw `outcome`. `prompt(..., schema=...)` validates locally only; it does not change the runner's boot-time schema. `validate_outcome` also validates recorded outcomes. The local reader checks types, scalar constants/enums, object fields, array items, numeric ranges and string lengths; use a decoder for additional constraints.

`RunOptions` includes `replay_to`, `restore_files`, `worktree`, `reasoning_mode`, `brief_file`, `brief_add_file` and `debug`. `argv_of` previews flags; `extra_args` passes additional flags. Both doors accept an explicit executable or prefix array such as `mercury=['ssh', 'host', 'mercury']`. Otherwise discovery uses `MERCURY_BIN`, then PATH, then `~/.mercury/bin/mercury` and `~/.local/bin/mercury`. Standard Node command shims are resolved to their JavaScript entry point without a shell; other command shims require an explicit executable array. A `.mjs`, `.cjs` or `.js` executable such as a built `mercury.mjs` runs on the Node runtime bundled beside it under `vendor/node`, or else on `node` from PATH.

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

`cancel=asyncio.Event()` interrupts a run when the event is set. `interrupt`, `terminate` and `kill` signal the child. Close handles in finally or with `async with`; `close` ends stdin, escalates after five seconds to termination, and after ten to killing. Normal host exit sends SIGTERM to live children; an unhandled killing signal cannot run cleanup, so long-running hosts should handle SIGTERM and close sessions.

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
