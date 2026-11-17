import asyncio
import logging
import os
import signal
import sys
from mercury_cli_sdk import MercuryError, MercuryExitError, MercuryWireError, connect, run

WINDOWS = os.name == 'nt'
failures = []


def mercury(scenario):
    return ['node', sys.argv[1], scenario]


async def expect(awaitable, error_type):
    try:
        await awaitable
    except error_type as error:
        return error
    raise AssertionError(f'{error_type.__name__} expected')


def cut_exit(error, door):
    return isinstance(error, MercuryExitError) and error.door == door and str(error).endswith('the last stdout line was cut off') and (WINDOWS or error.exit.signal == 'SIGKILL')


def broken(_value):
    raise KeyError('txt')


async def check(name, body):
    try:
        await asyncio.wait_for(body(), 40)
        print('PASS Python', name, flush=True)
    except (Exception, asyncio.CancelledError) as error:
        failures.append(name)
        print('FAIL Python', name, '\n ', type(error).__name__ + ':', error, flush=True)


async def cut_run():
    task = await run('x', mercury=mercury('cut-run'))
    rows = []
    async def read():
        async for row in task: rows.append(row['type'])
    error = await expect(read(), MercuryError)
    assert cut_exit(error, 'run'), repr(error)
    assert cut_exit(await expect(task.outcome, MercuryError), 'run')
    assert rows == ['session'], rows
    whole = await run('x', mercury=mercury('whole-run'))
    assert (await whole.outcome).get('answer') == 'ok'


async def cut_runner():
    async with await connect(mercury=mercury('cut-runner')) as session:
        error = await expect(session.facts(), MercuryError)
        assert cut_exit(error, 'runner'), repr(error)


async def cancelled_waits():
    task = await run('x', mercury=mercury('late-run'))
    async def wait(name): return await getattr(task, name)
    waiters = [asyncio.create_task(wait(name)) for name in ('session', 'outcome', 'exit')]
    await asyncio.sleep(0.05)
    for waiter in waiters: waiter.cancel()
    assert all(isinstance(result, asyncio.CancelledError) for result in await asyncio.gather(*waiters, return_exceptions=True))
    await expect(asyncio.wait_for(task.outcome, 0.05), asyncio.TimeoutError)
    assert (await asyncio.wait_for(task.session, 10))['type'] == 'session'
    assert (await asyncio.wait_for(task.outcome, 10))['status'] == 'completed'
    assert (await asyncio.wait_for(task.exit, 10)).code == 0
    await asyncio.wait_for(task.close(), 3)
    assert [row['type'] async for row in task] == ['session', 'outcome']


async def session_exit_wait():
    session = await connect(mercury=mercury('closing'))
    await expect(asyncio.wait_for(session.exit, 0.05), asyncio.TimeoutError)
    await asyncio.wait_for(session.close(), 8)
    assert (await asyncio.wait_for(session.exit, 5)).code == 0


async def ctrl_c():
    if WINDOWS: return
    program = "import sys\nfrom mercury_cli_sdk import run_sync\ntry: run_sync('x', mercury=['node', sys.argv[1], 'hang-run'], on_stderr=lambda chunk: print('READY', flush=True))\nexcept KeyboardInterrupt: print('INTERRUPTED', flush=True)\n"
    child = await asyncio.create_subprocess_exec(sys.executable, '-c', program, sys.argv[1], stdout=asyncio.subprocess.PIPE, start_new_session=True)
    assert child.stdout is not None
    try:
        assert (await asyncio.wait_for(child.stdout.readline(), 15)).strip() == b'READY'
        os.killpg(child.pid, signal.SIGINT)
        assert b'INTERRUPTED' in await asyncio.wait_for(child.stdout.read(), 8)
        await asyncio.wait_for(child.wait(), 5)
    finally:
        if child.returncode is None: os.killpg(child.pid, signal.SIGKILL)


async def listener_errors():
    task = await run('x', mercury=mercury('text-run'))
    task.on('text', broken)
    error = await expect(task.outcome, MercuryError)
    assert not isinstance(error, MercuryWireError) and isinstance(error.__cause__, KeyError) and 'a listener for text raised KeyError' in str(error), repr(error)
    async with await connect(mercury=mercury('row-runner')) as session:
        session.on('outcome', broken)
        error = await expect(session.prompt('x', timeout=10), MercuryError)
        assert not isinstance(error, MercuryWireError) and isinstance(error.__cause__, KeyError) and 'a listener for outcome raised KeyError' in str(error), repr(error)


async def side_channel_errors():
    records = []
    class Capture(logging.Handler):
        def emit(self, record): records.append(record)
    logger = logging.getLogger('mercury_cli_sdk')
    handler = Capture()
    logger.addHandler(handler)
    logger.propagate = False
    try:
        task = await run('x', mercury=mercury('stderr-run'), on_stderr=broken)
        task.on('stderr', broken)
        task.on('end', broken)
        outcome = await asyncio.wait_for(asyncio.shield(task.outcome), 5)
        assert outcome['status'] == 'completed' and 'a warning line' in task.stderr
        assert (await asyncio.wait_for(task.exit, 5)).code == 0
        failed = await run('x', mercury=mercury('cut-run'))
        failed.on('error', broken)
        await expect(asyncio.wait_for(asyncio.shield(failed.outcome), 5), MercuryError)
        assert (await asyncio.wait_for(failed.exit, 5)).code != 0
        logged = [record for record in records if record.exc_info and isinstance(record.exc_info[1], KeyError)]
        assert len(logged) == 4, [record.getMessage() for record in records]
    finally:
        logger.removeHandler(handler)
        logger.propagate = True


async def main():
    await check('run: a process killed mid-row raises its exit, not a wire error, and a whole last row without a newline is still read', cut_run)
    await check('session: a runner killed mid-row fails its requests with the exit, not a wire error', cut_runner)
    await check('run: a cancelled or timed-out wait on session, outcome or exit leaves the handle whole, and close returns', cancelled_waits)
    await check('session: a timed-out wait on exit does not make close raise CancelledError', session_exit_wait)
    await check('run_sync: Ctrl-C reaches the program as KeyboardInterrupt instead of hanging', ctrl_c)
    await check('a row listener that raises ends the run or session with that error as the cause, not a wire error', listener_errors)
    await check('a stderr, end or error listener that raises is logged and the run still settles', side_channel_errors)


asyncio.run(asyncio.wait_for(main(), 240))
sys.exit(1 if failures else 0)
