#!/usr/bin/env python3
import os, sys, pty, time, select, signal, subprocess, tempfile, shutil, json, re, fcntl, termios, struct

ESCAPES = re.compile(rb"\x1b\[[0-9;?<>=]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|[\x00-\x08\x0b-\x1f]")

def set_window(fd):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    except OSError:
        pass

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BIN = os.environ.get("MERCURY_GH_DEADLINE_BIN", os.path.join(REPO, "dist", "mercury.mjs"))
NODE = os.path.join(os.path.dirname(BIN), "vendor", "node", "bin", "node")
if not os.path.exists(NODE):
    NODE = shutil.which("node")
SCALE = float(os.environ.get("MERCURY_VSHOT_BUDGET_SCALE", "1") or "1")
BOOT_BUDGET_S = 150 * SCALE
DEADLINE_MS = 3000
PROOF_KEY = "proof-key-ci-gate-not-a-real-key"
DEADLINE_WATCH_S = 20 * SCALE
EXIT_BUDGET_S = 30 * SCALE
TERMINAL_GONE_BUDGET_S = 75 * SCALE

fails = 0
def check(name, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(("PASS" if ok else "FAIL") + "  " + name + ((" — " + detail) if (detail and not ok) else ""), flush=True)

if not os.path.exists(BIN):
    print("FAIL  the built bundle is missing at " + BIN + " — run `bun run build.ts`")
    sys.exit(1)
if sys.platform == "win32":
    print("SKIP  gh-child-deadline: POSIX process semantics only")
    sys.exit(0)

scratch = os.path.realpath(tempfile.mkdtemp(prefix="gh-deadline-"))
HANG_GH = os.path.join(scratch, "hang-gh.mjs")
with open(HANG_GH, "w") as f:
    f.write("const a=process.argv.slice(2)\nif(a[0]==='auth'){process.exit(0)}\nsetInterval(()=>{}, 1<<30)\n")

def ps_table():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,stat=,command="], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4 or not (parts[0].isdigit() and parts[1].isdigit()):
            continue
        rows.append((int(parts[0]), int(parts[1]), parts[2], parts[3]))
    return rows

def descendants(root):
    rows = ps_table()
    kids = {}
    for pid, ppid, stat, cmd in rows:
        kids.setdefault(ppid, []).append((pid, stat, cmd))
    found = []
    stack = [root]
    while stack:
        p = stack.pop()
        for pid, stat, cmd in kids.get(p, []):
            found.append((pid, stat, cmd))
            stack.append(pid)
    return found

def gh_api_children(root):
    return [(pid, stat) for pid, stat, cmd in descendants(root) if HANG_GH in cmd and " api " in cmd]

def fixture_processes():
    return [(pid, stat, cmd[:80]) for pid, ppid, stat, cmd in ps_table() if scratch in cmd]

def stat_of(pid):
    try:
        out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    except Exception:
        return None
    return out or None

def alive(pid):
    s = stat_of(pid)
    return s is not None and not s.startswith("Z")

def make_home(tag):
    home = os.path.join(scratch, tag + "-home")
    work = os.path.join(scratch, tag + "-work")
    os.makedirs(home); os.makedirs(work)
    seed_env = dict(os.environ)
    seed_env["ANTHROPIC_API_KEY"] = PROOF_KEY
    seed = subprocess.run([os.environ.get("BUN", os.path.expanduser("~/.bun/bin/bun")), "run", os.path.join(REPO, "scripts", "lib", "firstRunSeed.ts"), home, work], cwd=REPO, capture_output=True, text=True, env=seed_env)
    if seed.returncode != 0:
        print("FAIL  seeding the onboarded home failed — " + (seed.stderr or seed.stdout)[-400:])
        shutil.rmtree(scratch, ignore_errors=True)
        sys.exit(1)
    env = dict(os.environ)
    for k in list(env):
        if k.startswith("MERCURY_") or k in ("CI", "NODE_ENV", "ANTHROPIC_BASE_URL"):
            env.pop(k, None)
    env.update({
        "MERCURY_CONFIG_DIR": home,
        "MERCURY_DAEMON_DIR": os.path.join(home, "daemon"),
        "MERCURY_HEALTH_STATE_DIR": os.path.join(home, "doctor"),
        "MERCURY_CREDENTIAL_STORE": "file",
        "MERCURY_DAEMON_NO_SELF_WARM": "1",
        "MERCURY_UPDATE_NOTICE": "1",
        "MERCURY_UPDATE_CHANNEL_REPO": "fixture/channel",
        "MERCURY_GH_CMD": json.dumps(["node", HANG_GH]),
        "MERCURY_GH_TIMEOUT_MS": str(DEADLINE_MS),
        "MERCURY_LOCAL_PROBE_TARGETS": "none",
        "BROWSER": "/usr/bin/true",
        "ANTHROPIC_API_KEY": PROOF_KEY,
        "TERM": "xterm-256color",
        "COLUMNS": "120",
        "LINES": "40",
    })
    return env, work

class Pump:
    def __init__(self, fd):
        self.fd = fd
        self.buf = bytearray()
        self.open = True
    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end and self.open:
            r, _, _ = select.select([self.fd], [], [], 0.2)
            if self.fd in r:
                try:
                    b = os.read(self.fd, 65536)
                except OSError:
                    self.open = False
                    return
                if not b:
                    self.open = False
                    return
                self.buf.extend(b)
    def saw(self, needle):
        return needle.encode() in ESCAPES.sub(b"", bytes(self.buf))
    def tail(self):
        text = ESCAPES.sub(b"", bytes(self.buf)).decode("utf8", "replace")
        return " | ".join(line.strip() for line in text.splitlines() if line.strip())[-400:]

def boot_until_gh(pump, root, fd):
    t0 = time.time()
    sent = False
    while time.time() - t0 < BOOT_BUDGET_S:
        pump.pump(0.5)
        if not sent and (pump.saw("New Session") or pump.saw("Type a prompt")):
            try:
                os.write(fd, b"\r")
            except OSError:
                pass
            sent = True
        kids = gh_api_children(root)
        if kids:
            return kids, round(time.time() - t0, 1)
    return [], round(time.time() - t0, 1)

def wait_gone(pids, seconds):
    end = time.time() + seconds
    while time.time() < end:
        if not any(alive(p) for p in pids):
            return True
        time.sleep(0.25)
    return not any(alive(p) for p in pids)

def wait_exit(pid, seconds):
    end = time.time() + seconds
    while time.time() < end:
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True, None
        if done == pid:
            return True, status
        time.sleep(0.1)
    return False, None

def exit_words(status):
    if status is None:
        return "reaped elsewhere"
    if os.WIFEXITED(status):
        return "exit %d" % os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return "signal %d" % os.WTERMSIG(status)
    return "status %r" % status

def end_everything(root):
    for pid, _, _ in descendants(root) + [(root, "", "")]:
        for sig in (signal.SIGCONT, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except OSError:
                pass
    for pid, _, _ in fixture_processes():
        for sig in (signal.SIGCONT, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except OSError:
                pass

print("§1 a stopped Mercury (its terminal then gone) cannot keep its gh check alive past the check's own deadline", flush=True)
env, work = make_home("stopped")
pid, master = pty.fork()
if pid == 0:
    os.chdir(work)
    os.environ.clear()
    os.environ.update(env)
    os.execv(NODE, [NODE, BIN])
    os._exit(127)
set_window(master)
pump = Pump(master)
kids, booted_s = boot_until_gh(pump, pid, master)
check("the product boots and its release-channel gh check is in flight (the fixture gh that never answers)", len(kids) > 0, "no gh api child within %.0fs; screen tail: %s" % (BOOT_BUDGET_S, pump.tail()))
if kids:
    print("  gh check in flight %.1fs after boot: %s" % (booted_s, kids), flush=True)
    os.kill(pid, signal.SIGSTOP)
    time.sleep(0.3)
    print("  product %d stopped (%s); closing its terminal" % (pid, stat_of(pid)), flush=True)
    os.close(master)
    gh_pids = [p for p, _ in kids]
    gone = wait_gone(gh_pids, DEADLINE_WATCH_S)
    check("the gh check ends at its own %ds deadline while its parent stays stopped" % (DEADLINE_MS // 1000), gone, "still alive after %.0fs: %s" % (DEADLINE_WATCH_S, [(p, stat_of(p)) for p in gh_pids]))
    check("the parent is still stopped, untouched by the deadline (a stopped process is the operator's or a runner's to continue)", (stat_of(pid) or "").startswith("T"), "state %s" % stat_of(pid))
    os.kill(pid, signal.SIGCONT)
    exited, status = wait_exit(pid, EXIT_BUDGET_S)
    check("continued, the product takes its terminal's hangup and exits", exited, "no exit within %.0fs after SIGCONT (state %s)" % (EXIT_BUDGET_S, stat_of(pid)))
    if exited:
        print("  exit: " + exit_words(status), flush=True)
    time.sleep(1.0)
    left = fixture_processes()
    check("nothing of the stopped run remains", len(left) == 0, str(left))
end_everything(pid)

print("§2 a Mercury whose terminal goes away with no hangup to its group exits, and its gh check in flight goes with it", flush=True)
env, work = make_home("revoked")
master, slave = pty.openpty()
set_window(slave)
child = subprocess.Popen([NODE, BIN], stdin=slave, stdout=slave, stderr=slave, cwd=work, env=env, close_fds=True)
os.close(slave)
pump = Pump(master)
kids, booted_s = boot_until_gh(pump, child.pid, master)
check("the product boots off a plain pty and its gh check is in flight", len(kids) > 0, "no gh api child within %.0fs; screen tail: %s" % (BOOT_BUDGET_S, pump.tail()))
if kids:
    print("  gh check in flight %.1fs after boot: %s" % (booted_s, kids), flush=True)
    holders = [(p, c[:60]) for p, s, c in descendants(child.pid) if HANG_GH not in c]
    os.close(master)
    t_close = time.time()
    exited, status = wait_exit(child.pid, TERMINAL_GONE_BUDGET_S)
    check("the product exits after its terminal is revoked (no hangup was sent: it is not the session leader)", exited, "no exit within %.0fs (state %s)" % (TERMINAL_GONE_BUDGET_S, stat_of(child.pid)))
    if exited:
        print("  exit: %s, %.1fs after the terminal went" % (exit_words(status), time.time() - t_close), flush=True)
    gh_pids = [p for p, _ in kids]
    gone = wait_gone(gh_pids, 10 * SCALE)
    check("the gh check in flight does not outlive the process", gone, "still alive: %s" % [(p, stat_of(p)) for p in gh_pids])
    time.sleep(1.0)
    left = fixture_processes()
    check("nothing of the revoked run remains", len(left) == 0, str(left))
end_everything(child.pid)

shutil.rmtree(scratch, ignore_errors=True)
if fails:
    print("\nFAIL gh-child-deadline — %d failure(s)" % fails)
    sys.exit(1)
print("\nPASS gh-child-deadline — a gh check carries its own deadline and never outlives its Mercury")
sys.exit(0)
