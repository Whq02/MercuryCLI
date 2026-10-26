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

## Model selection

`model` uses the CLI's model ids and credentials. For a named OpenAI-compatible endpoint, pass `compat/<endpoint>/<model>` to `run`, `run_sync` or `connect`, for example `run_sync('Explain the README', model='compat/my-server/model-id')`. Replace the example with an available row from `/model` or `mercury://models`; `/llmhost` registers a server as a named compat endpoint. The same route works in `define_agent({'description': 'Reader', 'prompt': 'Read the project', 'model': 'compat/my-server/model-id'})` and `await session.set_model('compat/my-server/model-id')`.

With Mercury 1.0.0-beta.42 or newer, `compat`, `local` and `huggingface` also select through the CLI's resolver for that family. An unavailable class or an unknown named compat endpoint/model is refused, not replaced by another provider. A resumed session retains its recorded model unless you explicitly supply another; an unavailable recorded model refuses the resume. Tool results, streamed rows and structured output use the same SDK interfaces on compat and Anthropic models. Reasoning and usage rows report what the engine supplies; model capabilities remain the engine's.

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

`prompt` awaits its own correlated turn. Only one prompt wait may be active; `steer(content, id=..., schema=...)` queues priority `now` and `follow_up(content, id=..., schema=...)` queues `later`; both keyword options are optional. `send_prompt`, `send_shell` and `send_note` expose ids and all priorities; `withdraw(id)` removes queued input, and a `prompt` waiting on it raises `MercuryError('prompt: withdrawn')`. Cancelling the awaiting task cancels the wait, not the turn; `interrupt()` ends the turn. A prompt sent while a turn is still running (after a timed-out or cancelled wait, for instance) is the CLI's to place: with no tool round left it waits and runs as the next turn, which `prompt` resolves with; at a tool-round boundary the CLI folds it into the running turn and marks its reply `in_reply_to` that prompt, and `prompt` resolves with that turn's outcome instead (a per-turn `schema` on a folded prompt is not applied). When that turn ends without any reply and the CLI's `facts` list the prompt neither queued nor in a turn, `prompt` raises within five seconds `MercuryError('prompt: turn N ended STATUS and the runner holds this prompt neither queued nor in a turn; …')` rather than waiting forever; `interrupt()` the running turn, or await its outcome row, before prompting again when you need a turn of its own. Typed `request(method, params, timeout=seconds)` and `notify` cover protocol 1, including pause, quiesce, leave, MCP and schedules. `timeout=None` disables its timer. `connect(timeout=seconds)` bounds a boot that never answers; cancelling the awaiting task ends the child too.

`on_permission_request` and `on_elicitation` receive `RequestContext` with `id` and a `cancelled` event; absent handlers deny and decline respectively. `on_read_text_file` and `on_write_text_file` route native file tools to host buffers and infer their capabilities. The equivalent `handlers` entries work too. Supplying all five `terminal/*` handlers infers terminal support; partial terminal sets do not. Explicit `capabilities` override inference.

### Checkpoints, warm workers and control

`connect` asks the CLI to capture file checkpoints (`file_checkpoints: true` on `initialize`); `checkpoints=False` opts out. The CLI answers with what it does: `session.file_checkpoints` (the `initialize` answer) and `(await session.facts())['file_checkpoints']` carry `capture` and `source`, where `initialize` means the request is honoured, `setting` that the CLI's file-checkpoint setting turned it off, `headless` that nothing asked, and `seat` or `interactive` name the CLI's own sessions; `facts` adds `restorable`, the user-message ids a rewind can return to. File checkpoints over `initialize` need Mercury 1.0.0-beta.41 or newer: an older runner answers no `file_checkpoints`, so `session.file_checkpoints` is `None`, `session.supports['file_checkpoints']` is False and `facts()['file_checkpoints']` reads `capture: False` with no `source`. `run` has no `initialize` and captures nothing. After any accepted prompt input, including `send_prompt`, `steer` and `follow_up`, `last_prompt_id` is its user-message id. Pass it to `rewind(user_message_id, 'both', dry_run=True)`, then omit `dry_run` to restore. Modes are `code`, `conversation` and `both`; the typed receipt reports changed files and removed conversation rows.

`prewarm(**options)` or `connect(warm=True)` returns an unclaimed runner. On `MercurySession` and `SyncSession`, `session.session_id` reflects `initialized['session_id']`: both are None until `claim(session_id=..., model=..., effort=..., mode=..., resume=...)` succeeds and updates them from the CLI's reply. Only `session_id` is required. Prompt input before a claim fails immediately with `MercuryError('session is unclaimed; call claim() before prompting')`. Warm workers reject boot-time identity flags; ordinary, resumed and continued sessions already have an identity. The unclaimed boot runs in the CLI's session-runner role, which withholds subagents and workflows unless the CLI setting `Crewmates while backgrounded` is on, offers the Contract tool and refuses `Sleep` beyond 300 seconds. `facts`, `rewind`, `stop_agent` and `resume_agent` return generated result types. Model, effort, permission mode and kit changes use `set_model`, `set_effort`, `set_mode` and `set_kit`.

### Session method reference

This example uses a fresh session. The absent agent, server and checkpoint ids demonstrate refusal receipts without changing existing resources; use ids from `facts()` in an application. `set_kit` takes the runner's kit object, and `request` also exposes `session/file_restore` and `schedule/roster` without a convenience wrapper. `SyncSession` exposes the same methods without `await`.

```python
import asyncio
from mercury_cli_sdk import connect, MercuryError

async def main():
    async with await connect(ephemeral=True, timeout=30) as session:
        async def attempt(operation):
            try: print(await operation)
            except MercuryError as error:
                if error.code is None: raise
                print(error.code, error)
        async def turn(send):
            outcome = asyncio.get_running_loop().create_future()
            def done(row):
                if 'parent_call_id' not in row and not outcome.done(): outcome.set_result(row)
            session.on('outcome', done)
            try:
                await send
                print((await asyncio.wait_for(outcome, 30)).get('answer'))
            finally: session.off('outcome', done)
        facts = await session.facts()
        await session.set_model(facts['model']['effective'])
        await session.set_effort(facts.get('effort_sent') or 'max')
        await session.set_mode(facts['permission_mode'])
        await session.set_spawn_switch('subagents', facts.get('spawn_switches', {}).get('subagents', {}).get('on', True))
        await attempt(session.set_kit(None))
        await session.pause_gate(False)
        await session.quiesce('prepare', 'sdk-example-pause-token')
        await session.quiesce('cancel', 'sdk-example-pause-token')
        await turn(session.send({'type': 'prompt', 'content': 'Say hello'}))
        await turn(session.send_prompt('Summarise that'))
        await turn(session.steer('Name one next step'))
        await turn(session.follow_up('Finish with a short summary'))
        await session.withdraw('not-queued')
        await session.send_shell('echo sdk')
        await attempt(session.send_note('absent-agent', 'Hello'))
        await session.interrupt()
        await attempt(session.background_shell())
        await attempt(session.stop_agent('absent-agent'))
        await attempt(session.resume_agent('absent-agent'))
        await session.mcp_tools('absent-server')
        await session.mcp_action('absent-server', 'cancel-auth')
        await session.rewind('absent-prompt', 'code', dry_run=True)
        await session.request('session/file_restore', {'action': 'undo', 'user_message_id': 'absent-prompt', 'dry_run': True})
        await session.notify('credentials/changed', {})
        await session.notify_credentials_changed()
        session.clear_rows()
        await session.leave()
asyncio.run(main())
```

For an unclaimed worker, `prewarm` and `claim` separate process startup from session identity.

```python
import asyncio
import uuid
from mercury_cli_sdk import prewarm, assert_completed

async def main():
    session = await prewarm(ephemeral=True, timeout=30)
    try:
        await session.claim(session_id=str(uuid.uuid4()))
        outcome = await session.prompt('Say hello', timeout=30)
        print(assert_completed(outcome).get('answer'))
    finally: await session.close()
asyncio.run(main())
```

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

Both APIs own the authenticated loopback MCP server for `tools`, close it on exit or failed startup, and merge it with `mcp`. Tool names `mcp__sdk-tools__<name>` are added to `allowed_tools` and existing inline custom-agent `tools` allowlists without mutating your options. `auto_allow_tools=False` keeps serving but leaves permission grants to you; explicit denials still apply. An unanswered headless ask produces `blocked`. `define_agent` validates definitions passed in `agent_defs`. `serve_tools(tools, name)` remains available for manually owned servers. Tool callbacks may accept a second `ToolContext` with a `cancelled` event for cooperative cancellation; keep the event loop running. `define_tool` accepts JSON Schema, a mapping such as `{'query': str, 'limit': int}`, or a TypedDict with NotRequired, Required and Annotated descriptions.

## Inputs, output schemas and launch options

A prompt accepts text, `list[InputBlock]` or an `AsyncIterable[str | InputRow]`. Block and iterable prompts automatically use input rows and close stdin when complete. `text_block(text)` builds text; `image_block(data, media_type)` accepts base64 text, bytes or `pathlib.Path`. For manual streaming use `input='rows'`, `send(row)` and `close_input()`. On the rows interface the CLI writes nothing, not even `session`, until the first input row arrives, so `session`, `cancel` and `interrupt()` take effect once the first prompt is sent; `close_input()` on a run that sent no row ends it without an outcome. `outcome` is the final run outcome; listen to individual outcome rows for multi-turn input.

`structured_schema(json_schema, decode)` infers `TypedOutcome[T]` from the decoder when passed as `schema=` to `run`, `connect` or `session.prompt`; a `schema` also accepts a JSON Schema dictionary, JSON text or a schema file path. On `run` it is the `--schema` flag and shapes every turn; on `connect` it travels on `initialize` and as the `--schema` flag, so it shapes every turn of the session on every Mercury version; `prompt(content, schema=...)` sends that turn's schema on its prompt row and overrides the session's for that turn, so one session can ask for a different shape each turn, and a turn without one carries no `structured`. A per-turn schema needs Mercury 1.0.0-beta.41 or newer: an older runner ignores the field, so the package refuses it before sending with ``MercuryError('per-turn schema needs Mercury 1.0.0-beta.41 or newer; this runner is 1.0.0-beta.40 — run `mercury update`')``, and `session.supports['per_turn_schema']` beside `session.runner_version` says so in advance (`FEATURE_FLOORS` lists each floor; the version is read from the `initialize` answer, and an answer that already carries `file_checkpoints` counts as the newer wire). Where the runner honours the schema, Mercury holds the model to it and settles the turn with `structured`; a schema that is not a JSON Schema is refused before anything is sent — the package itself refuses an unknown `type`, non-object `properties` and the other keywords its reader indexes into (`schema_problem(schema)` returns the words), and the CLI refuses the rest with its own issue — so `run`, `prompt`, `steer`, `follow_up`, `send_prompt` or `connect` raises `MercurySchemaError` with the issue at path `schema` and `outcome` None, and no model turn is spent. A completed `structured` is decoded by the descriptor and read once more by the package (types, scalar constants/enums, object fields, array items, numeric ranges and string lengths), so a replayed fixture is held to the same shape; a mismatch raises `MercurySchemaError` with exact `issues` and the raw `outcome`. `validate_outcome` also validates recorded outcomes.

`RunOptions` includes `replay_to`, `restore_files`, `worktree`, `reasoning_mode`, `brief_file`, `brief_add_file` and `debug`. The keyword options of `run`, `run_sync`, `connect`, `connect_sync` and `prewarm` are typed by `RunKwargs` and `ConnectKwargs`, so a type checker reports a wrong name or value. `argv_of` previews flags; `extra_args` passes additional flags. Both APIs accept an explicit executable or prefix array such as `mercury=['ssh', 'host', 'mercury']`. Otherwise discovery uses `MERCURY_BIN`; then the managed install, read as Mercury's own command reads it: `current.txt` under `MERCURY_VERSIONS_DIR`, else `versions` in the Mercury home (`MERCURY_CONFIG_DIR`, `MERCURY_HOME` or `~/.mercury`; `%USERPROFILE%\.mercury` on Windows), whose version directory's `mercury.mjs` is run on the Node runtime vendored beside it; then `mercury` on PATH; then the stable command the installer writes (`~/.local/bin/mercury`; `%LOCALAPPDATA%\Mercury\bin\mercury.cmd` on Windows) and `~/.mercury/bin/mercury`; then, on macOS and Linux, the Homebrew command (`$HOMEBREW_PREFIX/bin/mercury`, `/opt/homebrew/bin/mercury`, `/usr/local/bin/mercury`, `/home/linuxbrew/.linuxbrew/bin/mercury`), for a host launched with a stripped PATH (an empty PATH skips this rung). No shell is involved: Mercury's managed command (`mercury`, `mercury.cmd`, `mercury.ps1`) resolves to that bundle, the Homebrew wrapper to the keg's `mercury.mjs` on its vendored runtime, an npm-style `.cmd` shim to its JavaScript entry point, and a `mercury.cmd` beside a `mercury.mjs` to that bundle; any other command shim requires an explicit `[node, script]` array, and a managed command whose install is missing is refused with the pointer file it looked for. A relative executable with a slash (`./bin/mercury`) is resolved against `cwd`; on Windows the `env` keys are read without regard to case, so a copy of the environment spelled `Path` and `Pathext` still resolves. A `.mjs`, `.cjs` or `.js` executable such as a built `mercury.mjs` runs on `MERCURY_NODE` when set (one that names no executable file is refused by name, as the launcher refuses it), else the runtime bundled beside it under `vendor/node`, else `node` from PATH.

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

## Inspect rows and schemas

Parsers return a `RowRead` with `ok`, `row` and `issues` rather than throwing; `assert_completed` and `validate_outcome` raise on an unsuccessful turn or a mismatched structured value respectively.

```python
import asyncio
import json
import mercury_cli_sdk as sdk

async def main():
    async with await sdk.run(input='rows') as task:
        def listener(row):
            if sdk.is_outcome(row): print(row.get('answer'))
        task.on('row', listener)
        await task.send_prompt([sdk.text_block('Say hello')])
        task.close_input()
        outcome = sdk.assert_completed(await task.outcome)
        task.off('row', listener)
        print(sdk.argv_of(sdk.RunOptions(prompt='Say hello')), sdk.outcome_failed(outcome), sdk.outcome_error_text(outcome), sdk.is_retryable_outcome(outcome))
        print(sdk.parse_row(json.dumps(outcome)), sdk.row_of(outcome), sdk.input_row_of({'type': 'prompt', 'content': 'Hi'}))
        print(sdk.is_row_type('text'), sdk.is_input_row_type('prompt'))
        print([(sdk.is_main_thread(row), sdk.is_session_row(row), sdk.turn_opened(row), sdk.turn_waiting(row), sdk.main_thread_step(row)) for row in task.rows])
        schema = sdk.structured_schema({'type': 'string'}, str)
        print(sdk.schema_problem(schema.json_schema), sdk.validate(schema.json_schema, 'hello'))
        print(sdk.validate_outcome({**outcome, 'structured': 'hello'}, schema)['structured'])
        print(sdk.schema_refusal({'code': -32601, 'message': 'not a schema error'}))
        print(sdk.image_block('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCfQAAAAASUVORK5CYII=', 'image/png')['media_type'])
        print(sdk.allow_permission(), sdk.deny_permission('Read-only host'))
        print(sdk.define_agent({'description': 'Reader', 'prompt': 'Read and report; do not edit'}))
        print(sdk.parse_version('1.0.0'), sdk.compare_versions('1.0.0', '1.0.1'), sdk.runner_support(None))
        tools = await sdk.serve_tools([])
        try: tools.cancel()
        finally: await tools.close()
        task.clear_rows()
asyncio.run(main())
```

`MercuryRun.send(row)`, `send_prompt`, `send_shell` and `send_note` accept the same input shapes as the session methods above. `interrupt()`, `terminate()` and `kill()` signal only that run's child; await `exit` afterward. For example, `task = await run('Inspect the project'); task.interrupt(); await task.exit` cancels a run. Replace `interrupt()` with `terminate()` or `kill()` when graceful interruption is not enough. `clear_rows()` clears retained rows and unread buffered rows, not listeners or the running turn.

The synchronous session also closes through its context manager.

```python
from mercury_cli_sdk import connect_sync, assert_completed

with connect_sync(timeout=30) as session:
    print(assert_completed(session.prompt('Say hello', timeout=30)).get('answer'))
```

## Rows, errors and cleanup

`parse_row`, `row_of`, `input_row_of` and `validate` use generated schemas. `is_main_thread` separates subagent rows. Unknown types become `unknown_row` with `original_type`, raw payload and envelope; known extra fields are preserved. Schema-version changes and malformed known rows are rejected.

Non-completed turns resolve their outcome status (including failed authentication); refusals raise `MercuryRefusal`. Call `assert_completed(outcome)` to raise `MercuryOutcomeError` for a non-completed outcome, including an unanswered permission ask; refusals remain `MercuryRefusal`. Both extend `MercuryError`. `MercuryOutcomeError` retains the original `outcome`, `error_class` and `detail`. Its message names the tool and how to grant permission or attach a host; the SDK does not grant permission automatically. Other specific subclasses are `MercuryUsageError`, `MercuryExitError`, `MercurySpawnError`, `MercuryWireError`, `MercurySchemaError`, `MercuryTimeoutError` and `MercuryConnectionError`. Exit/usage errors preserve the interface and exit receipt; RPC errors preserve code and data. Check status rather than only exit code.

`connect(timeout=seconds)` bounds initialization. `prompt(content, timeout=seconds)` bounds the whole wait, including queue acceptance; it does not stop the turn unless `interrupt_on_cancel=True` is supplied. A late acceptance still triggers that requested interrupt. `MercuryTimeoutError` carries `method` and `timeout`. Check `facts()` before resending work that may already have been accepted. Requests use the protocol's deadline unless `timeout` overrides it; initialization, prompts and `leave` have no default deadline. Use `request('session/leave', timeout=30)` to bound a leave. Python task cancellation remains `asyncio.CancelledError`.

`MercuryConnectionError` means the stream closed while the process remained alive, or a call was made during/after `close()`, including through `SyncSession`. Reconnect before sending more work. All pending requests and row iterators settle on a broken connection; normal `close()` ends iterators. Malformed known notifications raise `MercuryWireError`; unknown future notifications remain available through `on('notification', listener)`.

`stderr` holds what the child has written to standard error so far, read as text with `\r\n` normalised to `\n` (a Windows child's line endings included) so `exit.stderr`, the handle and the chunks agree; `on_stderr` (or an `on('stderr', …)` listener, also on `SyncSession`) receives each chunk as it arrives, on both APIs. `cancel=asyncio.Event()` interrupts a run when the event is set. `interrupt`, `terminate` and `kill` are synchronous (not awaited) and signal the child with SIGINT, SIGTERM and SIGKILL; the exit is awaited through `exit`. On Windows, which delivers no signal, they end the process the way Node's child_process does, and `exit.signal` names the one the package sent. An interrupt the package sent always settles the turn as an `interrupted` outcome: the CLI writes that row itself where SIGINT reaches it, and where the child ends by the signal before writing one the package completes the turn with an `interrupted` outcome row folded from the rows it received. A signal the package did not send, and `terminate` or `kill`, raise `MercuryExitError`. Close handles in finally or with `async with`; `close` ends stdin, escalates after five seconds to termination, and after ten to killing. Normal host exit sends SIGTERM to live children; an unhandled killing signal cannot run cleanup, so long-running hosts should handle SIGTERM and close sessions.

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

## Licence

Licensed under the Apache License 2.0 (`Apache-2.0`); see [LICENSE](LICENSE). The Mercury CLI is licensed under the same licence.
