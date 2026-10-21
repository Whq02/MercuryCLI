import asyncio
import sys
from mercury_cli_sdk import connect_sync, define_tool, run, serve_tools
from mercury_cli_sdk.testing import fixture_outcome_row, fixture_session_row, start_fixture_server

init = {'result': {'protocol': 1, 'runner': {'version': 'fixture', 'pid': 1}, 'session_id': 'fixture-session'}}


async def bridge_with_stdin_open() -> None:
    async with await start_fixture_server({'rows': [fixture_session_row(), fixture_outcome_row(answer='ok')]}) as fixture:
        for attempt in range(5):
            task = await run(input='rows', mercury=fixture.mercury)
            assert (await task.outcome)['status'] == 'completed'
            exit = await task.exit
            sys.stderr.write(exit.stderr)
            assert exit.signal is None and exit.code == 0, f'attempt {attempt}: the fixture bridge ended with code {exit.code} signal {exit.signal}'
            print(f'bridge attempt {attempt}: exit {exit.code}')


async def tool_server_left_open() -> None:
    server = await serve_tools([define_tool('greeting', 'Return a greeting', {}, lambda _: 'Hello')])
    print('tool server left listening at', server.config['url'])


async def sync_session_left_open() -> None:
    outcome = fixture_outcome_row(answer='sync ok')
    async with await start_fixture_server({'methods': {'initialize': [init], 'queue/add': [{'result': {'accepted': True}, 'after': [{'jsonrpc': '2.0', 'method': 'row', 'params': outcome}]}]}}) as fixture:
        def consume() -> None:
            session = connect_sync(mercury=fixture.mercury)
            session.on('row', lambda row: print('listener saw', row['type'], flush=True))
            assert session.prompt('hello')['answer'] == 'sync ok'
            print('sync session left open with its listener printing from the loop thread')
        await asyncio.to_thread(consume)


asyncio.run(bridge_with_stdin_open())
asyncio.run(tool_server_left_open())
asyncio.run(sync_session_left_open())
print('consumer finished')
