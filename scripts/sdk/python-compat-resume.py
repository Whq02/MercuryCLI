import asyncio
import json
import sys
from mercury_cli_sdk import run, connect

mercury, cwd, compat, anthropic = json.loads(sys.argv[1]), *sys.argv[2:5]
options = dict(mercury=mercury, cwd=cwd)

async def main():
    for model in (anthropic, compat):
        saved = await run('remember Python turn', model=model, **options)
        assert (await saved.outcome)['status'] == 'completed'
        sid = (await saved.session)['session_id']
        cold = await run('cold Python resume', resume=sid, **options)
        assert (await cold.outcome)['status'] == 'completed'
        assert (await cold.session)['model'] == model
        async with await connect(warm=True, **options) as warm:
            await warm.claim(session_id=sid, resume=True)
            outcome = await warm.prompt('warm Python resume')
            assert outcome['status'] == 'completed'
            assert outcome['answer'] == ('LLMHOST-READY' if model == compat else 'ANTHROPIC-ANSWER')
            assert any(row['type'] == 'step' and row['model'] == model for row in warm.rows)
    print('PASS Python cold and warm resume retain compat and Anthropic models', flush=True)

asyncio.run(main())
