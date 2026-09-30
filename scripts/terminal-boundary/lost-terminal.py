#!/usr/bin/env python3
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time

mode, bundle, home, cwd, out = sys.argv[1:6]
argv_extra = json.loads(os.environ.get('LT_ARGV', '[]'))
send_prompt = os.environ.get('LT_SEND_PROMPT', '')
settle_s = float(os.environ.get('LT_SETTLE_S', '4'))
wait_exit_s = float(os.environ.get('LT_WAIT_EXIT_S', '75'))
prompt_settle_s = float(os.environ.get('LT_PROMPT_SETTLE_S', '3'))
inflight_file = os.environ.get('LT_INFLIGHT_FILE', '')
lab = os.path.dirname(out)
marker = os.path.join(lab, 'marker.jsonl')
go = marker + '.go'
for p in (marker, go):
    try:
        os.remove(p)
    except OSError:
        pass


def note(k, v=None):
    with open(marker, 'a') as f:
        f.write(json.dumps({'t': time.time(), 'k': k, 'v': v}) + '\n')


def notes():
    try:
        return [json.loads(l) for l in open(marker) if l.strip()]
    except Exception:
        return []


env = dict(os.environ)
env.update({
    'MERCURY_CONFIG_DIR': home,
    'MERCURY_CREDENTIAL_STORE': 'file',
    'ANTHROPIC_API_KEY': env.get('ANTHROPIC_API_KEY', 'proof-key-ci-gate-not-a-real-key'),
    'MERCURY_LOCAL_PROBE_TARGETS': 'none',
    'MERCURY_FULLSCREEN': '1',
    'MERCURY_CRITTER_IDLE': '0', 'MERCURY_CRITTER_GAZE': '0', 'MERCURY_CRITTER_SLEEP': '0',
    'MERCURY_LIVE_CLOCK': '0', 'MERCURY_LIVE_GLYPHS': '0',
    'ANTHROPIC_BASE_URL': env.get('ANTHROPIC_BASE_URL', 'http://127.0.0.1:9'),
    'TERM': 'xterm-256color',
})

pid, fd = pty.fork()
if pid == 0:
    os.environ.clear()
    os.environ.update(env)
    signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    if mode == 'eio':
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
    shell = os.fork()
    if shell == 0:
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        product = os.fork()
        if product == 0:
            os.setpgid(0, 0)
            os.chdir(cwd)
            os.execvp('node', ['node', bundle, *argv_extra])
        os.setpgid(product, product)
        os.tcsetpgrp(0, product)
        note('spawned', product)

        def milestones():
            try:
                with open(os.path.join(home, 'launch-milestones.json')) as f:
                    return [r for r in json.load(f).get('rows', []) if r.get('pid') == product]
            except Exception:
                return []

        deadline = time.time() + 90
        while time.time() < deadline:
            if any(r.get('milestone') == 'input-live' for r in milestones()):
                break
            time.sleep(0.2)
        note('milestones', [r.get('milestone') for r in milestones()])
        while not os.path.exists(go):
            time.sleep(0.05)
        if mode == 'eio':
            os.tcsetpgrp(0, os.getpgrp())
            os.setsid()
            note('terminal-taken')
        t0 = time.time()
        while True:
            try:
                _, st = os.waitpid(product, 0)
                break
            except InterruptedError:
                continue
        code = os.waitstatus_to_exitcode(st)
        note('exit', {'code': code if code >= 0 else None, 'signal': -code if code < 0 else None, 'afterS': round(time.time() - t0, 2)})
        os._exit(0)
    while True:
        try:
            os.waitpid(shell, 0)
            break
        except InterruptedError:
            continue
    os._exit(0)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', int(os.environ.get('LT_ROWS', '40')), int(os.environ.get('LT_COLS', '120')), 0, 0))
raw = bytearray()


def drain(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            raw.extend(data)
    return True


deadline = time.time() + 95
product_pid = None
while time.time() < deadline:
    drain(0.2)
    ns = notes()
    if product_pid is None:
        product_pid = next((n['v'] for n in ns if n['k'] == 'spawned'), None)
    if any(n['k'] == 'milestones' for n in ns):
        break
ms = next((n['v'] for n in notes() if n['k'] == 'milestones'), [])
drain(settle_s)
inflight = None
if send_prompt:
    os.write(fd, send_prompt.encode())
    drain(0.3)
    os.write(fd, b'\r')
    if inflight_file:
        limit = time.time() + 60
        while time.time() < limit and not os.path.exists(inflight_file):
            drain(0.2)
        inflight = os.path.exists(inflight_file)
    drain(prompt_settle_s)
open(go, 'w').close()
while mode == 'eio' and not any(n['k'] == 'terminal-taken' for n in notes()):
    drain(0.05)
drain(0.3)
if mode == 'eio':
    os.write(fd, b'x')
    master_open = True
elif mode == 'notice':
    os.write(fd, b'\x1b')
    drain(1.5)
    os.close(fd)
    master_open = False
else:
    os.close(fd)
    master_open = False

exit_note = None
end = time.time() + wait_exit_s
while time.time() < end:
    if master_open:
        drain(0.2)
    else:
        time.sleep(0.2)
    exit_note = next((n['v'] for n in notes() if n['k'] == 'exit'), None)
    if exit_note is not None:
        break
state = None
if exit_note is None and product_pid is not None:
    state = subprocess.run(['ps', '-o', 'pid=,pgid=,stat=,tty=', '-p', str(product_pid)], capture_output=True, text=True).stdout.strip()
    try:
        os.kill(product_pid, signal.SIGKILL)
    except OSError:
        pass
if master_open:
    try:
        os.close(fd)
    except OSError:
        pass
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except OSError:
    pass
time.sleep(0.5)

crashes = []
cdir = os.path.join(home, 'crashes')
if os.path.isdir(cdir):
    for f in sorted(os.listdir(cdir)):
        if f.startswith('crash-') and f.endswith('.json'):
            try:
                j = json.load(open(os.path.join(cdir, f)))
                crashes.append({'file': f, 'origin': j.get('origin'), 'message': j.get('message'), 'sessionId': j.get('sessionId'), 'pid': j.get('pid'), 'cwd': j.get('cwd'), 'transcriptPath': j.get('transcriptPath')})
            except Exception as e:
                crashes.append({'file': f, 'error': str(e)})
text = re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[=>]', b'', bytes(raw)).decode('utf-8', 'replace')
verdict = {
    'mode': mode, 'productPid': product_pid, 'milestones': ms,
    'exit': exit_note, 'stateWhenGivenUp': state,
    'inflight': inflight,
    'crashes': crashes,
    'notes': [n['k'] for n in notes()],
    'screen': text,
}
with open(out, 'w') as f:
    json.dump(verdict, f, indent=1)
print(json.dumps({k: v for k, v in verdict.items() if k != 'screen'}))
