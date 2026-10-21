import asyncio
import json
from pathlib import Path
import sys
import mercury_cli_sdk as sdk
from mercury_cli_sdk import MercurySchemaError, connect, structured_schema

scenario, mercury, cwd = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]


async def main():
    if scenario == 'capabilities':
        state = {'value': 'virtual original', 'reads': 0, 'writes': 0}
        def read(params, context):
            state['reads'] += 1
            return {'content': state['value']}
        def write(params, context):
            state['writes'] += 1
            state['value'] = params['content']
        async with await connect(mercury=mercury, cwd=cwd, on_permission_request=lambda ask, context: {'outcome': 'allow'}, allowed_tools=['Read', 'Write'], on_read_text_file=read, on_write_text_file=write) as session:
            assert (await session.prompt('Read then write virtual.txt'))['status'] == 'completed'
            assert state['reads'] > 0 and state['writes'] == 1 and state['value'] == 'virtual changed'
    elif scenario == 'checkpoints':
        path = Path(cwd, 'saved.txt')
        async with await connect(mercury=mercury, cwd=cwd, on_permission_request=lambda ask, context: {'outcome': 'allow'}, allowed_tools=['Read', 'Write']) as session:
            assert session.file_checkpoints == {'capture': True, 'source': 'initialize'}, session.file_checkpoints
            assert (await session.prompt('Change saved.txt'))['status'] == 'completed'
            assert path.read_text() == 'changed\n'
            id = session.last_prompt_id
            assert isinstance(id, str)
            facts = await session.facts()
            assert facts['file_checkpoints']['capture'] and facts['file_checkpoints'].get('source') == 'initialize' and id in facts['file_checkpoints']['restorable']
            dry = await session.rewind(id, 'both', dry_run=True)
            assert dry['code']['files_changed'] and path.read_text() == 'changed\n'
            restored = await session.rewind(id, 'both')
            assert restored['outcome'] == 'applied' and path.read_text() == 'original\n'
    elif scenario == 'roster':
        for said, options, expected in [('roster of a default session', {}, {'capture': True, 'source': 'initialize'}), ('roster of a session without checkpoints', {'checkpoints': False}, {'capture': False, 'source': 'headless'})]:
            async with await connect(mercury=mercury, cwd=cwd, **options) as session:
                assert session.file_checkpoints == expected, (said, session.file_checkpoints)
                assert (await session.prompt(f'Describe the {said}'))['status'] == 'completed'
    elif scenario == 'schema':
        count = {'type': 'object', 'properties': {'count': {'type': 'integer'}}, 'required': ['count']}
        name = {'type': 'object', 'properties': {'name': {'type': 'string'}}, 'required': ['name']}
        malformed = {'type': 'nonsense-type', 'properties': 5}
        async with await connect(mercury=mercury, cwd=cwd) as session:
            assert (await session.prompt('the count turn', schema=count)).get('structured') == {'count': 3}
            assert (await session.prompt('the name turn', schema=structured_schema(name, lambda value: value['name'].upper())))['structured'] == 'PELICAN'
            plain = await session.prompt('the plain turn')
            assert plain['status'] == 'completed' and 'structured' not in plain
            try: await session.prompt('the refused turn', schema=malformed)
            except MercurySchemaError as error:
                assert error.code == -32602 and error.outcome is None and error.issues[0].path == 'schema' and 'not a JSON schema' in error.issues[0].message and str(error) == error.issues[0].message, error
            else: raise AssertionError('a malformed per-turn schema was accepted')
            assert isinstance(session.last_prompt_id, str)
        async with await connect(mercury=mercury, cwd=cwd, schema=structured_schema(count, lambda value: value['count'] * 2)) as boot:
            assert '--schema' not in sdk.argv_of(sdk.RunOptions(mercury=mercury, cwd=cwd, schema=count), 'runner')
            assert (await boot.prompt('the boot schema turn'))['structured'] == 18
        try: await connect(mercury=mercury, cwd=cwd, schema=malformed)
        except MercurySchemaError as error: assert error.code == -32602 and error.issues[0].path == 'schema', error
        else: raise AssertionError('a malformed boot schema was accepted')
    else:
        async with await sdk.prewarm(mercury=mercury, cwd=cwd) as session:
            assert session.initialized['session_id'] is None
            receipt = await session.claim(session_id='00000000-0000-4000-8000-000000000092')
            assert receipt['session_id'] == '00000000-0000-4000-8000-000000000092'


asyncio.run(main())
