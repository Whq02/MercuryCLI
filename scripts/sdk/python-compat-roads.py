import asyncio
import json
import sys
from mercury_cli_sdk import run, connect, define_agent, structured_schema, parse_row, is_main_thread
from mercury_cli_sdk.testing import start_fixture_server

mercury, cwd, compat, anthropic = json.loads(sys.argv[1]), *sys.argv[2:5]
options = dict(mercury=mercury, cwd=cwd, mode='sovereign', ephemeral=True, partial=True)
schema = {'type': 'object', 'properties': {'answer': {'type': 'string'}}, 'required': ['answer'], 'additionalProperties': False}

async def main():
    for model in (anthropic, compat):
        task = await run(input='rows', model=model, **options)
        await task.send_prompt('Python tool turn')
        task.close_input()
        outcome = await task.outcome
        assert outcome['status'] == 'completed' and outcome['answer'] == 'TOOL-DONE'
        assert (await task.exit).code == 0
        assert (await task.session)['model'] == model
        assert all(parse_row(json.dumps(row)).ok for row in task.rows)
        for type_ in ('reasoning', 'reasoning_delta', 'tool_call', 'tool_result', 'step', 'outcome'):
            assert any(row['type'] == type_ for row in task.rows), type_
        assert any(row['type'] == 'tool_result' and 'SDK-TOOL' in row['output'] for row in task.rows)
        steps = [row for row in task.rows if row['type'] == 'step' and is_main_thread(row)]
        assert len(steps) == 2 and all(row['model'] == model for row in steps)
        assert outcome['usage']['input_tokens'] == sum(row['usage']['input_tokens'] for row in steps)
        assert outcome['models'][model]['output_tokens'] == outcome['usage']['output_tokens']
        async with await start_fixture_server({'rows': task.rows}) as replay:
            consumer = await run('row replay', mercury=replay.mercury)
            assert await consumer.outcome == outcome
        typed = await run('Python structured turn', model=model, schema=structured_schema(schema, lambda value: value['answer'].upper()), **options)
        assert (await typed.outcome)['structured'] == 'TYPED ANSWER'
        assert (await typed.exit).code == 0
        async with await connect(model=model, **options) as session:
            result = await session.prompt('Python per-turn schema', schema=structured_schema(schema, lambda value: value['answer'].upper()))
            assert result['structured'] == 'RUNNER ANSWER'
        print(f'PASS Python {model}: tool, partial rows, model, usage, exit, replay and structured run/runner', flush=True)
    agent = define_agent({'description': 'Compat SDK child', 'prompt': 'Python-CHILD-ONLY', 'model': compat, 'tools': ['Read']})
    task = await run('Launch the Python child', model=anthropic, agent_defs={'sdk-compat-child': agent}, **options)
    assert (await task.outcome)['status'] == 'completed'
    assert any(row['type'] == 'tool_result' and 'LLMHOST-READY' in row['output'] for row in task.rows), task.rows
    assert any(row['type'] == 'step' and row.get('parent_call_id') and row['model'] == compat for row in task.rows)
    print('PASS Python AgentDefinition model dispatches compat child from Anthropic parent', flush=True)

asyncio.run(main())
