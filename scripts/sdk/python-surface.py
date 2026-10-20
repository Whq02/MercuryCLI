import asyncio
import json
import sys
import urllib.request
from mercury_cli_sdk import *
from mercury_cli_sdk.testing import start_fixture_server

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
    async with await start_fixture_server({'methods': methods, 'answers': {'901': [{'jsonrpc': '2.0', 'method': 'row', 'params': fixture['outcome']}]}}) as server:
        async with await connect(mercury=server.mercury, on_permission_request=guard) as session:
            assert (await session.prompt('hello'))['status'] == 'completed'
            assert asks[0]['tool_name'] == 'Read'
            for name, spec in METHODS.items():
                if spec['from'] != 'host' or spec['kind'] != 'request' or name in ('initialize', 'queue/add'): continue
                assert await session.request(name, sample(spec['params'])) == sample(spec['result']), name
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
    async with await serve_tools([tool]) as server:
        def invoke():
            request = urllib.request.Request(server.config['url'], json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'echo', 'arguments': {'text': 'python inline'}}}).encode(), headers={**server.config['headers'], 'Content-Type': 'application/json'})
            return json.load(urllib.request.urlopen(request))
        assert (await asyncio.to_thread(invoke))['result']['content'][0]['text'] == 'python inline'
    assert define_agent({'description': 'reader', 'prompt': 'read only'})['prompt'] == 'read only'
    assert isinstance(input_row_of({'type': 'shell', 'command': 'echo'}), RowRead)
    print('PASS Python surface and sync wrappers')

asyncio.run(main())
