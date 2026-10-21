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
    with connect_sync(on_permission_request=lambda ask, context: {'outcome': 'deny', 'message': ask['tool_name'] + str(context.id)}, mode='default', partial=True, timeout=30) as sync_session:
        print(sync_session.prompt('x')['status'])
        print(sync_session.facts())
    typed_task = await run('Explain', model='m', effort='high', mode='dontAsk', allowed_tools=['Read'], max_turns=3, budget_usd=1.5, worktree=True, debug='rpc', cancel=asyncio.Event())
    print(run_sync('hello', mode='default', partial=True).outcome['status'], typed_task.child.pid)
    typed_session = await connect(on_elicitation=lambda ask, context: {'action': 'decline'}, mode='default', timeout=5, schema={'type': 'object'}, checkpoints=False)
    checkpoints = typed_session.file_checkpoints
    if checkpoints is not None: print(checkpoints['capture'], checkpoints['source'])
    await typed_session.close()
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


from typing import Any, NotRequired, assert_type
from mercury_cli_sdk import (
    InitializeResultFile_checkpoints, SessionFactsResult, SessionRewindResult, AgentStopResult, AgentResumeResult, QueueAddResult, TypedOutcome, TypedRunResult,
    PromptContent, PromptInput, StepRow, TurnRow, RowType, PartialRowType, InputRowType,
    is_outcome, is_session_row, turn_opened, turn_waiting, main_thread_step, is_main_thread, outcome_failed, outcome_error_text, is_row_type, is_input_row_type,
    text_block, image_block, structured_schema, prewarm,
)


async def typed_output_and_warm() -> None:
    def decode(value: Any) -> int: return int(value['count'])
    descriptor = structured_schema({'type': 'object', 'properties': {'count': {'type': 'integer'}}}, decode)
    content: PromptContent = [text_block('hi'), image_block(b'x', 'image/png')]
    prompt_input: PromptInput = content
    task = await run(prompt_input, schema=descriptor)
    assert_type(await task.outcome, TypedOutcome[int])
    opt_tool = define_tool('opt', 'Optional mapping field', {'q': str, 'limit': NotRequired[int]}, lambda _: 'ok')
    assert opt_tool.input_schema['required'] == ['q']
    session = await connect()
    assert_type(await session.prompt('typed', schema=descriptor), TypedOutcome[int])
    warm = await prewarm()
    assert_type(warm, MercurySession)
    await warm.close()


def typed_predicates(row: StreamRow | None, kind: str, typed_result: TypedRunResult[int]) -> None:
    assert_type(typed_result.outcome, TypedOutcome[int])
    if is_row_type(kind):
        assert_type(kind, RowType | PartialRowType)
    if is_input_row_type(kind):
        assert_type(kind, InputRowType)
    if is_outcome(row):
        assert_type(row, OutcomeRow)
        assert_type(outcome_failed(row), bool)
        assert_type(outcome_error_text(row), str | None)
    if is_session_row(row):
        assert_type(row, SessionRow)
    if turn_opened(row):
        assert_type(row, TurnRow)
    if turn_waiting(row):
        assert_type(row, TurnRow)
    if main_thread_step(row):
        assert_type(row, StepRow)
        assert_type(is_main_thread(row), bool)


def typed_sync() -> None:
    with connect_sync() as session:
        assert_type(session.prompt('test'), OutcomeRow)
        assert_type(session.facts(), SessionFactsResult)
        assert_type(session.request('session/facts'), SessionFactsResult)
        assert_type(session.rewind('id', 'code'), SessionRewindResult)
        assert_type(session.stop_agent('a'), AgentStopResult)
        assert_type(session.resume_agent('a'), AgentResumeResult)
        assert_type(session.send_prompt('test'), QueueAddResult)
        assert_type(session.last_prompt_id, str | None)
        assert_type(session.file_checkpoints, InitializeResultFile_checkpoints | None)
        assert_type(next(iter(session)), StreamRow)
