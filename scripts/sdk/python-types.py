from typing import Any, assert_type
from mercury_cli_sdk import *


async def consumer() -> None:
    task = await run('typed')
    assert_type(await task.session, SessionRow)
    assert_type(await task.outcome, OutcomeRow)
    assert_type(await task.exit, RunExit)
    session = await connect()
    assert_type(session.initialized, InitializeResult)
    assert_type(await session.exit, RunExit)
    assert_type(await session.send({'type': 'prompt', 'content': 'x'}), QueueAddResult)
    assert_type(await session.send_prompt('x'), QueueAddResult)
    assert_type(await session.send_shell('x'), QueueAddResult)
    assert_type(await session.send_note('a', 'x'), QueueAddResult)
    assert_type(await session.facts(), SessionFactsResult)
    assert_type(await session.interrupt(), TurnInterruptResult)
    assert_type(await session.withdraw('id'), QueueWithdrawResult)
    assert_type(await session.set_model('model'), SessionSetModelResult)
    assert_type(await session.set_effort('high'), SessionSetEffortResult)
    assert_type(await session.set_mode('default'), SessionSetModeResult)
    assert_type(await session.set_kit({}), SessionSetKitResult)
    assert_type(await session.rewind('id', 'conversation'), SessionRewindResult)
    assert_type(await session.stop_agent('a'), AgentStopResult)
    assert_type(await session.resume_agent('a'), AgentResumeResult)
    assert_type(await session.claim(session_id='id'), SessionClaimResult)
    assert_type(await session.request('session/facts'), SessionFactsResult)
    assert_type(await session.request('session/pause_gate', {'paused': False}), SessionPauseGateResult)
    assert_type(await session.request('session/set_model', {'model': 'x'}, timeout=None), SessionSetModelResult)
    assert_type(ROWS_SCHEMA, int)
    assert_type(MAX_LINE_BYTES, int)
    assert_type(ROW_TYPES, list[str])
    assert_type(OUTCOME_EXIT_CODES, dict[str, int])
    assert_type(METHODS, dict[str, MethodSchema])
    assert_type(ROW_SCHEMAS, dict[str, Any])
    assert_type(MercuryWireError('', 'invalid').issues, list[Issue])


async def typed_results() -> None:
    session = await connect()
    facts = await session.facts()
    assert_type(facts['usage']['total_cost_usd'], float)
    if 'work' in facts:
        assert_type(facts['work'][0]['status'], str)
    if 'file_checkpoints' in facts:
        assert_type(facts['file_checkpoints']['restorable'], list[str])
    rewind = await session.rewind('id', 'both')
    if 'code' in rewind:
        assert_type(rewind['code']['files_changed'], list[str])
