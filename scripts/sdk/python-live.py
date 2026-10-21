import asyncio
import json
import os
from pathlib import Path
import sys
from typing import TypedDict, Annotated, NotRequired
from mercury_cli_sdk import run, connect, MercuryRefusal, serve_tools, define_tool, define_agent

from mercury_cli_sdk.testing import start_fixture_server

mercury = json.loads(sys.argv[1])
cwd = sys.argv[2]


async def main():
    task = await run(input='rows', mercury=mercury, cwd=cwd, ephemeral=True)
    await task.send_prompt('hello Python')
    task.close_input()
    outcome = await asyncio.wait_for(task.outcome, 60)
    assert outcome['answer'] == 'Python run works.' and (await task.exit).code == 0
    async with await start_fixture_server({'rows': task.rows}) as replay:
        consumer = await run('replay', mercury=replay.mercury)
        assert await consumer.outcome == outcome
    print('PASS Python live run streaming input and recorded-row replay', flush=True)
    asks = []
    async def guard(ask, context):
        asks.append(ask)
        return {'outcome': 'deny', 'message': 'Python SDK host refused this write'}
    async with await connect(mercury=mercury, cwd=cwd, ephemeral=True, partial=True, on_permission_request=guard) as session:
        assert session.initialized['protocol'] == 1
        first = await asyncio.wait_for(session.prompt('write the file'), 60)
        assert first['status'] == 'completed' and len(first['denials']) == 1
        assert asks[0]['tool_name'] == 'Write'
        assert not Path(cwd, 'denied-python.txt').exists()
        try: await session.set_mode('not-a-mode')
        except MercuryRefusal as error: assert error.code == -32010 and error.data['kind'] == 'mode'
        else: raise AssertionError('mode must be refused')
        started = asyncio.Event()
        session.on('row', lambda row: started.set() if row['type'] == 'wait' and row.get('state') == 'done' and row.get('turn') == 2 else None)
        second = asyncio.create_task(session.prompt('hold open'))
        await asyncio.wait_for(started.wait(), 60)
        id = '11111111-1111-4111-8111-111111111111'
        assert (await session.send_prompt('a prompt mid-turn', id=id, priority='next'))['accepted']
        assert (await session.withdraw(id))['withdrawn']
        facts = await session.facts()
        assert 'queue' in facts and 'usage' in facts
        assert (await session.interrupt())['interrupted']
        assert (await asyncio.wait_for(second, 60))['status'] == 'interrupted'
    print('PASS Python live runner initialize, host permission, mid-turn queue/add, withdrawal, interrupt, facts and refusal', flush=True)
    class Echo(TypedDict):
        text: Annotated[str, 'The text to echo']
        count: NotRequired[int]
    def execute(p, context):
        assert not context.cancelled.is_set()
        return p['text']
    tool = define_tool('echo', 'Echo', Echo, execute)
    assert tool.input_schema['required'] == ['text']
    assert tool.input_schema['properties']['text']['description'] == 'The text to echo'
    agent = define_agent({'description': 'SDK reader', 'prompt': 'Use echo.', 'tools': ['Read']})
    task = await run('Use echo', mercury=mercury, cwd=cwd, mode='default', ephemeral=True, tools=[tool], agent='sdk-reader', agent_defs={'sdk-reader': agent})
    assert (await task.outcome)['status'] == 'completed'
    assert any(r['type'] == 'tool_result' and 'Python inline result' in r['output'] for r in task.rows)
    assert 'sdk-reader' in (await task.session)['agents']
    print('PASS Python live inline MCP callback and agent definition', flush=True)

    task = await run('save identity', mercury=mercury, cwd=cwd)
    await task.outcome
    id = (await task.session)['session_id']
    for options in ({'resume': id}, {'continue_': True}):
        async with await connect(mercury=mercury, cwd=cwd, **options) as resumed:
            assert resumed.initialized['session_id'] == id
    async with await connect(mercury=mercury, cwd=cwd, warm=True) as warm:
        assert warm.initialized['session_id'] is None
        await warm.claim(session_id='00000000-0000-4000-8000-000000000098')
    print('PASS Python real runner resume, continue and warm claim', flush=True)

asyncio.run(main())
