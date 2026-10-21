import asyncio
import os
from pathlib import Path
import tempfile
import sys
import json
from urllib.request import Request, urlopen
from typing import TypedDict, Annotated, NotRequired
import mercury_cli_sdk as sdk
from mercury_cli_sdk import testing

failures = []


def example(schema):
    if 'const' in schema: return schema['const']
    if 'enum' in schema: return schema['enum'][0]
    if 'anyOf' in schema or 'oneOf' in schema: return example((schema.get('anyOf') or schema['oneOf'])[0])
    type = schema.get('type')
    if type == 'object': return {key: example(schema['properties'][key]) for key in schema.get('required', [])}
    if type == 'array': return []
    if type == 'string': return 'fixture'
    if type == 'boolean': return False
    if type == 'null': return None
    return max(1, schema.get('minimum', 0))


session_row = example(sdk.ROW_SCHEMAS['session'])
outcome = {**example(sdk.ROW_SCHEMAS['outcome']), 'status': 'completed', 'answer': 'ok'}
init = {'result': {'protocol': 1, 'runner': {'version': 'fixture', 'pid': 1}, 'session_id': 'fixture-session'}}


async def check(name, function):
    try:
        await function()
        print('PASS Python ' + name, flush=True)
    except Exception as error:
        failures.append(name)
        print('FAIL Python ' + name + ': ' + repr(error), flush=True)


async def inline():
    class Input(TypedDict):
        text: Annotated[str, 'Text to echo']
        count: NotRequired[int]
    began = asyncio.Event()
    async def execute(params, context):
        began.set()
        await context.cancelled.wait()
        return params['text']
    definition = sdk.define_tool('echo', 'Echo', Input, execute)
    assert definition.input_schema['required'] == ['text']
    assert definition.input_schema['properties']['text']['description'] == 'Text to echo'
    assert sdk.define_tool('mapped', 'Mapped', {'text': str, 'count': int}, lambda value: '').input_schema['properties']['count'] == {'type': 'integer'}
    assert sdk.define_tool('raw', 'Raw', {'additionalProperties': False}, lambda value: '').input_schema == {'additionalProperties': False}
    async with await sdk.serve_tools([definition]) as server:
        def post(body):
            request = Request(server.config['url'], json.dumps(body).encode(), {**server.config['headers'], 'Content-Type': 'application/json'})
            with urlopen(request, timeout=10) as response: return response.read()
        call = asyncio.create_task(asyncio.to_thread(post, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'echo', 'arguments': {'text': 'cancelled'}}}))
        await asyncio.wait_for(began.wait(), 5)
        await asyncio.to_thread(post, {'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': 1}})
        assert json.loads(await call)['result']['content'][0]['text'] == 'cancelled'


async def capabilities():
    handlers = {name: lambda params, context: {} for name in ['terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release']}
    for explicit in (None, {'terminal': False, 'fs_read_text_file': False}):
        async with await testing.start_fixture_server({'methods': {'initialize': [init]}}) as fixture:
            async with await sdk.connect(mercury=fixture.mercury, handlers=handlers, on_read_text_file=lambda params, context: {'content': ''}, capabilities=explicit):
                caps = fixture.received[0]['params']['capabilities']
                assert caps['terminal'] == (explicit is None) and caps['fs_read_text_file'] == (explicit is None)
    try: await sdk.connect(mercury=[sys.executable, '-c', 'raise SystemExit(2)'], warm=True, resume='saved')
    except sdk.MercuryError as error: assert str(error) == 'warm cannot be combined with session identity options'
    else: raise AssertionError('warm identity flags accepted')


async def structured():
    schema = {'type': 'object', 'properties': {'count': {'type': 'integer'}}, 'required': ['count']}
    with tempfile.TemporaryDirectory(prefix='sdk-schema-') as directory:
        Path(directory, 'schema.json').write_text(json.dumps(schema))
        args = sdk.argv_of(sdk.RunOptions(mercury='fixture', cwd=directory, schema='schema.json'))
        assert json.loads(args[args.index('--schema') + 1]) == schema
    async with await testing.start_fixture_server({'rows': [session_row, {**outcome, 'structured': {'count': 'bad'}}]}) as fixture:
        task = await sdk.run(mercury=fixture.mercury, schema=schema)
        try: await task.outcome
        except sdk.MercuryError as error:
            assert error.__class__.__name__ == 'MercurySchemaError'
            assert str(error) == 'structured output does not match schema: count'
            assert any('count' in issue.path for issue in error.issues)
        else: raise AssertionError('invalid structured output resolved')
    async with await testing.start_fixture_server({'rows': [session_row, {**outcome, 'structured': {'count': 7}}]}) as fixture:
        task = await sdk.run(mercury=fixture.mercury, schema=sdk.structured_schema(schema, lambda value: value['count']))
        assert (await task.outcome)['structured'] == 7
    async with await testing.start_fixture_server({'methods': {'initialize': [init], 'queue/add': [{'result': {'accepted': True}, 'after': [{'jsonrpc': '2.0', 'method': 'row', 'params': {**outcome, 'structured': {'count': 'bad'}}}]}]}}) as fixture:
        async with await sdk.connect(mercury=fixture.mercury) as session:
            try: await session.prompt('test', schema=schema)
            except sdk.MercurySchemaError: pass
            else: raise AssertionError('invalid prompt output resolved')
            assert 'schema' not in fixture.received[-1]['params']


async def rich():
    blocks = [sdk.text_block('hello'), sdk.image_block(b'image', 'image/png')]
    async with await testing.start_fixture_server({'rows': [session_row, outcome], 'inputCount': 1}) as fixture:
        task = await sdk.run(blocks, mercury=fixture.mercury)
        assert (await task.outcome)['status'] == 'completed'
        assert fixture.received[0]['content'] == blocks
    async def inputs():
        yield 'first'
        yield {'type': 'note', 'to': 'a', 'content': 'second'}
    async with await testing.start_fixture_server({'rows': [session_row, outcome], 'inputCount': 2}) as fixture:
        task = await sdk.run(inputs(), mercury=fixture.mercury)
        assert (await task.outcome)['status'] == 'completed'
        assert [row['type'] for row in fixture.received] == ['prompt', 'note']
    closed = asyncio.Event()
    async def endless():
        try:
            yield 'first'
            await asyncio.Event().wait()
        finally: closed.set()
    async with await testing.start_fixture_server({'rows': [session_row, outcome], 'inputCount': 1}) as fixture:
        task = await sdk.run(endless(), mercury=fixture.mercury)
        await task.outcome
        await asyncio.wait_for(closed.wait(), 2)
    async with await testing.start_fixture_server({'methods': {'initialize': [init], 'queue/add': [{'result': {'accepted': True}}, {'result': {'accepted': True}}]}}) as fixture:
        async with await sdk.connect(mercury=fixture.mercury) as session:
            await session.steer('now')
            await session.follow_up('later')
            assert [row['params']['priority'] for row in fixture.received if row.get('method') == 'queue/add'] == ['now', 'later']


async def factories():
    rows = [testing.fixture_session_row(), *testing.fixture_turn({'answer': 'fixture works'})]
    async with await testing.start_fixture_server({'rows': rows}) as fixture:
        task = await sdk.run(mercury=fixture.mercury)
        assert (await task.outcome)['answer'] == 'fixture works'


async def fixture_validation():
    for data in ({'rows': [{'type': 'outcome'}]}, {'methods': {'initialize': [{'result': {'protocol': 9}}]}}):
        try: server = await testing.start_fixture_server(data)
        except ValueError as error: assert 'invalid fixture' in str(error)
        else:
            await server.close()
            raise AssertionError('invalid fixture accepted')


async def flags():
    args = sdk.argv_of(sdk.RunOptions(mercury='fixture', worktree='branch', debug=True, reasoning_mode='enabled', brief_file='a', brief_add_file='b', replay_to='m1', restore_files='m2'))
    assert all(flag in args for flag in ['--worktree', '--debug', '--reasoning-mode', '--brief-file', '--brief-add-file', '--replay-to', '--restore-files'])
    with tempfile.TemporaryDirectory(prefix='sdk-discovery-') as directory:
        path = Path(directory)
        (path / 'entry.cjs').write_text('console.log(' + repr(__import__('json').dumps(session_row)) + '); console.log(' + repr(__import__('json').dumps(outcome)) + ')')
        shim = path / 'mercury.cmd'
        shim.write_text('@echo off\n"node" "%~dp0\\entry.cjs" %*\n')
        assert str(path / 'entry.cjs') in sdk.argv_of(sdk.RunOptions(env={**os.environ, 'MERCURY_BIN': str(shim)}))
        task = await sdk.run('quotes " & % ! | stay data', env={**os.environ, 'MERCURY_BIN': str(shim)})
        assert (await task.outcome)['status'] == 'completed'
        target = path / '.mercury/bin/mercury'
        target.parent.mkdir(parents=True)
        target.write_text('#!/bin/sh\nexit 0\n')
        target.chmod(0o755)
        assert sdk.argv_of(sdk.RunOptions(env={'HOME': directory, 'PATH': ''}))[0] == str(target)
        installed = sdk.argv_of(sdk.RunOptions(env={'HOME': directory, 'PATH': str(target.parent)}, project='/p'))
        assert installed[:6] == ['mercury', '--project', '/p', 'run', '--format', 'rows']


async def entry_point():
    with tempfile.TemporaryDirectory(prefix='sdk-entry-') as directory:
        path = Path(directory)
        entry = path / 'entry.mjs'
        entry.write_text('console.log(' + repr(json.dumps(session_row)) + '); console.log(' + repr(json.dumps(outcome)) + ')')
        named = sdk.argv_of(sdk.RunOptions(env={**os.environ, 'MERCURY_BIN': str(entry)}))
        assert named[1] == str(entry) and named[0].endswith('node'), named
        task = await sdk.run('x', env={**os.environ, 'MERCURY_BIN': str(entry)})
        assert (await task.outcome)['status'] == 'completed'
        runtime = path / 'vendor/node/bin/node'
        runtime.parent.mkdir(parents=True)
        runtime.write_text('#!/bin/sh\nexec node "$@"\n')
        runtime.chmod(0o755)
        assert sdk.argv_of(sdk.RunOptions(mercury=str(entry)))[0] == str(runtime)
        task = await sdk.run('x', mercury=str(entry))
        assert (await task.outcome)['status'] == 'completed'
        try: sdk.argv_of(sdk.RunOptions(mercury=str(path / 'missing.mjs')))
        except sdk.MercuryError as error: assert 'JavaScript entry point that does not exist' in str(error)
        else: raise AssertionError('a missing entry point was accepted')


async def sync():
    assert callable(getattr(sdk.SyncSession, 'facts', None)) and '__getattr__' not in vars(sdk.SyncSession)
    async with await testing.start_fixture_server({'methods': {'initialize': [init], 'queue/add': [{'result': {'accepted': True}, 'after': [{'jsonrpc': '2.0', 'method': 'row', 'params': outcome}]}], 'session/facts': [{'result': {}}]}}) as fixture:
        def consume():
            with sdk.connect_sync(mercury=fixture.mercury) as session:
                assert session.prompt('test')['status'] == 'completed'
                assert next(iter(session))['type'] == 'outcome'
                assert session.facts() == {}
        await asyncio.to_thread(consume)


async def main():
    for name, function in [('row 1 inferred schemas and cancellation', inline), ('rows 2 and 5 capability and warm options', capabilities), ('row 6 structured', structured), ('row 7 rich prompts', rich), ('row 8 factories', factories), ('row 8 fixture validation', fixture_validation), ('row 9 flags and executable discovery', flags), ('row 9 JavaScript entry points', entry_point), ('row 10 typed sync iteration', sync)]:
        await check(name, function)


asyncio.run(main())
if failures: raise SystemExit(1)
