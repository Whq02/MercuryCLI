import asyncio
import json
import sys
from mercury_cli_sdk import run, connect, MercuryRefusal

mercury, cwd, compat, anthropic = json.loads(sys.argv[1]), *sys.argv[2:5]
options = dict(mercury=mercury, cwd=cwd, ephemeral=True)

async def main():
    for model in (anthropic, compat, 'compat'):
        task = await run('Python model turn', model=model, **options)
        result = await task.outcome
        assert result['status'] == 'completed'
        assert (await task.exit).code == 0
        assert (await task.session)['model'] == (compat if model == 'compat' else model)
        assert result.get('answer') == ('ANTHROPIC-ANSWER' if model == anthropic else 'LLMHOST-READY')
    for model in ('local', 'huggingface', 'compat/fixture/not-listed', 'compat/absent/Reasoner'):
        task = await run('must refuse', model=model, **options)
        try:
            await task.outcome
            raise AssertionError(f'{model} did not refuse')
        except MercuryRefusal as error:
            assert error.error_class == 'option'
    async with await connect(model=anthropic, **options) as session:
        assert (await session.set_model('compat'))['model'] == compat
        assert (await session.prompt('compat turn'))['answer'] == 'LLMHOST-READY'
        try:
            await session.set_model('compat/fixture/not-listed')
            raise AssertionError('unknown compat model was accepted')
        except MercuryRefusal as error:
            assert error.code == -32010
        assert (await session.prompt('still compat'))['answer'] == 'LLMHOST-READY'
        await session.set_model(anthropic)
        assert (await session.prompt('Anthropic turn'))['answer'] == 'ANTHROPIC-ANSWER'
    print('PASS Python run, class refusals, runner model switch and no mutation after refusal', flush=True)

asyncio.run(main())
