import asyncio
import json
from pathlib import Path
import sys
import mercury_cli_sdk as sdk
from mercury_cli_sdk import connect

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
        async with await connect(mercury=mercury, cwd=cwd, on_permission_request=lambda ask, context: {'outcome': 'allow'}, allowed_tools=['Read', 'Write'], checkpoint_files=True) as session:
            assert (await session.prompt('Change saved.txt'))['status'] == 'completed'
            assert path.read_text() == 'changed\n'
            id = session.last_prompt_id
            assert isinstance(id, str)
            facts = await session.facts()
            assert facts['file_checkpoints']['capture'] and id in facts['file_checkpoints']['restorable']
            dry = await session.rewind(id, 'both', dry_run=True)
            assert dry['code']['files_changed'] and path.read_text() == 'changed\n'
            restored = await session.rewind(id, 'both')
            assert restored['outcome'] == 'applied' and path.read_text() == 'original\n'
    elif scenario == 'roster':
        for said, options in [('roster of a headless session', {}), ('roster of a session-runner', {'checkpoint_files': True})]:
            async with await connect(mercury=mercury, cwd=cwd, **options) as session:
                assert (await session.prompt(f'Describe the {said}'))['status'] == 'completed'
    else:
        async with await sdk.prewarm(mercury=mercury, cwd=cwd) as session:
            assert session.initialized['session_id'] is None
            receipt = await session.claim(session_id='00000000-0000-4000-8000-000000000092')
            assert receipt['session_id'] == '00000000-0000-4000-8000-000000000092'


asyncio.run(main())
