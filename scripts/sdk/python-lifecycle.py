import asyncio
import gc
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import Request, urlopen
from mercury_cli_sdk import MercuryError, MercuryExitError, MercurySpawnError, MercuryUsageError, MercuryWireError, RunExit, connect, connect_sync, define_tool, row_of, run, serve_tools, __version__
from mercury_cli_sdk.testing import fixture_outcome_row, fixture_session_row, fixture_turn, start_fixture_server

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
    from mercury_cli_sdk import connect_sync, run_sync
    from mercury_cli_sdk.testing import start_fixture_server
    methods = {'initialize': [{'result': init}, {'result': init}], 'queue/add': [{'result': {'accepted': True}} for _ in range(6)], 'turn/interrupt': [{'result': {'interrupted': True}} for _ in range(3)]}
    async with await start_fixture_server({'methods': methods}) as fixture:
        async with await connect(mercury=fixture.mercury) as session:
            await expect(session.prompt('timed', timeout=0.05), MercuryError, lambda e: str(e) == 'prompt: no answer within 0.05 seconds')
            assert not any(m.get('method') == 'turn/interrupt' for m in fixture.received)
            pre = asyncio.Event(); pre.set()
            await expect(session.prompt('pre', cancel=pre), MercuryError, lambda e: str(e) == 'prompt: cancelled')
            ev = asyncio.Event()
            asyncio.get_running_loop().call_later(0.05, ev.set)
            await expect(session.prompt('cancel-int', cancel=ev, interrupt_on_cancel=True), MercuryError, lambda e: str(e) == 'prompt: cancelled')
            await expect(session.prompt('timeout-int', timeout=0.05, interrupt_on_cancel=True), MercuryError, lambda e: str(e) == 'prompt: no answer within 0.05 seconds')
            assert sum(1 for m in fixture.received if m.get('method') == 'turn/interrupt') == 2
        def sync_check():
            with connect_sync(mercury=fixture.mercury) as sync_session:
                try: sync_session.prompt('sync-timeout', timeout=0.05, interrupt_on_timeout=True)
                except MercuryError as e: assert str(e) == 'prompt: no answer within 0.05 seconds'
                else: raise AssertionError('sync prompt timeout resolved')
        await asyncio.to_thread(sync_check)
        assert sum(1 for m in fixture.received if m.get('method') == 'turn/interrupt') == 3
    session_row = fixture_session_row(session_id='sync-int')
    idle_session = child('import signal,sys,time\nsignal.signal(signal.SIGINT, signal.SIG_DFL)\nprint(' + json.dumps(json.dumps(session_row)) + ', flush=True)\nwhile True: time.sleep(1)')
    res = await asyncio.to_thread(lambda: run_sync('x', mercury=idle_session, timeout=0.1, interrupt_on_timeout=True))
    assert res.outcome['status'] == 'interrupted'
    await expect(asyncio.to_thread(lambda: run_sync('x', mercury=idle_session, timeout=0.05)), MercuryError, lambda e: str(e) == 'run: no outcome within 0.05 seconds')

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


async def fork_and_thread_cancel():
    if hasattr(os, 'fork'):
        script = f'''import asyncio, json, os, sys, time
sys.path.insert(0, {json.dumps(str(Path(__file__).resolve().parents[2] / 'sdk-py/src'))})
from mercury_cli_sdk import run
from mercury_cli_sdk.runner import MercurySession
from mercury_cli_sdk.client import spawn, RunOptions
idle = [sys.executable, '-c', 'import time\\nwhile True: time.sleep(1)']
async def start():
    task = await run(input='rows', mercury=idle)
    session = MercurySession(await spawn([*idle, 'runner'], RunOptions()), {{}})
    return task, session
async def stop(task, session):
    task.terminate()
    await task.exit
    await session.close()
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
task, session = loop.run_until_complete(start())
pid = os.fork()
if pid == 0:
    sys.exit(0)
_, status = os.waitpid(pid, 0)
assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
time.sleep(0.1)
os.kill(task.child.pid, 0)
os.kill(session.child.pid, 0)
loop.run_until_complete(stop(task, session))
loop.close()
'''
        result = await asyncio.to_thread(subprocess.run, [sys.executable, '-c', script], capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stderr
    began = asyncio.Event()
    async def wait_tool(_params, context):
        began.set()
        await context.cancelled.wait()
        return 'cancelled'
    tool = define_tool('wait', 'Wait', {}, wait_tool)
    async with await serve_tools([tool]) as server:
        def post(body):
            req = Request(server.config['url'], json.dumps(body).encode(), {**server.config['headers'], 'Content-Type': 'application/json'})
            with urlopen(req, timeout=10) as resp: return resp.read()
        call1 = asyncio.create_task(asyncio.to_thread(post, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'wait', 'arguments': {}}}))
        await asyncio.wait_for(began.wait(), 5)
        await asyncio.to_thread(post, {'jsonrpc': '2.0', 'method': 'notifications/cancelled', 'params': {'requestId': 1}})
        assert json.loads(await asyncio.wait_for(call1, 5))['result']['content'][0]['text'] == 'cancelled'
        began.clear()
        call2 = asyncio.create_task(asyncio.to_thread(post, {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'wait', 'arguments': {}}}))
        await asyncio.wait_for(began.wait(), 5)
        await asyncio.to_thread(server.cancel)
        assert json.loads(await asyncio.wait_for(call2, 5))['result']['content'][0]['text'] == 'cancelled'


async def bounded_rows():
    from mercury_cli_sdk import connect_sync
    from mercury_cli_sdk.testing import start_fixture_server
    s_row = fixture_session_row(seq=1)
    deltas = [{'type': 'text_delta', 'seq': i + 2, 'timestamp': '2000-01-01T00:00:00.000Z', 'session_id': s_row['session_id'], 'message_id': 'm1', 'block': 0, 'text': f'd{i}'} for i in range(18)]
    _, out_row = fixture_turn({'seq': 20})
    rows = [s_row, *deltas, out_row]
    rpc_rows = [{'jsonrpc': '2.0', 'method': 'row', 'params': r} for r in rows]
    async with await start_fixture_server({'rows': rows, 'methods': {'initialize': [{'result': init}, {'result': init}], 'queue/add': [{'result': {'accepted': True}, 'after': rpc_rows}, {'result': {'accepted': True}, 'after': rpc_rows}]}}) as fixture:
        task = await run('x', mercury=fixture.mercury, max_rows=5)
        await task.outcome
        assert len(task.rows) == 5 and task.rows[0]['type'] == 'session'
        assert [r['seq'] for r in task.rows] == [1, 17, 18, 19, 20]
        task.clear_rows()
        assert len(task.rows) == 0
        async with await connect(mercury=fixture.mercury, max_rows=5) as session:
            await session.prompt('x')
            assert len(session.rows) == 5 and session.rows[0]['type'] == 'session'
            assert [r['seq'] for r in session.rows] == [1, 17, 18, 19, 20]
            session.clear_rows()
            assert len(session.rows) == 0
        def sync_bounded():
            with connect_sync(mercury=fixture.mercury, max_rows=5) as sync_session:
                sync_session.prompt('x')
                assert len(sync_session.rows) == 5 and sync_session.rows[0]['type'] == 'session'
                sync_session.clear_rows()
                assert len(sync_session.rows) == 0
        await asyncio.to_thread(sync_bounded)
async def fixture_close():
    big = [fixture_session_row(), fixture_outcome_row(answer='x' * 1_000_000)] * 8
    for shape, rows, inputs in (('a bridge holding the socket open with its hello sent and nothing more', [], 1), ('a bridge that stopped reading an 8 MB replay', big, 1)):
        server = await start_fixture_server({'rows': rows, 'inputCount': inputs})
        bridge = await asyncio.create_subprocess_exec(*server.mercury, 'run', '--format', 'rows', stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        assert bridge.stdin is not None
        if rows:
            bridge.stdin.write(b'{"type":"prompt","content":"x"}\n')
            await bridge.stdin.drain()
        await asyncio.sleep(0.3)
        started = time.monotonic()
        try: await asyncio.wait_for(server.close(), 1)
        except asyncio.TimeoutError: raise AssertionError(f'close() did not return within a second on {shape}')
        finally:
            bridge.kill()
            await bridge.wait()
        assert time.monotonic() - started < 0.05, f'close() took {time.monotonic() - started:.3f} s on {shape}'


async def close_mid_ask():
    loop = asyncio.get_running_loop()
    unhandled = []
    loop.set_exception_handler(lambda loop, context: unhandled.append(context.get('message')))
    try:
        gate, asked = asyncio.Event(), asyncio.Event()
        async def guard(params, context):
            asked.set()
            await gate.wait()
            return {'outcome': 'deny'}
        ask = {'jsonrpc': '2.0', 'id': 1000, 'method': 'permission/request', 'params': {'kind': 'tool', 'tool_use_id': 'u1', 'tool_name': 'Read', 'input': {}}}
        async with await start_fixture_server({'methods': {'initialize': [{'result': init, 'after': [ask]}]}}) as fixture:
            session = await connect(mercury=fixture.mercury, on_permission_request=guard)
            await asyncio.wait_for(asked.wait(), 5)
            errors = []
            session.on('error', errors.append)
            closing = asyncio.create_task(session.close())
            await asyncio.sleep(0)
            gate.set()
            await closing
            exit = await session.exit
            del session, closing
            for _ in range(3):
                gc.collect()
                await asyncio.sleep(0.02)
            assert not errors, [str(e) for e in errors]
            assert exit.code == 0, exit
            assert not unhandled, unhandled
    finally: loop.set_exception_handler(None)


async def live_stderr():
    rows = [fixture_session_row(), *fixture_turn()]
    noisy = child("import sys,time\nsys.stderr.write('booting\\n'); sys.stderr.flush()\n" + ''.join(f'print({json.dumps(json.dumps(row))}, flush=True)\n' for row in rows) + "time.sleep(0.3)\nsys.stderr.write('tail\\n'); sys.stderr.flush()\n")
    quiet = await run('x', mercury=noisy)
    await quiet.session
    while quiet.child.returncode is None and 'booting' not in quiet.stderr: await asyncio.sleep(0.01)
    assert 'booting' in quiet.stderr and quiet.child.returncode is None, f'the child exited (returncode {quiet.child.returncode}) before its stderr line was observable; stderr now reads {quiet.stderr!r}'
    await quiet.exit
    seen, events = [], []
    task = await run('x', mercury=noisy, on_stderr=seen.append)
    task.on('stderr', events.append)
    await task.session
    for _ in range(100):
        if 'booting' in ''.join(events): break
        await asyncio.sleep(0.01)
    assert 'booting' in ''.join(events) and 'booting' in ''.join(seen) and 'booting' in task.stderr, (task.stderr, seen, events)
    assert task.child.returncode is None, 'the child had already exited when its stderr line was first observed'
    exit = await task.exit
    assert exit.stderr == 'booting\ntail\n' == task.stderr == ''.join(seen) == ''.join(events), (exit.stderr, task.stderr, seen, events)
    runner = child("import json,sys,threading,time\nsys.stderr.write('runner up\\n'); sys.stderr.flush()\ndef tick():\n    while True:\n        time.sleep(0.02); sys.stderr.write('tick\\n'); sys.stderr.flush()\nthreading.Thread(target=tick, daemon=True).start()\nfor line in sys.stdin:\n    m = json.loads(line)\n    if m.get('method') == 'initialize': print(json.dumps({'jsonrpc': '2.0', 'id': m['id'], 'result': " + repr(init) + "}), flush=True)\n")
    seen, events = [], []
    session = await connect(mercury=runner, on_stderr=seen.append)
    try:
        session.on('stderr', events.append)
        for _ in range(100):
            if 'tick' in ''.join(events): break
            await asyncio.sleep(0.01)
        assert session.child.returncode is None, 'the runner is still running'
        assert ''.join(seen).startswith('runner up\n') and session.stderr.startswith('runner up\n') and 'tick' in ''.join(events), (session.stderr, seen, events)
    finally: await session.close()
    exit = await session.exit
    assert exit.stderr == session.stderr == ''.join(seen), (exit.stderr, seen)
    def synchronous():
        seen, events = [], []
        with connect_sync(mercury=runner, on_stderr=seen.append) as session:
            session.on('stderr', events.append)
            for _ in range(100):
                if 'tick' in ''.join(events): break
                time.sleep(0.01)
            assert session.stderr.startswith('runner up\n') and ''.join(seen).startswith('runner up\n') and 'tick' in ''.join(events), (session.stderr, seen, events)
    await asyncio.to_thread(synchronous)


async def main():
    await check('Python cwd and executable words, door-aware exits', words)
    await check('Python FixtureServer.close() returns at once with a peer still on the socket: hello sent and nothing more, and a reader that stopped taking the replay', fixture_close)
    await check('Python closing a session while a runner ask is in flight: no error event, no unretrieved task exception, exit 0', close_mid_ask)
    await check('Python stderr is live on both doors and the sync session: on_stderr and the stderr event see a line while the child still runs, and stderr at exit is the whole text', live_stderr)
    await check('Python connect timeout and cancellation end a silent boot', boot_timeout)
    await check('Python termination after a fatal wire failure: the child is gone within the bound and the receipt names ' + ('SIGTERM (Windows: the first step ends it)' if WINDOWS else 'the SIGKILL escalation'), escalation)
    await check('Python interrupt the package sent settles as an interrupted outcome when the child ends by the signal; a foreign signal and terminate() stay errors', interrupted)
    await check('Python Windows road' + ('' if WINDOWS else ' driven on this host') + ': cancel ends the child and settles interrupted, terminate and the wire escalation report the signal sent, a natural exit 1 stays exit 1', windows_road)
    await check('Python host exit terminates live children', host_exit)
    await check('Python fork safety and thread-safe tool cancellation', fork_and_thread_cancel)
    await check('Python max_rows cap and clear_rows()', bounded_rows)
    pyproject = Path(__file__).resolve().parents[2].joinpath('sdk-py/pyproject.toml').read_text()
    assert __version__ in pyproject and 'Programming Language :: Python :: 3.14' in pyproject
    assert not failures, failures
    print('PASS Python lifecycle')

asyncio.run(main())
