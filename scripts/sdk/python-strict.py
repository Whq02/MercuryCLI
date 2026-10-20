import asyncio
from mercury_cli_sdk import (
    MercuryRefusal, MercuryRun, MercurySession, RunOptions, RequestContext, OutcomeRow, SessionRow, StreamRow, PermissionRequestParams, PermissionRequestResult,
    connect, run, run_sync, connect_sync, define_agent, define_tool, serve_tools, argv_of, parse_row, row_of, validate,
)
from mercury_cli_sdk.testing import start_fixture_server


def on_text(row: StreamRow) -> None:
    if row['type'] == 'text':
        print(row['text'])


async def guard(ask: PermissionRequestParams, context: RequestContext) -> PermissionRequestResult:
    return {'outcome': 'deny', 'message': 'read-only'}


async def main() -> None:
    task: MercuryRun = await run('Explain', mode='default', partial=True)
    task.on('text', on_text)
    async for row in task:
        if row['type'] == 'tool_call':
            print(row['tool'])
        if row['type'] == 'unknown_row':
            print(row['original_type'])
    outcome: OutcomeRow = await task.outcome
    print(outcome['status'], outcome.get('answer'))
    session_row: SessionRow = await task.session
    print(session_row['model'], (await task.exit).code)
    opts = RunOptions(mercury=['ssh', 'host', 'mercury'], schema={'type': 'object'}, config={'a': 1}, input='rows')
    print(argv_of(opts))
    session: MercurySession = await connect(on_permission_request=guard, partial=True)
    try:
        first = await session.prompt('Inspect')
        print(first['status'])
        facts = await session.facts()
        print(facts)
        await session.request('session/pause_gate', {'paused': False})
        await session.set_model('x')
        await session.send_prompt('more', id='abc', priority='next')
    except MercuryRefusal as error:
        print(error.outcome, error.error_class, error.detail, error.code)
    finally:
        await session.close()
    result = run_sync('hello')
    print(result.outcome['status'], len(result.rows), result.exit.code)
    with connect_sync() as sync_session:
        print(sync_session.prompt('x')['status'])
        print(sync_session.facts())
    tool = define_tool('greeting', 'Return a greeting', {'type': 'object', 'properties': {}}, lambda _: 'Hello')
    async with await serve_tools([tool]) as tools:
        agent = define_agent({'description': 'Reviewer', 'prompt': 'Review.', 'tools': ['Read']})
        task2 = await run('Review', agent='reviewer', agent_defs={'reviewer': agent}, mcp=[tools.mcp])
        print((await task2.outcome).get('answer'))
    async with await start_fixture_server({'rows': task.rows}) as fixture:
        task3 = await run('test', mercury=fixture.mercury)
        print((await task3.outcome)['status'], fixture.received)
    read = parse_row('{}')
    if read.ok and read.row is not None:
        print(read.row['type'])
    print(row_of({'type': 'x'}).reason, validate({'type': 'string'}, 1))


asyncio.run(main())
