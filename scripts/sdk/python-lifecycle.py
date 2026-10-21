import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from mercury_cli_sdk import MercuryError, MercuryExitError, MercurySpawnError, MercuryUsageError, MercuryWireError, connect, run, __version__

init = {'protocol': 1, 'runner': {'version': 'fixture', 'pid': 1}, 'session_id': 's'}
failures = []
def child(script): return [sys.executable, '-u', '-c', script]
def alive(pid):
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
    assert exit.signal == 'SIGKILL' and time.monotonic() - started < 4, exit
    started = time.monotonic()
    await expect(connect(mercury=stubborn), MercuryWireError, lambda e: e.reason == 'not_json')
    assert time.monotonic() - started < 4

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
    await check('Python SIGKILL escalation after a fatal wire failure', escalation)
    await check('Python host exit terminates live children', host_exit)
    assert __version__ in Path(__file__).resolve().parents[2].joinpath('sdk-py/pyproject.toml').read_text()
    assert not failures, failures
    print('PASS Python lifecycle')

asyncio.run(main())
