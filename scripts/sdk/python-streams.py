import asyncio
import json
import sys
from mercury_cli_sdk import *
from mercury_cli_sdk.testing import start_fixture_server

init = {'protocol': 1, 'runner': {'version': 'fixture', 'pid': 1}, 'session_id': 's'}
outcome = {'type': 'outcome', 'seq': 1, 'timestamp': 't', 'session_id': 's', 'turn': 1, 'schema': 1, 'turn_id': 't', 'status': 'completed', 'steps': 1, 'wall_ms': 1, 'usage': {'input_tokens': 0, 'cached_input_tokens': 0, 'cache_write_input_tokens': 0, 'output_tokens': 0}, 'models': {}, 'denials': []}
def child(script): return [sys.executable, '-u', '-c', script]

async def main():
    assert parse_row('\ufeff' + json.dumps(outcome)).ok
    assert row_of({'type': 'session', 'schema': True}).reason == 'schema_mismatch'
    assert row_of({'type': 'session', 'schema': 9}).schema == 9
    assert validate({'type': 'integer'}, 1.0)
    future = row_of({'type': 'future', 'seq': 7, 'timestamp': 't', 'parent_call_id': 'a'}).row
    assert future['seq'] == 7 and future['parent_call_id'] == 'a' and future['original_type'] == 'future'
    for row in ({'type': 'prompt', 'content': ''}, {'type': 'prompt', 'content': []}, {'type': 'shell', 'command': ' \r\n '}, {'type': 'note', 'to': '', 'content': 'x'}, {'type': 'note', 'to': 'a', 'content': ''}): assert not input_row_of(row).ok
    opts = RunOptions(mercury=child('pass'), mode='default')
    task = await run('override', options=opts, mode='sovereign')
    await task.exit
    assert task.options.prompt == 'override' and task.options.mode == 'sovereign' and opts.prompt is None and opts.mode == 'default'
    try: await task.send_prompt('dead')
    except MercuryError: pass
    else: raise AssertionError('write after exit')
    for script, reason, line in [("import sys;sys.stdout.buffer.write(b'\\xff\\n')", 'not_json', '\ufffd'), ("print('{bad')", 'not_json', '{bad')]:
        task = await run('x', mercury=child(script))
        try: await task.outcome
        except MercuryWireError as e: assert e.reason == reason and e.line.strip() == line and all(isinstance(i, Issue) for i in e.issues)
        else: raise AssertionError('invalid stream')
    for door in ('run', 'runner'):
        mercury = child("import sys;sys.stdout.write('x'*(33*1024*1024)+'\\n');sys.stdout.flush()")
        try:
            if door == 'run': await (await run('x', mercury=mercury)).outcome
            else: await connect(mercury=mercury)
        except MercuryWireError as e: assert isinstance(e.issues[0], Issue) and '33554432' in e.issues[0].message
        else: raise AssertionError('oversized frame accepted')
    for payload, error_type in [('{bad', MercuryWireError), (json.dumps({'jsonrpc': '2.0', 'method': 123}), MercuryWireError), (json.dumps({'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'bad input', 'data': {'x': 1}}}), MercuryError)]:
        try: await connect(mercury=child(f'import sys;sys.stdin.readline();print({payload!r})'))
        except error_type as e:
            if payload == '{bad': assert e.line.strip() == payload and e.reason == 'not_json'
            if error_type is MercuryError: assert not isinstance(e, MercuryWireError) and e.code == -32700 and e.data == {'x': 1}
        else: raise AssertionError('bad RPC accepted')
    script = f'''import json,sys,time
for line in sys.stdin:
 m=json.loads(line)
 if m['method']=='initialize': print(' \\n'+json.dumps({{'jsonrpc':'2.0','id':m['id'],'result':{init!r}}}).replace(',',',\\r'),flush=True)
 elif m['method']=='session/facts':
  time.sleep(.05)
  print(json.dumps({{'jsonrpc':'2.0','id':m['id'],'result':{{}}}}),flush=True)
'''
    async with await connect(mercury=child(script)) as session:
        default = METHODS['session/facts']['deadlineMs']
        try:
            METHODS['session/facts']['deadlineMs'] = 1
            assert await session.request('session/facts', timeout=None) == {}
            try: await session.request('session/facts')
            except MercuryError: pass
            else: raise AssertionError('deadline ignored')
        finally: METHODS['session/facts']['deadlineMs'] = default
    methods = {'initialize': [{'result': init}], 'session/facts': [{'result': {}, 'before': [{'jsonrpc':'2.0', 'method':'$/cancel_request','params':None}, {'jsonrpc':'2.0','method':'custom','params':{'x':1}}]}], 'agent/stop': [{'result':{}}, {'result':{}}], 'queue/add':[{'result':{'accepted':True}}, {'result':{'accepted':True}}]}
    assert validate(METHODS['$/cancel_request']['params'], None)
    try:
        async with await start_fixture_server({'methods':methods}): raise AssertionError('invalid cancellation fixture accepted')
    except ValueError as error: assert 'invalid fixture params' in str(error)
    async with await start_fixture_server({'methods':methods, 'validate':False}) as fixture:
        async with await connect(mercury=fixture.mercury) as session:
            try: await session.facts()
            except MercuryWireError as error: assert error.row_type == '$/cancel_request'
            else: raise AssertionError('malformed cancellation notification accepted')
    methods['session/facts'][0]['before'].pop(0)
    async with await start_fixture_server({'methods':methods, 'validate':False}) as fixture:
        shared = RunOptions(mercury=fixture.mercury)
        async with await connect(options=shared) as session:
            notices=[];session.on('notification',notices.append)
            await session.facts()
            assert notices == [{'method':'custom','params':{'x':1}}]
            await session.stop_agent('a');await session.stop_agent('a',None)
            await session.send_shell('echo x',id='shell-1',priority='next')
            await session.send_note('a','hi',id='note-1')
        assert shared.session_id is None
        assert all('note' not in m['params'] for m in fixture.received if m.get('method')=='agent/stop')
        assert [m['params']['id'] for m in fixture.received if m.get('method')=='queue/add']==['shell-1','note-1']
    for status, code in [('completed',0),('failed',1),('refused',1),('interrupted',1)]:
        async with await start_fixture_server({'rows':[{**outcome,'status':status}]}) as fixture:
            task=await run('runner',mercury=fixture.mercury)
            try: await task.outcome
            except MercuryRefusal: pass
            assert (await task.exit).code==code
    print('PASS Python stream errors, parser parity, options isolation, timeout control, method parity and fixture exits')

asyncio.run(main())
