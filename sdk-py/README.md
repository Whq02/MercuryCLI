# Mercury CLI SDK

`mercury-cli-sdk` 0.1.0 is a zero-runtime-dependency Python client for Mercury CLI. It drives an installed `mercury` process, not an embedded model runtime. Install Mercury separately and sign in through the CLI. The SDK uses that CLI's configuration and credentials; it does not bundle a CLI or sign you in.

Requires Python 3.11 or later. The package is Apache-2.0; the CLI has its own licence. The SDK is versioned and released separately from the CLI.

```sh
python -m pip install mercury-cli-sdk
```

## Run a task

```python
import asyncio
from mercury_cli_sdk import run, MercuryRefusal

async def main():
    task = await run(
        'Explain the failing test without changing files',
        mode='default', partial=True,
    )
    try:
        async for row in task:
            if row['type'] == 'text_delta':
                print(row['text'], end='', flush=True)
            if row['type'] == 'tool_call':
                print(row['tool'])
            if row['type'] == 'unknown_row':
                print(row['original_type'])
        outcome = await task.outcome
        if outcome['status'] != 'completed':
            print(outcome['status'], outcome.get('error', {}).get('message'))
        print(outcome.get('answer'), outcome['usage'], (await task.exit).code)
    except MercuryRefusal as error:
        print(error)
asyncio.run(main())
```

`run()` creates `MercuryRun`, an async row iterator with `.on()` listeners. `.session`, `.outcome` and `.exit` are awaitable; `.rows` retains received rows. `interrupt()`, `terminate()` and `kill()` signal the child; `close()` ends stdin and waits for the exit, and `async with await run(...)` does that on exit. `cancel=asyncio.Event()` in the options interrupts the run when set. A turn that did not complete resolves an outcome with another status and an `error` (a CLI that is not signed in answers `failed` with `error['class'] == 'auth'`); `answer` is absent then, so read it with `.get()`. A refused request raises `MercuryRefusal`. `text` rows carry whole blocks; with `partial=True` the `text_delta` rows stream them as they arrive. The row dictionaries are the generated `TypedDict`s, so `row['type'] == 'text'` narrows them under pyright.

For streaming stdin, use `await run(input='rows')`, then await `send_prompt(content)`, `send_shell(command)` or `send_note(agent_id, content)`. `send(row)` accepts any generated `InputRow`. Call `close_input()` when input is complete. The process stays open while stdin is open; `.outcome` resolves to its final outcome when it exits. Observe individual outcomes with `.on('outcome', ...)`.

## Host a session

```python
import asyncio
from mercury_cli_sdk import PermissionRequestParams, PermissionRequestResult, RequestContext, connect

async def guard(ask: PermissionRequestParams, context: RequestContext) -> PermissionRequestResult:
    print(ask['tool_name'], ask['input'])
    return {'outcome': 'deny', 'message': 'This host is read-only'}

async def main():
    async with await connect(on_permission_request=guard) as session:
        session.on('text', lambda row: print(row['text']))
        first = await session.prompt('Inspect the tests')
        print(first['status'])
        second = await session.prompt('Explain the result')
        print(second.get('answer'))
        print(await session.facts())
        await session.request('session/pause_gate', {'paused': False})
asyncio.run(main())
```

`connect()` initializes JSON-RPC protocol 1. `MercurySession` exposes `prompt`, `send_prompt`, `send_shell`, `send_note`, `withdraw`, `interrupt`, `facts`, `set_model`, `set_effort`, `set_mode`, `set_kit`, `rewind`, `stop_agent`, `resume_agent` and `claim`. `request(method, params)` and `notify(method, params)` validate all declared host methods, including MCP inspection, pause/quiesce/leave and schedule updates. Their parameter and result TypedDicts are generated in `mercury_cli_sdk.generated` and exported from the package; `request(..., timeout=seconds)` overrides a method's declared deadline (`timeout=None` disables it).

`prompt` resolves with the outcome of the turn its words started, even when other input is queued; a second `prompt` while one is pending raises, so queue mid-turn words with `send_prompt`. Cancelling the awaiting task (`asyncio.wait_for`) stops the wait, not the turn; `interrupt()` ends the turn. `on_permission_request` and `on_elicitation` may be sync or async functions (`PermissionHandler`, `ElicitationHandler`). Other runner requests use the `handlers` mapping; explicitly advertise corresponding file/terminal capabilities. No permission handler means deny; no elicitation handler means decline. `RequestContext.cancelled` is set and the callback task cancelled when the runner cancels its ask. `claim` works only when the runner permits it; a normal standalone runner already has a session identity.

Both doors accept `mercury=['ssh', 'host', 'mercury']` or another executable/argument array. `RunOptions` collects options (`continue_=True` is `--continue`); `argv_of(options)` previews arguments. `extra_args` passes CLI flags without a shell. `close()` ends stdin and terminates an unresponsive child after five seconds, then kills it after ten seconds if it still has not exited. A host that exits normally or through an exception sends SIGTERM to the children it still has (an `atexit` hook); a host killed by a signal it does not handle cannot, so handle `SIGTERM` and close sessions in long-running hosts.

### Synchronous programs

```python
from mercury_cli_sdk import run_sync, connect_sync

result = run_sync('Explain the README')
print(result.outcome['answer'])
with connect_sync() as session:
    print(session.prompt('Explain the tests')['answer'])
```

`run_sync` returns `RunResult(outcome, rows, exit)`. `connect_sync` returns `SyncSession`, forwarding session calls to a background asyncio loop. Use the async API inside an existing event loop. Host callbacks execute on that loop; they must not call the synchronous wrapper recursively.

## Inline tools and agents

```python
from mercury_cli_sdk import define_agent, define_tool, serve_tools, run

async def review():
    tool = define_tool('greeting', 'Return a greeting',
                       {'type': 'object', 'properties': {}}, lambda _: 'Hello')
    async with await serve_tools([tool]) as tools:
        agent = define_agent({'description': 'Read-only reviewer', 'prompt': 'Review; do not edit.',
                              'tools': ['Read', 'mcp__sdk-tools__greeting']})
        task = await run('Review the README', agent='reviewer', agent_defs={'reviewer': agent},
                         mcp=[tools.mcp], allowed_tools=['mcp__sdk-tools__greeting'])
        outcome = await task.outcome
        print(outcome['status'], outcome.get('answer', outcome['denials']))
```

Tools use authenticated loopback MCP HTTP through the existing `--mcp` option, not a private runner method. `serve_tools(tools, name='sdk-tools')` returns a `ToolServer` with `.config`, `.mcp` and async `.close()`; each tool is named `mcp__<name>__<tool>` in the session. Keep the host event loop running while tools execute. Agent definitions become `--agent-defs` JSON; an agent's `tools` list is an allowlist, so name the inline tool there or omit `tools` to inherit everything. Normal Mercury tool permissions still apply: a headless run cannot ask, so grant the tool with `allowed_tools` (or host a session and answer the ask), otherwise the call is denied and the outcome is `blocked` with the call in `denials`.

## Test without a model

```python
from mercury_cli_sdk import run
from mercury_cli_sdk.testing import start_fixture_server

async def test(recorded_rows):
    async with await start_fixture_server({'rows': recorded_rows}) as fixture:
        task = await run('test', mercury=fixture.mercury)
        assert (await task.outcome)['status'] == 'completed'
```

Supply rows captured from `task.rows`. The loopback replay server uses neither an installed CLI nor model credentials. For runner tests, `methods` maps method names to ordered `{result, before?, after?}` or `{error}` replies. `before` and `after` hold complete RPC messages. `answers` maps a host-request id to messages emitted after its answer. `received` records consumer inputs; `inputCount` delays run-row replay until that many stdin rows arrive. Missing recorded methods answer method-not-found instead of calling a provider. Fixtures model only the recording, not the CLI's internal behaviour.

## Rows and errors

The same generator emits both language packages' schema tables and types. `parse_row`, `row_of`, `input_row_of` return `RowRead`; `validate` returns `Issue` objects; `is_main_thread(row)` tells the main conversation's rows from a subagent's. Known malformed rows fail validation; a changed session/outcome schema version is rejected. An unfamiliar type becomes `{'type': 'unknown_row', 'original_type': ..., 'raw': ...}` with its envelope fields copied beside it, without losing its payload. Extra fields on known rows are retained.

Five specific errors derive from `MercuryError`: `MercuryRefusal` (run outcome or RPC refusal), `MercuryUsageError` (the CLI refused the command line, exit 2), `MercuryExitError` (the process ended before an outcome row or before the session was closed), `MercurySpawnError` (cannot launch: no such executable or working directory) and `MercuryWireError` (invalid frame). `MercuryUsageError` and `MercuryExitError` carry `.door` (`'run'` or `'runner'`) and `.exit` (code, signal, stderr) and quote the CLI's own stderr line; RPC errors retain `.code` and `.data`; RPC refusals have `.outcome is None`. Read the outcome's status rather than treating an exit code alone as a completed turn.

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
