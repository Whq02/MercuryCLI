import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from mercury_cli_sdk import MercuryError, MercuryExitError, MercurySpawnError, MercuryUsageError, MercuryWireError, RunExit, connect, row_of, run, __version__
from mercury_cli_sdk.testing import fixture_session_row, fixture_turn

WINDOWS = os.name == 'nt'
init = {'protocol': 1, 'runner': {'version': 'fixture', 'pid': 1}, 'session_id': 's'}
failures = []
def child(script): return [sys.executable, '-u', '-c', script]
def alive(pid):
    if WINDOWS:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)
        if not handle: return False
        code = ctypes.c_ulong()
        queried = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(queried) and code.value == 259
    try: os.kill(pid, 0); return True
    except OSError: return False

async def check(name, fn):
    try:
        await asyncio.wait_for(fn(), 20)
        print('PASS', name, flush=True)
    except Exception as e:
        failures.append(name)
        print('FAIL', name, type(e).__name__, str(e), flush=True)

async def expect(coro, error, test):
    try: await coro
    except error as e: assert test(e), str(e)
    else: raise AssertionError(f'{error.__name__} expected')

async def words():
    missing = os.path.join(tempfile.gettempdir(), 'mercury-sdk-no-such-dir-proof')
    await expect(run('x', mercury=child('pass'), cwd=missing), MercurySpawnError, lambda e: f'the working directory does not exist: {missing}' in str(e))
    await expect(connect(mercury=child('pass'), cwd=missing), MercurySpawnError, lambda e: 'the working directory does not exist' in str(e))
    await expect(run('x', mercury='mercury-sdk-no-such-binary-proof'), MercurySpawnError, lambda e: 'https://mercury-cli.ai' in str(e) and 'mercury option' in str(e))
    await expect(connect(mercury=child("import sys;sys.stderr.write(\"error: unknown option '--x'\\n\");sys.exit(2)")), MercuryUsageError, lambda e: e.door == 'runner' and str(e) == "error: unknown option '--x'")
    await expect(connect(mercury=child("import sys;sys.stderr.write('boot failure: cannot open the store\\n');sys.exit(1)")), MercuryExitError, lambda e: e.door == 'runner' and str(e) == 'mercury runner exited 1 before the session was closed: boot failure: cannot open the store')
    task = await run('x', mercury=child('raise SystemExit(3)'))
    await expect(task.outcome, MercuryExitError, lambda e: e.door == 'run' and str(e) == 'mercury run exited 3 before an outcome row')
    unfed = await run(input='rows', mercury=child('import sys\nsys.stdin.read()\nraise SystemExit(1)'))
    unfed.close_input()
    await expect(unfed.outcome, MercuryExitError, lambda e: str(e) == 'mercury run exited 1 before an outcome row: no input row was sent before stdin was closed')

async def boot_timeout():
    silent = child('import sys\nsys.stdin.read()')
    started = time.monotonic()
    await expect(connect(mercury=silent, timeout=0.1), MercuryError, lambda e: str(e) == 'initialize: no answer within 0.1 seconds')
    assert time.monotonic() - started < 5, 'the timed-out boot must end without waiting on an escalation'
    try: await asyncio.wait_for(connect(mercury=silent), 0.1)
    except asyncio.TimeoutError: pass
    else: raise AssertionError('a cancelled connect returned')

async def escalation():
    stubborn = child("import signal,sys,time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint('{bad', flush=True)\nwhile True: time.sleep(1)")
    started = time.monotonic()
    task = await run('x', mercury=stubborn)
    await expect(task.outcome, MercuryWireError, lambda e: e.reason == 'not_json')
    exit = await asyncio.wait_for(task.exit, 5)
    ended = 'SIGTERM' if WINDOWS else 'SIGKILL'
    assert exit.signal == ended and exit.code is None and time.monotonic() - started < 4, (exit, ended)
    assert not alive(task.child.pid), 'the child is gone'
    started = time.monotonic()
    await expect(connect(mercury=stubborn), MercuryWireError, lambda e: e.reason == 'not_json')
    assert time.monotonic() - started < 4


async def interrupted():
    session = fixture_session_row(session_id='interrupt-session')
    turn, _ = fixture_turn({'session_id': 'interrupt-session', 'turn': 2, 'turn_id': 'turn-two'})
    turn = {**turn, 'seq': 2, 'turn': 2}
    step = {'type': 'step', 'seq': 3, 'timestamp': '2000-01-01T00:00:00.000Z', 'session_id': 'interrupt-session', 'message_id': 'm1', 'model': 'fixture-model', 'usage': {'input_tokens': 25, 'cached_input_tokens': 2, 'cache_write_input_tokens': 1, 'output_tokens': 4}}
    assert row_of(step).ok and row_of(turn).ok
    def idle(rows, on_sigint='signal.signal(signal.SIGINT, signal.SIG_DFL)'):
        return child('import signal,sys,time\n' + on_sigint + '\n' + ''.join(f'print({json.dumps(json.dumps(row))}, flush=True)\n' for row in rows) + 'while True: time.sleep(1)')
    first = await run('x', mercury=idle([session]))
    await first.session
    first.interrupt()
    outcome = await first.outcome
    assert outcome['status'] == 'interrupted' and outcome['error'] == {'message': 'Interrupted', 'class': 'interrupt'}, outcome
    exit = await first.exit
    assert exit.signal == 'SIGINT' or exit.code == 130, exit
    assert first.rows[-1] is outcome and first.error is None and outcome['seq'] == 2 and outcome['session_id'] == 'interrupt-session' and outcome['turn'] == 1 and outcome['steps'] == 0, outcome
    folded = await run('x', mercury=idle([session, turn, step]))
    seen = []
    folded.on('outcome', lambda row: seen.append(row['status']))
    iterated = []
    async def iterate():
        async for row in folded: iterated.append(row['type'])
    iteration = asyncio.create_task(iterate())
    while not any(row['type'] == 'step' for row in folded.rows): await asyncio.sleep(0.01)
    folded.interrupt()
    synthesized = await folded.outcome
    await iteration
    assert synthesized['turn'] == 2 and synthesized['turn_id'] == 'turn-two' and synthesized['steps'] == 1 and synthesized['seq'] == 4, synthesized
    assert synthesized['usage'] == {'input_tokens': 25, 'cached_input_tokens': 2, 'cache_write_input_tokens': 1, 'output_tokens': 4}
    assert synthesized['models'] == {'fixture-model': {'input_tokens': 25, 'cached_input_tokens': 2, 'cache_write_input_tokens': 1, 'output_tokens': 4, 'web_searches': 0}}
    assert synthesized['wall_ms'] >= 0 and seen == ['interrupted'] and iterated == ['session', 'turn', 'step', 'outcome'], (seen, iterated)
    assert row_of(synthesized).ok, 'the synthesized row is a valid outcome row'
    exiting = await run('x', mercury=idle([session], 'signal.signal(signal.SIGINT, lambda *a: sys.exit(130))'))
    await exiting.session
    exiting.interrupt()
    assert (await exiting.outcome)['status'] == 'interrupted', 'a child that exits 130 on the interrupt without an outcome row settles the same way'
    event = asyncio.Event()
    cancelled = await run('x', mercury=idle([session]), cancel=event)
    await cancelled.session
    event.set()
    assert (await cancelled.outcome)['status'] == 'interrupted', 'the cancel event takes the same road'
    foreign = await run('x', mercury=idle([session]))
    await foreign.session
    if WINDOWS: foreign.child.terminate()
    else: os.kill(foreign.child.pid, signal.SIGINT)
    await expect(foreign.outcome, MercuryExitError, lambda e: (e.exit.code == 1 and e.exit.signal is None) if WINDOWS else str(e) == 'mercury run ended by SIGINT before an outcome row')
    terminated = await run('x', mercury=idle([session]))
    await terminated.session
    assert terminated.terminate() is None, 'terminate() is synchronous'
    await expect(terminated.outcome, MercuryExitError, lambda e: str(e) == 'mercury run ended by SIGTERM before an outcome row')


async def windows_road():
    import mercury_cli_sdk.client as client
    was = client.WINDOWS
    client.WINDOWS = True
    try:
        session = fixture_session_row(session_id='windows-session')
        def ends_with_code_1(first_line):
            return child('import signal,sys,time\nsignal.signal(signal.SIGTERM, lambda *a: sys.exit(1))\nprint(' + first_line + ', flush=True)\nwhile True: time.sleep(1)')
        event = asyncio.Event()
        cancelled = await run('x', mercury=ends_with_code_1(json.dumps(json.dumps(session))), cancel=event)
        await cancelled.session
        event.set()
        outcome = await cancelled.outcome
        assert outcome['status'] == 'interrupted' and cancelled.rows[-1] is outcome, outcome
        assert await cancelled.exit == RunExit(None, 'SIGINT', ''), await cancelled.exit
        terminated = await run('x', mercury=ends_with_code_1(json.dumps(json.dumps(session))))
        await terminated.session
        terminated.terminate()
        await expect(terminated.outcome, MercuryExitError, lambda e: str(e) == 'mercury run ended by SIGTERM before an outcome row' and e.exit.code is None)
        wire = await run('x', mercury=ends_with_code_1(repr('{bad')))
        await expect(wire.outcome, MercuryWireError, lambda e: e.reason == 'not_json')
        assert (await wire.exit).signal == 'SIGTERM', await wire.exit
        natural = await run('x', mercury=child('import sys\nprint(' + json.dumps(json.dumps(session)) + ', flush=True)\nsys.exit(1)'))
        await expect(natural.outcome, MercuryExitError, lambda e: str(e) == 'mercury run exited 1 before an outcome row' and e.exit.signal is None)
    finally: client.WINDOWS = was


async def host_exit():
    script = f'''import asyncio, sys
sys.path.insert(0, {json.dumps(str(Path(__file__).resolve().parents[2] / 'sdk-py/src'))})
from mercury_cli_sdk import run
from mercury_cli_sdk.runner import MercurySession
from mercury_cli_sdk.client import spawn, RunOptions
async def main():
    idle = [sys.executable, '-c', 'import time\\nwhile True: time.sleep(1)']
    task = await run(input='rows', mercury=idle)
    session = MercurySession(await spawn([*idle, 'runner'], RunOptions()), {{}})
    print(task.child.pid, session.child.pid, flush=True)
asyncio.run(main())
'''
    result = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    pids = [int(p) for p in result.stdout.split()]
    assert len(pids) == 2
    for _ in range(40):
        if not any(alive(p) for p in pids): break
        await asyncio.sleep(0.05)
    assert not [p for p in pids if alive(p)], 'children outlived the host'

async def main():
    await check('Python cwd and executable words, door-aware exits', words)
    await check('Python connect timeout and cancellation end a silent boot', boot_timeout)
    await check('Python termination after a fatal wire failure: the child is gone within the bound and the receipt names ' + ('SIGTERM (Windows: the first step ends it)' if WINDOWS else 'the SIGKILL escalation'), escalation)
    await check('Python interrupt the package sent settles as an interrupted outcome when the child ends by the signal; a foreign signal and terminate() stay errors', interrupted)
    await check('Python Windows road' + ('' if WINDOWS else ' driven on this host') + ': cancel ends the child and settles interrupted, terminate and the wire escalation report the signal sent, a natural exit 1 stays exit 1', windows_road)
    await check('Python host exit terminates live children', host_exit)
    assert __version__ in Path(__file__).resolve().parents[2].joinpath('sdk-py/pyproject.toml').read_text()
    assert not failures, failures
    print('PASS Python lifecycle')

asyncio.run(main())
