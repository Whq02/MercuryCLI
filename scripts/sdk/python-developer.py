import asyncio
import os
from pathlib import Path
import re
import shutil
import tempfile
import sys
import json
import time
from contextlib import contextmanager, suppress
from urllib.request import Request, urlopen
from typing import TypedDict, Annotated, NotRequired
import mercury_cli_sdk as sdk
from mercury_cli_sdk import testing
from mercury_cli_sdk.executable import executable_of

failures = []
WINDOWS_HOST = os.name == 'nt'


def runtime_stand_in(path):
    if WINDOWS_HOST:
        node = shutil.which('node')
        assert node, 'node on PATH stands in for a vendored runtime on a Windows host'
        try: os.link(node, path)
        except OSError: shutil.copyfile(node, path)
    else:
        path.write_text('#!/bin/sh\nexec node "$@"\n')
        path.chmod(0o755)
    return path


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
    for options, asked in (({}, True), ({'checkpoints': False}, False), ({'checkpoints': True}, True)):
        answered = {'result': {**init['result'], 'file_checkpoints': {'capture': asked, 'source': 'initialize' if asked else 'headless'}}}
        replies = [{'result': {'accepted': False, 'reason': 'duplicate'}}, {'result': {'accepted': True}, 'after': [{'jsonrpc': '2.0', 'method': 'row', 'params': outcome}]}]
        async with await testing.start_fixture_server({'methods': {'initialize': [answered], 'queue/add': replies}}) as fixture:
            async with await sdk.connect(mercury=fixture.mercury, **options) as session:
                assert fixture.received[0]['params']['file_checkpoints'] is asked, (options, fixture.received[0]['params'])
                assert session.options.session_id is None and 'MERCURY_CONCOURSE_WORKER' not in (session.options.env or {}), options
                assert session.file_checkpoints == answered['result']['file_checkpoints']
                try: await session.prompt('refused by the queue')
                except sdk.MercuryError as error: assert 'prompt was not accepted' in str(error)
                else: raise AssertionError('a refused prompt resolved')
                assert session.last_prompt_id is None
                assert (await session.prompt('accepted'))['status'] == 'completed'
                assert isinstance(session.last_prompt_id, str)


@contextmanager
def prompt_fixture(correlated=False, warm=False):
    with tempfile.TemporaryDirectory(prefix='sdk-prompts-') as directory:
        record = Path(directory, 'received.jsonl')
        record.write_text('')
        script = r'''
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const emit = message => process.stdout.write(JSON.stringify(message) + '\n')
let claimed = CLAIMED
const cancelled = []
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  appendFileSync(RECORD, line + '\n')
  const { id, method, params } = message
  const reply = result => emit({ jsonrpc: '2.0', id, result })
  if (method === 'initialize') reply({ protocol: 1, runner: { version: 'fixture', pid: 1 }, session_id: claimed ? 'fixture-session' : null })
  else if (method === 'session/claim') {
    if (params.session_id === 'rejected') emit({ jsonrpc: '2.0', id, error: { code: -32602, message: 'claim rejected' } })
    else { claimed = true; reply({ session_id: 'claimed-session' }) }
  } else if (method === 'queue/withdraw') reply(params.id === 'keep' ? { withdrawn: false, reason: 'taken' } : { withdrawn: true, text: 'queued' })
  else if (method === 'queue/add' && claimed) {
    if (params.content === 'error') { emit({ jsonrpc: '2.0', id, error: { code: -32603, message: 'queue failed' } }); return }
    reply(params.content === 'reject' ? { accepted: false, reason: 'duplicate' } : { accepted: true })
    if (params.content === 'cancel') { cancelled.push(params.id); emit({ jsonrpc: '2.0', method: 'fixture/queued', params: { id: params.id } }) }
    if (params.content === 'resolve') {
      for (const queued of cancelled.splice(0)) {
        if (CORRELATED) emit({ jsonrpc: '2.0', method: 'row', params: { ...TURN, turn_id: 'cancelled-turn', message_ids: [queued] } })
        emit({ jsonrpc: '2.0', method: 'row', params: { ...OUTCOME, turn_id: 'cancelled-turn', answer: 'cancelled' } })
      }
      if (CORRELATED) emit({ jsonrpc: '2.0', method: 'row', params: { ...TURN, message_ids: [params.id] } })
      emit({ jsonrpc: '2.0', method: 'row', params: OUTCOME })
    }
  }
})
'''
        script = script.replace('CLAIMED', json.dumps(not warm)).replace('CORRELATED', json.dumps(correlated)).replace('RECORD', json.dumps(str(record))).replace('TURN', json.dumps(testing.fixture_turn()[0])).replace('OUTCOME', json.dumps(testing.fixture_outcome_row(answer='resolved')))
        yield ['node', '-e', script, '--'], lambda: [json.loads(line) for line in record.read_text().splitlines()]


async def prompt_ids():
    with prompt_fixture() as (mercury, received):
        async with await sdk.connect(mercury=mercury) as session:
            await session.steer('x')
            assert isinstance(session.last_prompt_id, str), 'steer exposes its generated prompt id'
            assert (await session.withdraw(session.last_prompt_id))['withdrawn']
            assert not session._prompt_turns, 'withdraw removes the turn entry'
            schema = {'type': 'object'}
            await session.steer('now', id='steered', schema=schema)
            assert session.last_prompt_id == 'steered'
            await session.follow_up('later', id='followed', schema=schema)
            assert session.last_prompt_id == 'followed'
            await session.send_prompt('sent', id='sent')
            assert session.last_prompt_id == 'sent'
            await session.send({'type': 'prompt', 'content': 'direct', 'id': 'direct'})
            assert session.last_prompt_id == 'direct'
            assert not (await session.send_prompt('reject', id='rejected'))['accepted']
            assert session.last_prompt_id == 'direct'
            rows = [row['params'] for row in received() if row['method'] == 'queue/add']
            assert [(row['id'], row['priority'], row['schema']) for row in rows[1:3]] == [('steered', 'now', schema), ('followed', 'later', schema)]
            await session.send_prompt('kept', id='keep')
            assert not (await session.withdraw('keep'))['withdrawn']
            assert 'keep' in session._prompt_turns, 'an unsuccessful withdrawal preserves the entry'


async def prompt_withdrawal(correlated):
    with prompt_fixture(correlated) as (mercury, received):
        async with await sdk.connect(mercury=mercury) as session:
            await session.steer('x')
            queued = next(row['params']['id'] for row in received() if row['method'] == 'queue/add')
            assert (await session.withdraw(session.last_prompt_id or queued))['withdrawn']
            assert (await asyncio.wait_for(session.prompt('resolve'), 0.5))['answer'] == 'resolved'
            assert not session._prompt_turns, 'withdrawn prompts leave no turn entries'


async def prompt_withdrawn_wait(correlated):
    with prompt_fixture(correlated) as (mercury, received):
        async with await sdk.connect(mercury=mercury) as session:
            task = asyncio.create_task(session.prompt('queued'))
            try:
                for _ in range(200):
                    if session.last_prompt_id is not None: break
                    await asyncio.sleep(0.005)
                assert session.last_prompt_id is not None and (await session.withdraw(session.last_prompt_id))['withdrawn']
                try: await asyncio.wait_for(task, 0.5)
                except sdk.MercuryError as error: assert str(error) == 'prompt: withdrawn', str(error)
                else: raise AssertionError('a withdrawn prompt resolved')
                assert not session._prompt_turns, 'the withdrawn wait leaves no turn entry'
                assert (await asyncio.wait_for(session.prompt('resolve'), 0.5))['answer'] == 'resolved', 'the session takes the next prompt'
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError, sdk.MercuryError): await task


async def prompt_error_reply(correlated):
    with prompt_fixture(correlated) as (mercury, received):
        async with await sdk.connect(mercury=mercury) as session:
            for send in (lambda: session.send_prompt('error'), lambda: session.steer('error'), lambda: session.follow_up('error'), lambda: session.send({'type': 'prompt', 'content': 'error'})):
                try: await send()
                except sdk.MercuryError as error: assert error.code == -32603 and str(error) == 'queue failed', repr(error)
                else: raise AssertionError('input the runner answered with an error was accepted')
            assert not session._prompt_turns, 'input the runner answered with an error leaves no turn entry'
            assert (await asyncio.wait_for(session.prompt('resolve'), 0.5))['answer'] == 'resolved', 'input the runner refused cannot hold the next outcome'


async def prompt_schema_refused_locally():
    with prompt_fixture() as (mercury, received), tempfile.TemporaryDirectory(prefix='sdk-schema-missing-') as directory:
        async with await sdk.connect(mercury=mercury) as session:
            for schema, words in (('{not json', 'invalid schema JSON'), (str(Path(directory, 'no-such-schema.json')), 'could not read schema file: ')):
                try: await session.prompt('resolve', schema=schema)
                except sdk.MercuryError as error: assert str(error).startswith(words), str(error)
                else: raise AssertionError('a refused schema was sent')
            assert (await asyncio.wait_for(session.prompt('resolve'), 0.5))['answer'] == 'resolved', 'a refused schema leaves no prompt pending'
            assert len([row for row in received() if row['method'] == 'queue/add']) == 1, 'a refused schema never reaches the wire'


async def prompt_cancellation(correlated):
    with prompt_fixture(correlated) as (mercury, received):
        async with await sdk.connect(mercury=mercury) as session:
            queued = asyncio.Event()
            session.on('notification', lambda message: queued.set() if message['method'] == 'fixture/queued' else None)
            task = asyncio.create_task(session.prompt('cancel'))
            try:
                await asyncio.wait_for(queued.wait(), 1)
                task.cancel()
                with suppress(asyncio.CancelledError): await task
                assert task.cancelled(), 'the prompt wait was cancelled'
                assert (await asyncio.wait_for(session.prompt('resolve'), 0.5))['answer'] == 'resolved', "the cancelled turn's outcome is not the next prompt's answer"
                assert not session._prompt_turns, "the cancelled turn's own outcome retires its entry"
                assert not any(row['method'] == 'turn/interrupt' for row in received()), 'cancellation still cancels only the wait'
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError): await task


async def sync_prompt_ids():
    with prompt_fixture() as (mercury, received):
        def consume():
            with sdk.connect_sync(mercury=mercury) as session:
                session.steer('x')
                assert isinstance(session.last_prompt_id, str)
                assert session.withdraw(session.last_prompt_id)['withdrawn']
                assert not session.session._prompt_turns
                schema = {'type': 'object'}
                session.steer('now', id='steered', schema=schema)
                assert session.last_prompt_id == 'steered'
                session.follow_up('later', id='followed', schema=schema)
                assert session.last_prompt_id == 'followed'
                rows = [row['params'] for row in received() if row['method'] == 'queue/add']
                assert [(row['id'], row['priority'], row['schema']) for row in rows[1:]] == [('steered', 'now', schema), ('followed', 'later', schema)]
        await asyncio.to_thread(consume)


async def warm_identity():
    message = 'session is unclaimed; call claim() before prompting'
    for warm in (False, True):
        with prompt_fixture(True, True) as (mercury, received):
            async with await (sdk.connect(mercury=mercury, warm=True) if warm else sdk.prewarm(mercury=mercury)) as session:
                assert session.initialized['session_id'] is None
                for send in (lambda: session.prompt('unclaimed'), lambda: session.send_prompt('unclaimed'), lambda: session.steer('unclaimed'), lambda: session.follow_up('unclaimed'), lambda: session.send({'type': 'prompt', 'content': 'unclaimed'})):
                    start = time.perf_counter()
                    try: await send()
                    except sdk.MercuryError as error: assert str(error) == message, str(error)
                    else: raise AssertionError('unclaimed prompt was accepted')
                    elapsed = time.perf_counter() - start
                    assert elapsed < 0.05, f'an unclaimed prompt took {elapsed * 1000} ms'
                    print(f'PASS Python warm prompt refused locally in {elapsed * 1000:.2f} ms', flush=True)
                assert not any(row['method'] == 'queue/add' for row in received())
                assert session.last_prompt_id is None and session.session_id is None and not session._prompt_turns
                try: await session.claim(session_id='rejected')
                except sdk.MercuryError as error: assert str(error) == 'claim rejected'
                else: raise AssertionError('a rejected claim resolved')
                assert session.session_id is None
                receipt = await session.claim(session_id='requested-session', model='fixture', mode='default', effort='high', resume=False)
                assert session.session_id == receipt['session_id'] == session.initialized['session_id'] == 'claimed-session'
                assert (await asyncio.wait_for(session.prompt('resolve'), 0.5))['answer'] == 'resolved'
    with prompt_fixture(True, True) as (mercury, received):
        def consume():
            with sdk.connect_sync(mercury=mercury, warm=True) as session:
                assert session.session_id is None and session.initialized['session_id'] is None
                start = time.perf_counter()
                try: session.prompt('unclaimed')
                except sdk.MercuryError as error: assert str(error) == message, str(error)
                else: raise AssertionError('unclaimed sync prompt was accepted')
                assert time.perf_counter() - start < 0.05
                receipt = session.claim(session_id='requested-session', model='fixture', mode='default', effort='high', resume=False)
                assert session.session_id == receipt['session_id'] == session.initialized['session_id'] == 'claimed-session'
                assert session.prompt('resolve')['answer'] == 'resolved'
        await asyncio.to_thread(consume)


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
    refusal = {'error': {'code': -32602, 'message': 'invalid params for queue/add', 'data': {'method': 'queue/add', 'issues': [{'path': ['schema'], 'message': 'the prompt row carries a schema that is not a JSON schema — data/type must be equal to one of the allowed values'}]}}}
    replies = [{'result': {'accepted': True}, 'after': [{'jsonrpc': '2.0', 'method': 'row', 'params': {**outcome, 'structured': {'count': 'bad'}}}]}, refusal, {'result': {'accepted': True}, 'after': [{'jsonrpc': '2.0', 'method': 'row', 'params': {**outcome, 'structured': {'count': 4}}}]}]
    async with await testing.start_fixture_server({'methods': {'initialize': [init], 'queue/add': replies}}) as fixture:
        async with await sdk.connect(mercury=fixture.mercury, schema={'type': 'object'}) as session:
            assert fixture.received[0]['params']['schema'] == {'type': 'object'}
            assert '--schema' not in sdk.argv_of(sdk.RunOptions(mercury=fixture.mercury, schema={'type': 'object'}), 'runner')
            try: await session.prompt('test', schema=schema)
            except sdk.MercurySchemaError as error: assert error.outcome is not None
            else: raise AssertionError('invalid prompt output resolved')
            assert next(m for m in fixture.received if m.get('method') == 'queue/add')['params']['schema'] == schema
            try: await session.prompt('refused', schema=schema)
            except sdk.MercurySchemaError as error:
                assert error.code == -32602 and error.outcome is None and [issue.path for issue in error.issues] == ['schema'] and str(error) == error.issues[0].message and 'not a JSON schema' in str(error), error
            else: raise AssertionError('a refused schema resolved')
            assert (await session.prompt('again', schema=schema))['structured'] == {'count': 4}


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
        path = Path(directory).resolve()
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
        assert sdk.argv_of(sdk.RunOptions(env={'HOME': str(path), 'PATH': ''}))[0] == str(target)
        installed = sdk.argv_of(sdk.RunOptions(env={'HOME': str(path), 'PATH': str(target.parent)}, project='/p'))
        assert installed[:6] == [str(target), '--project', '/p', 'run', '--format', 'rows'], installed


async def managed_install():
    windows, posix = os.environ.get('SDK_WINDOWS_FIXTURE'), os.environ.get('SDK_POSIX_FIXTURE')
    if not windows or not posix:
        print('SKIP Python row 9 managed install: the layout fixtures are written by prove-sdk-developer.ts, which runs this mirror', flush=True)
        return
    profile = Path(windows, 'Users', 'Dev'); local = profile / 'AppData' / 'Local'; bin = local / 'Mercury' / 'bin'
    version = profile / '.mercury' / 'versions' / '1.0.0-beta.40'
    env = {'USERPROFILE': str(profile), 'LOCALAPPDATA': str(local), 'PATH': ';'.join(['C:\\Windows\\system32', str(Path(windows, 'nodejs')), str(bin)]), 'PATHEXT': '.COM;.EXE;.BAT;.CMD'}
    resolved = [str(version / 'vendor' / 'node' / 'node.exe'), str(version / 'mercury.mjs')]
    discovered = executable_of(None, env, windows, 'win32')
    assert discovered == resolved, f'discovery reads current.txt and runs the bundle on the vendored node.exe; got {discovered}'
    for shim in ('mercury.cmd', 'mercury', 'mercury.ps1'): assert executable_of(None, {**env, 'MERCURY_BIN': str(bin / shim)}, windows, 'win32') == resolved, shim
    assert executable_of(str(version / 'mercury.cmd'), env, windows, 'win32') == resolved, 'the versioned launcher resolves to the bundle beside it'
    elsewhere = str(Path(windows, 'elsewhere'))
    def refused(environment, pointer):
        try: executable_of(None, environment, windows, 'win32')
        except sdk.MercuryError as error: assert 'managed command' in str(error) and pointer in str(error), str(error)
        else: raise AssertionError(f'no refusal naming {pointer}')
    refused({**env, 'MERCURY_CONFIG_DIR': elsewhere}, str(Path(elsewhere, 'versions', 'current.txt')))
    refused({**env, 'MERCURY_VERSIONS_DIR': elsewhere}, str(Path(elsewhere, 'current.txt')))
    refused({**env, 'MERCURY_CONFIG_DIR': elsewhere, 'PATH': ''}, str(Path(elsewhere, 'versions', 'current.txt')))
    assert executable_of(None, {**env, 'MERCURY_CONFIG_DIR': elsewhere, 'PATH': '', 'LOCALAPPDATA': elsewhere}, windows, 'win32') == ['mercury']
    pointer = version.parent / 'current.txt'
    pointer.write_bytes(b'\r\n"1.0.0-beta.40"  \r\nprevious-line-ignored\r\n')
    assert executable_of(None, env, windows, 'win32') == resolved, 'current.txt is read as the shim reads it: first non-blank line, quotes stripped, trailing space trimmed'
    pointer.write_bytes(b'..\\outside\r\n')
    refused(env, str(pointer))
    pointer.write_bytes(b'1.0.0-beta.40\r\n')
    task = await sdk.run('x', mercury=executable_of(None, env, windows, 'win32'))
    assert (await task.outcome)['status'] == 'completed'
    entry = Path(windows, 'entry.mjs')
    named = executable_of(str(entry), {'PATH': str(Path(windows, 'nodejs')), 'PATHEXT': '.COM;.EXE'}, windows, 'win32')
    assert named[1] == str(entry) and re.search(r'node(\.exe)?$', named[0], re.IGNORECASE) and named[0] == str(Path(windows, 'nodejs', 'node.exe')), named
    if WINDOWS_HOST:
        print('SKIP Python the POSIX layout live: this host is Windows (the Windows layout above ran live here)', flush=True)
        return
    home = Path(posix, 'home'); stable = home / '.local' / 'bin'; active = home / '.mercury' / 'versions' / '1.0.0-beta.40'
    posix_env = {**{key: value for key, value in os.environ.items() if key not in ('MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'MERCURY_VERSIONS_DIR')}, 'HOME': str(home), 'PATH': f'{stable}:{os.environ.get("PATH", "")}'}
    expected = [str(active / 'vendor' / 'node' / 'bin' / 'node'), str(active / 'mercury.mjs')]
    assert sdk.argv_of(sdk.RunOptions(env=posix_env))[:2] == expected, sdk.argv_of(sdk.RunOptions(env=posix_env))
    assert executable_of(None, {**posix_env, 'MERCURY_BIN': str(stable / 'mercury')}, windows) == expected, 'the POSIX managed shim resolves the way it resolves itself'
    task = await sdk.run('x', env=posix_env)
    assert (await task.outcome)['status'] == 'completed'


async def entry_point():
    with tempfile.TemporaryDirectory(prefix='sdk-entry-') as directory:
        path = Path(directory).resolve()
        entry = path / 'entry.mjs'
        entry.write_text('console.log(' + repr(json.dumps(session_row)) + '); console.log(' + repr(json.dumps(outcome)) + ')')
        named = sdk.argv_of(sdk.RunOptions(env={**os.environ, 'MERCURY_BIN': str(entry)}))
        assert named[1] == str(entry) and re.search(r'node(\.exe)?$', named[0], re.IGNORECASE), named
        task = await sdk.run('x', env={**os.environ, 'MERCURY_BIN': str(entry)})
        assert (await task.outcome)['status'] == 'completed'
        runtime = path / 'vendor' / 'node' / ('node.exe' if WINDOWS_HOST else 'bin/node')
        runtime.parent.mkdir(parents=True)
        runtime_stand_in(runtime)
        assert sdk.argv_of(sdk.RunOptions(mercury=str(entry)))[0] == str(runtime)
        task = await sdk.run('x', mercury=str(entry))
        assert (await task.outcome)['status'] == 'completed'
        try: sdk.argv_of(sdk.RunOptions(mercury=str(path / 'missing.mjs')))
        except sdk.MercuryError as error: assert 'JavaScript entry point that does not exist' in str(error)
        else: raise AssertionError('a missing entry point was accepted')


async def keyword_types():
    from dataclasses import fields
    from typing import ForwardRef
    def spelled(annotation):
        if isinstance(annotation, ForwardRef): return annotation.__forward_arg__
        return annotation if isinstance(annotation, str) else repr(annotation)
    declared = {f.name: spelled(f.type) for f in fields(sdk.RunOptions)}
    run_keys = {name: spelled(value) for name, value in sdk.RunKwargs.__annotations__.items()}
    connect_keys = {name: spelled(value) for name, value in sdk.ConnectKwargs.__annotations__.items()}
    assert set(run_keys) | {'prompt', 'schema'} == set(declared), set(declared) ^ (set(run_keys) | {'prompt', 'schema'})
    assert set(connect_keys) == set(run_keys) - {'cancel', 'input', 'stdin'}, set(connect_keys) ^ (set(run_keys) - {'cancel', 'input', 'stdin'})
    assert all(run_keys[name] == declared[name] for name in run_keys), [(name, run_keys[name], declared[name]) for name in run_keys if run_keys[name] != declared[name]]
    assert set(sdk.RunKwargs.__required_keys__) == set() and set(sdk.ConnectKwargs.__required_keys__) == set()


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
    for name, function in [('prompt ids on every accepted send', prompt_ids), ('prompt withdrawal uncorrelated', lambda: prompt_withdrawal(False)), ('prompt withdrawal correlated', lambda: prompt_withdrawal(True)), ('a prompt waiting on its own withdrawn input uncorrelated', lambda: prompt_withdrawn_wait(False)), ('a prompt waiting on its own withdrawn input correlated', lambda: prompt_withdrawn_wait(True)), ('input answered with an error uncorrelated', lambda: prompt_error_reply(False)), ('input answered with an error correlated', lambda: prompt_error_reply(True)), ('a schema refused before sending leaves the session free', prompt_schema_refused_locally), ('prompt cancellation uncorrelated', lambda: prompt_cancellation(False)), ('prompt cancellation correlated', lambda: prompt_cancellation(True)), ('sync prompt ids and options', sync_prompt_ids), ('unclaimed warm prompt guard and claimed identities', warm_identity), ('row 1 inferred schemas and cancellation', inline), ('rows 2 and 5 capability and warm options', capabilities), ('row 6 structured', structured), ('row 7 rich prompts', rich), ('row 8 factories', factories), ('row 8 fixture validation', fixture_validation), ('row 9 flags and executable discovery', flags), ('row 9 managed install: the Windows layout driven on this host, the POSIX layout live', managed_install), ('row 9 JavaScript entry points', entry_point), ('row 10 keyword option types mirror RunOptions', keyword_types), ('row 10 typed sync iteration', sync)]:
        await check(name, function)


asyncio.run(main())
if failures: raise SystemExit(1)
