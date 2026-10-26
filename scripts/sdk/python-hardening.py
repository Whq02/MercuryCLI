import asyncio
import sys
import time
from mercury_cli_sdk import MercuryConnectionError, MercuryError, MercuryExitError, MercuryTimeoutError, MercuryWireError, connect, connect_sync


def mercury(scenario):
    return ['node', sys.argv[1], scenario]


async def expect(awaitable, error_type):
    try:
        await awaitable
    except error_type as error:
        return error
    raise AssertionError(f'{error_type.__name__} expected')


async def main():
    error = await expect(connect(mercury=mercury('silent'), timeout=0.05), MercuryTimeoutError)
    assert error.method == 'initialize' and error.timeout == 0.05 and 'increase the timeout' in str(error)
    for cancellation in ('timeout', 'event', 'task'):
        for interrupt_on_cancel in (False, True):
            async with await connect(mercury=mercury('late')) as session:
                settled = asyncio.Event()
                interrupted = asyncio.Event()
                session.on('notification', lambda message: settled.set() if message['method'] == 'fixture/settled' else None)
                session.on('notification', lambda message: interrupted.set() if message['method'] == 'fixture/interrupted' else None)
                started = time.monotonic()
                if cancellation == 'timeout':
                    await expect(session.prompt('delayed receipt', timeout=0.05, interrupt_on_cancel=interrupt_on_cancel), MercuryTimeoutError)
                elif cancellation == 'event':
                    event = asyncio.Event()
                    asyncio.get_running_loop().call_later(0.05, event.set)
                    error = await expect(session.prompt('delayed receipt', cancel=event, interrupt_on_cancel=interrupt_on_cancel), MercuryError)
                    assert str(error) == 'prompt: cancelled'
                else:
                    prompt = asyncio.create_task(session.prompt('delayed receipt', interrupt_on_cancel=interrupt_on_cancel))
                    asyncio.get_running_loop().call_later(0.05, prompt.cancel)
                    await expect(prompt, asyncio.CancelledError)
                assert time.monotonic() - started < 0.3, 'the prompt wait must end before the delayed queue receipt'
                await settled.wait()
                if interrupt_on_cancel: await interrupted.wait()
                facts = await session.facts()
                assert facts['queued'] == 1 and facts['interrupted'] == int(interrupt_on_cancel), facts
    print('PASS Python prompt clocks cover queue acceptance and keep late interruption optional')
    for scenario in ('eof', 'die', 'bad-cancel', 'bad-applied', 'bad-complete', 'bad-row', 'bad-id'):
        async with await connect(mercury=mercury(scenario)) as session:
            session.on('error', lambda error: session.clear_rows())
            results = await asyncio.gather(session.facts(), anext(session), anext(session), return_exceptions=True)
            expected = MercuryConnectionError if scenario == 'eof' else MercuryExitError if scenario == 'die' else MercuryWireError
            assert all(isinstance(result, expected) for result in results), (scenario, results)
            if scenario == 'die': assert results[0].exit.code == 7
            if scenario == 'eof': assert 'output closed' in str(results[0]) and 'reconnect' in str(results[0])
            await session.exit
        print('PASS Python', scenario, 'settles requests and every row waiter')
    session = await connect(mercury=mercury('closing'))
    waiting = [asyncio.create_task(anext(session)), asyncio.create_task(anext(session))]
    close = asyncio.create_task(session.close())
    await asyncio.sleep(0)
    await expect(session.request('session/leave', timeout=None), MercuryConnectionError)
    await expect(session.notify_credentials_changed(), MercuryConnectionError)
    await close
    assert all(isinstance(result, StopAsyncIteration) for result in await asyncio.gather(*waiting, return_exceptions=True))
    await expect(session.prompt('closed'), MercuryConnectionError)
    print('PASS Python close refuses requests immediately and ends every row iterator')
    session = await connect(mercury=mercury('backpressure'))
    try:
        started = time.monotonic()
        error = await expect(session.request('queue/add', {'type': 'prompt', 'content': 'x' * (8 * 1024 * 1024)}, timeout=0.05), MercuryTimeoutError)
        assert time.monotonic() - started < 0.5 and error.method == 'queue/add'
    finally:
        session.child.terminate()
        await session.close()
    print('PASS Python request timeout includes a blocked stdin drain')
    def sync_edges():
        session = connect_sync(mercury=mercury('late'))
        def callback(message):
            if message['method'] == 'fixture/settled':
                try: session.close()
                except RuntimeError as error: assert 'host callback' in str(error)
                else: raise AssertionError('sync callback closed its own loop')
        session.on('notification', callback)
        assert session.prompt('normal')['status'] == 'completed'
        assert session.facts()['queued'] == 1
        session.close()
        for call in (session.facts, lambda: session.prompt('closed'), session.notify_credentials_changed, session.clear_rows, lambda: session.on('row', callback), lambda: session.off('row', callback)):
            try: call()
            except MercuryConnectionError as error: assert 'connect a new session' in str(error)
            else: raise AssertionError('sync request after close succeeded')
        assert list(session) == []
        session.close()
    await asyncio.to_thread(sync_edges)
    print('PASS Python sync calls after close fail without waiting; callbacks cannot close their own loop')


asyncio.run(asyncio.wait_for(main(), 25))
