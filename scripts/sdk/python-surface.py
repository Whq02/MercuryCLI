import asyncio
import json
import sys
import typing
import mercury_cli_sdk.generated as generated
import urllib.request
import urllib.error
from mercury_cli_sdk import *
from mercury_cli_sdk.testing import start_fixture_server

for name in generated.__all__:
    value = getattr(generated, name)
    if typing.is_typeddict(value): typing.get_type_hints(value)
fixture = json.load(open(sys.argv[1]))
for row in fixture['rows']:
    read = parse_row(json.dumps(row))
    assert read.ok and read.row == row, read
assert row_of(fixture['future']).row['raw'] == fixture['future']


def sample(schema):
    if 'const' in schema: return schema['const']
    if 'enum' in schema: return schema['enum'][0]
    if 'oneOf' in schema or 'anyOf' in schema: return sample(schema.get('oneOf', schema.get('anyOf'))[0])
    t = schema.get('type')
    if isinstance(t, list): t = t[0]
    if t == 'object': return {k: sample(schema['properties'][k]) for k in schema.get('required', [])}
    if t == 'array': return []
    if t == 'string': return 'x' * schema.get('minLength', 1)
    if t == 'boolean': return False
    if t in ('integer', 'number'): return max(schema.get('minimum', 0), schema.get('exclusiveMinimum', -1) + 1)
    return None


async def main():
    rows = [fixture['session'], fixture['future'], fixture['outcome']]
    async with await start_fixture_server({'rows': rows, 'inputCount': 3}) as server:
        task = await run(input='rows', mercury=server.mercury)
        await task.send_prompt('hello')
        await task.send_shell('echo hello')
        await task.send_note('agent', 'hello')
        task.close_input()
        assert (await task.outcome)['answer'] == 'fixture answer'
        assert [r['type'] for r in server.received] == ['prompt', 'shell', 'note']
        assert task.rows[1]['type'] == 'unknown_row'
    methods = fixture['methods']
    asks = []
    async def guard(ask, context):
        asks.append(ask)
        return {'outcome': 'deny', 'message': 'fixture policy'}
    handlers = {name: (lambda params, context, spec=spec: sample(spec['result'])) for name, spec in METHODS.items() if spec['from'] == 'runner' and spec['kind'] == 'request'}
    async with await start_fixture_server({'methods': methods, 'answers': {'901': [{'jsonrpc': '2.0', 'method': 'row', 'params': fixture['outcome']}]}}) as server:
        async with await connect(mercury=server.mercury, handlers=handlers, on_permission_request=guard) as session:
            assert (await session.prompt('hello'))['status'] == 'completed'
            assert asks[0]['tool_name'] == 'Read'
            notices = []
            session.on('notification', lambda message: notices.append(message['method']))
            for name, spec in METHODS.items():
                if spec['from'] != 'host' or spec['kind'] != 'request' or name in ('initialize', 'queue/add'): continue
                assert await session.request(name, sample(spec['params'])) == sample(spec['result']), name
            for name, spec in METHODS.items():
                if spec['from'] != 'runner' and spec['kind'] == 'notification': await session.notify(name, sample(spec['params']))
            assert {'session/applied', 'elicitation/complete'}.issubset(notices)
            await asyncio.sleep(0)
            answers = [r for r in server.received if isinstance(r.get('id'), int) and r['id'] >= 1000 and 'result' in r]
            assert len(answers) == len(handlers), answers
            close_errors = []
            session.on('error', close_errors.append)
            await session.close()
            assert not close_errors
            try:
                while True: await session.__anext__()
            except StopAsyncIteration: pass
        for name, spec in METHODS.items():
            if spec['from'] != 'runner' and spec['kind'] == 'notification': assert any(r.get('method') == name for r in server.received), name
    async with await start_fixture_server({'rows': rows}) as server:
        result = await asyncio.to_thread(run_sync, 'hello', mercury=server.mercury)
        assert result.outcome['answer'] == 'fixture answer' and result.exit.code == 0
    async with await start_fixture_server({'methods': methods, 'answers': {'901': [{'jsonrpc': '2.0', 'method': 'row', 'params': fixture['outcome']}]}}) as server:
        def synchronous():
            with connect_sync(mercury=server.mercury) as session:
                assert session.prompt('hello')['status'] == 'completed'
                assert isinstance(session.facts(), dict)
        await asyncio.to_thread(synchronous)
    tool = define_tool('echo', 'Echo', {'type': 'object', 'properties': {'text': {'type': 'string'}}, 'required': ['text']}, lambda args: args['text'])
    async with await serve_tools([tool, define_tool('empty', 'Empty input', {'type': 'object'}, lambda args: json.dumps(args))]) as server:
        def invoke():
            request = urllib.request.Request(server.config['url'], json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'echo', 'arguments': {'text': 'python inline'}}}).encode(), headers={**server.config['headers'], 'Content-Type': 'application/json'})
            return json.load(urllib.request.urlopen(request))
        assert (await asyncio.to_thread(invoke))['result']['content'][0]['text'] == 'python inline'
        def helper_errors():
            def call(name, arguments):
                payload = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments}}
                request = urllib.request.Request(server.config['url'], json.dumps(payload).encode(), headers={**server.config['headers'], 'Content-Type': 'application/json'})
                return json.load(urllib.request.urlopen(request))
            assert call('missing', {})['error']['message'] == 'unknown tool'
            assert call('empty', None)['result']['content'][0]['text'] == '{}'
            request = urllib.request.Request(server.config['url'], method='DELETE', headers={**server.config['headers'], 'Origin': 'https://example.invalid'})
            try: urllib.request.urlopen(request)
            except urllib.error.HTTPError as error: assert error.code == 403
            else: raise AssertionError('cross-origin delete accepted')
        await asyncio.to_thread(helper_errors)
        print('PASS Python helper unknown tool, null arguments and DELETE origin checks')
    assert define_agent({'description': 'reader', 'prompt': 'read only'})['prompt'] == 'read only'
    assert isinstance(input_row_of({'type': 'shell', 'command': 'echo'}), RowRead)
    conv_names = ('mcp/tools', 'mcp/action', 'session/pause_gate', 'session/quiesce', 'session/leave', 'session/set_spawn_switch', 'shell/background', 'session/send_now')
    conv_methods = {'initialize': methods['initialize'] * 2, **{name: [{'result': sample(METHODS[name]['result'])}, {'result': sample(METHODS[name]['result'])}] for name in conv_names}}
    async with await start_fixture_server({'methods': conv_methods}) as server:
        async with await connect(mercury=server.mercury) as session:
            assert await session.mcp_tools('srv') == conv_methods['mcp/tools'][0]['result']
            assert await session.mcp_action('srv', 'reconnect') == conv_methods['mcp/action'][0]['result']
            assert await session.pause_gate(True) == conv_methods['session/pause_gate'][0]['result']
            assert await session.quiesce('prepare', 'tok') == conv_methods['session/quiesce'][0]['result']
            assert await session.leave() == conv_methods['session/leave'][0]['result']
            assert await session.set_spawn_switch('subagents', True) == conv_methods['session/set_spawn_switch'][0]['result']
            assert await session.background_shell() == conv_methods['shell/background'][0]['result']
            assert await session.send_now() == conv_methods['session/send_now'][0]['result']
            await session.notify_credentials_changed()
        def sync_conv():
            with connect_sync(mercury=server.mercury) as session:
                assert session.mcp_tools('srv') == conv_methods['mcp/tools'][1]['result']
                assert session.mcp_action('srv', 'reconnect') == conv_methods['mcp/action'][1]['result']
                assert session.pause_gate(True) == conv_methods['session/pause_gate'][1]['result']
                assert session.quiesce('prepare', 'tok') == conv_methods['session/quiesce'][1]['result']
                assert session.leave() == conv_methods['session/leave'][1]['result']
                assert session.set_spawn_switch('subagents', True) == conv_methods['session/set_spawn_switch'][1]['result']
                assert session.background_shell() == conv_methods['shell/background'][1]['result']
                assert session.send_now() == conv_methods['session/send_now'][1]['result']
                session.notify_credentials_changed()
        await asyncio.to_thread(sync_conv)
        assert sum(1 for r in server.received if r.get('method') == 'credentials/changed') == 2
    assert allow_permission(input={'a': 1}) == {'outcome': 'allow', 'input': {'a': 1}}
    assert deny_permission('no', stop=True) == {'outcome': 'deny', 'message': 'no', 'stop': True}
    assert is_retryable_outcome({**fixture['outcome'], 'status': 'failed', 'error': {'message': '429', 'class': 'rate_limit'}})
    assert not is_retryable_outcome({**fixture['outcome'], 'status': 'failed', 'error': {'message': '401', 'class': 'auth'}})
    assert assert_completed(fixture['outcome'])['status'] == 'completed'
    try: assert_completed({**fixture['outcome'], 'status': 'failed', 'error': {'message': 'boom', 'class': 'internal'}})
    except MercuryError: pass
    else: raise AssertionError('assert_completed accepted failed outcome')
    try: assert_completed({**fixture['outcome'], 'status': 'refused', 'error': {'message': 'nope', 'class': 'option'}})
    except MercuryRefusal: pass
    else: raise AssertionError('assert_completed accepted refused outcome')
    print('PASS Python surface and sync wrappers')

asyncio.run(main())
