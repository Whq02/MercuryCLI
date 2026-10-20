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
            if row['type'] == 'text':
                print(row['text'])
            if row['type'] == 'unknown_row':
                print(row['original_type'])
        outcome = await task.outcome
        print(outcome['status'], outcome['answer'])
        print((await task.exit).code)
    except MercuryRefusal as error:
        print(error)
asyncio.run(main())
```

`run()` creates `MercuryRun`, an async row iterator with `.on()` listeners. `.session`, `.outcome` and `.exit` are awaitable; `.rows` retains received rows. `interrupt()`, `terminate()` and `kill()` signal the child. A failed model turn resolves an outcome with a non-completed status; a refused request raises `MercuryRefusal`. `async with await run(...)` closes the child on exit.

For streaming stdin, use `await run(input='rows')`, then await `send_prompt(content)`, `send_shell(command)` or `send_note(agent_id, content)`. `send(row)` accepts any generated `InputRow`. Call `close_input()` when input is complete. The process stays open while stdin is open; `.outcome` resolves to its final outcome when it exits. Observe individual outcomes with `.on('outcome', ...)`.

## Host a session

```python
import asyncio
from mercury_cli_sdk import connect

async def guard(ask, context):
    print(ask['tool_name'], ask['input'])
    return {'outcome': 'deny', 'message': 'This host is read-only'}

async def main():
    session = await connect(on_permission_request=guard)
    try:
        session.on('text', lambda row: print(row['text']))
        first = await session.prompt('Inspect the tests')
        print(first['status'])
        second = await session.prompt('Explain the result')
        print(second['answer'])
        print(await session.facts())
        await session.request('session/pause_gate', {'paused': False})
    finally:
        await session.close()
asyncio.run(main())
```

`connect()` initializes JSON-RPC protocol 1. `MercurySession` exposes `prompt`, `send_prompt`, `send_shell`, `send_note`, `withdraw`, `interrupt`, `facts`, `set_model`, `set_effort`, `set_mode`, `set_kit`, `rewind`, `stop_agent`, `resume_agent` and `claim`. `request(method, params)` and `notify(method, params)` validate all declared host methods, including MCP inspection, pause/quiesce/leave and schedule updates. Their parameter and result TypedDicts are generated in `mercury_cli_sdk.generated` and exported from the package.

Use `send_prompt` rather than overlapping `prompt` calls to queue words during a turn. `prompt` awaits the next outcome; use a single active turn when you need that association. `on_permission_request` and `on_elicitation` may be sync or async functions. Other runner requests use the `handlers` mapping; explicitly advertise corresponding file/terminal capabilities. No permission handler means deny; no elicitation handler means decline. `RequestContext.cancelled` is set and the callback task cancelled when the runner cancels its ask. `claim` works only when the runner permits it; a normal standalone runner already has a session identity.

Both doors accept `mercury=['ssh', 'host', 'mercury']` or another executable/argument array. `RunOptions` collects options; `argv_of(options)` previews arguments. `extra_args` passes CLI flags without a shell. `close()` ends stdin and terminates an unresponsive child after five seconds.

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
        agent = define_agent({'description': 'Read-only reviewer',
                              'prompt': 'Review; do not edit.', 'tools': ['Read']})
        task = await run('Review the README', agent='reviewer',
                         agent_defs={'reviewer': agent}, mcp=[tools.mcp])
        print((await task.outcome)['answer'])
```

Tools use authenticated loopback MCP HTTP through the existing `--mcp` option, not a private runner method. `ToolServer` exposes `.config`, `.mcp` and async `.close()`. Keep the host event loop running while tools execute. Agent definitions become `--agent-defs` JSON. Normal Mercury tool permissions still apply.

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

The same generator emits both language packages' schema tables and types. `parse_row`, `row_of`, `input_row_of` return `RowRead`; `validate` returns `Issue` objects. Known malformed rows fail validation; a changed session/outcome schema version is rejected. An unfamiliar type becomes `{'type': 'unknown_row', 'original_type': ..., 'raw': ...}` without losing its payload. Extra fields on known rows are retained.

Five specific errors derive from `MercuryError`: `MercuryRefusal`, `MercuryUsageError`, `MercuryExitError`, `MercurySpawnError` and `MercuryWireError`. RPC errors retain `.code` and `.data`; RPC refusals have `.outcome is None`. Read the outcome's status rather than treating an exit code alone as a completed turn.

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
