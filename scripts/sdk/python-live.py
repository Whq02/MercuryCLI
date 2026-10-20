import asyncio
import json
from pathlib import Path
import sys
from mercury_cli_sdk import run, connect, MercuryRefusal

mercury = json.loads(sys.argv[1])
cwd = sys.argv[2]


async def main():
    task = await run(input='rows', mercury=mercury, cwd=cwd, ephemeral=True)
    await task.send_prompt('hello Python')
    task.close_input()
    outcome = await asyncio.wait_for(task.outcome, 60)
    assert outcome['answer'] == 'Python run works.' and (await task.exit).code == 0
    print('PASS Python live run streaming input', flush=True)
    asks = []
    async def guard(ask, context):
        asks.append(ask)
        return {'outcome': 'deny', 'message': 'Python SDK host refused this write'}
    async with await connect(mercury=mercury, cwd=cwd, ephemeral=True, on_permission_request=guard) as session:
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

asyncio.run(main())
