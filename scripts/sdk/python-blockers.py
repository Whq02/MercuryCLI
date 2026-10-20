import asyncio
import json
import sys
from mercury_cli_sdk import run_sync, connect_sync, connect
from mercury_cli_sdk.testing import start_fixture_server

init = {'protocol': 1, 'runner': {'version': 'fixture', 'pid': 1}, 'session_id': 's'}
outcome = {'type': 'outcome', 'seq': 1, 'timestamp': 't', 'session_id': 's', 'turn': 1, 'schema': 1, 'turn_id': 'turn-1', 'status': 'completed', 'steps': 1, 'wall_ms': 1, 'usage': {'input_tokens': 0, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0, 'output_tokens': 0}, 'models': {}, 'denials': []}
failures = []
script = f'''import json,sys
turn=0
for line in sys.stdin:
    m=json.loads(line)
    if m['method']=='initialize': print(json.dumps({{'jsonrpc':'2.0','id':m['id'],'result':{init!r}}}), flush=True)
    elif m['method']=='queue/add':
        turn+=1
        print(json.dumps({{'jsonrpc':'2.0','method':'row','params':{{'type':'turn','seq':turn,'timestamp':'t','session_id':'s','turn':turn,'state':'started','turn_id':'turn-'+str(turn),'message_ids':[m['params'].get('id','missing')]}}}}),flush=True)
        print(json.dumps({{'jsonrpc':'2.0','id':m['id'],'result':{{'accepted':True}}}}),flush=True)
        if turn==2:
            for n in (1,2): print(json.dumps({{'jsonrpc':'2.0','method':'row','params':{{**{outcome!r},'turn_id':'turn-'+str(n)}}}}),flush=True)
'''

async def check(name, fn):
    try:
        await fn()
        print('PASS', name, flush=True)
    except Exception as e:
        failures.append(name)
        print('FAIL', name, type(e).__name__, str(e), flush=True)

async def sync_inside_loop():
    result = run_sync('hello', mercury=[sys.executable, '-c', f'import json; print(json.dumps({outcome!r}))'])
    assert result.outcome['status'] == 'completed'
    with connect_sync(mercury=[sys.executable, '-u', '-c', script]) as session:
        assert session.initialized['protocol'] == 1

async def correlation():
    async with await connect(mercury=[sys.executable, '-u', '-c', script]) as session:
        await session.send_prompt('previous')
        assert (await asyncio.wait_for(session.prompt('current'), 2))['turn_id'] == 'turn-2'
    async with await connect(mercury=[sys.executable, '-u', '-c', script]) as session:
        try: await asyncio.wait_for(session.prompt('timed out'), .1)
        except asyncio.TimeoutError: pass
        assert (await asyncio.wait_for(session.prompt('current'), 2))['turn_id'] == 'turn-2'

async def void_handlers():
    asks = [{'jsonrpc': '2.0', 'id': i, 'method': method, 'params': params} for i, method, params in [
        (50, 'fs/write_text_file', {'path': '/fixture/file', 'content': 'x'}),
        (51, 'terminal/kill', {'terminal_id': 't'}), (52, 'terminal/release', {'terminal_id': 't'})]]
    async with await start_fixture_server({'methods': {'initialize': [{'result': init}], 'session/facts': [{'result': {}, 'before': asks}]}}) as fixture:
        async with await connect(mercury=fixture.mercury, partial=True, handlers={ask['method']: lambda p, c: None for ask in asks}) as session:
            await session.facts()
            await session.close()
        for ask in asks:
            assert next(m for m in fixture.received if m.get('id') == ask['id'])['result'] == {}
        assert fixture.received[0]['params']['capabilities']['partial_rows'] is True

async def main():
    await check('B4 sync APIs inside running loop', sync_inside_loop)
    await check('B5 prompt turn and timeout correlation', correlation)
    await check('B6 void host handlers', void_handlers)
    assert not failures, failures

asyncio.run(main())
