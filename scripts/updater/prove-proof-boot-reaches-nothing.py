#!/usr/bin/env python3
import os, sys, pty, time, select, signal, subprocess, tempfile, shutil, re, fcntl, termios, struct, threading

ESCAPES = re.compile(rb"\x1b\[[0-9;?<>=]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]|[\x00-\x08\x0b-\x1f]")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BIN = os.environ.get("MERCURY_PROOF_BOOT_BIN", os.path.join(REPO, "dist", "mercury.mjs"))
NODE = os.path.join(os.path.dirname(BIN), "vendor", "node", "bin", "node")
if not os.path.exists(NODE):
    NODE = shutil.which("node")
SCALE = float(os.environ.get("MERCURY_VSHOT_BUDGET_SCALE", "1") or "1")
BOOT_BUDGET_S = 150 * SCALE
WATCH_S = 45 * SCALE
PROOF_KEY = "proof-key-ci-gate-not-a-real-key"
LOOPBACK = re.compile(r"^(?:\[?::1\]?|127\.\d+\.\d+\.\d+|localhost)[:.]")

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
    print("SKIP  proof-boot-reaches-nothing: POSIX process and socket census only")
    sys.exit(0)
if shutil.which("lsof") is None:
    print("SKIP  proof-boot-reaches-nothing: lsof is needed for the socket census")
    sys.exit(0)

scratch = os.path.realpath(tempfile.mkdtemp(prefix="proof-boot-reach-"))
home = os.path.join(scratch, "home")
work = os.path.join(scratch, "work")
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
    if k.startswith("MERCURY_") or k in ("CI", "NODE_ENV", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"):
        env.pop(k, None)
env.update({
    "MERCURY_CONFIG_DIR": home,
    "MERCURY_DAEMON_DIR": os.path.join(home, "daemon"),
    "MERCURY_DOCTOR_STATE_DIR": os.path.join(home, "doctor"),
    "MERCURY_CREDENTIAL_STORE": "file",
    "MERCURY_DAEMON_NO_SELF_WARM": "1",
    "MERCURY_LOCAL_PROBE_TARGETS": "none",
    "ANTHROPIC_API_KEY": PROOF_KEY,
    "BROWSER": "/usr/bin/true",
    "TERM": "xterm-256color",
    "COLUMNS": "120",
    "LINES": "40",
})

def ps_table():
    out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    rows = []
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3 or not (parts[0].isdigit() and parts[1].isdigit()):
            continue
        rows.append((int(parts[0]), int(parts[1]), parts[2]))
    return rows

def tree(root):
    rows = ps_table()
    kids = {}
    for pid, ppid, cmd in rows:
        kids.setdefault(ppid, []).append((pid, cmd))
    found = [(root, "")]
    stack = [root]
    while stack:
        p = stack.pop()
        for pid, cmd in kids.get(p, []):
            found.append((pid, cmd))
            stack.append(pid)
    return found

def sockets_of(pids):
    if not pids:
        return []
    out = subprocess.run(["lsof", "-a", "-n", "-P", "-i", "-p", ",".join(str(p) for p in pids)], capture_output=True, text=True).stdout
    seen = []
    for line in out.splitlines()[1:]:
        cols = line.split()
        if len(cols) < 9:
            continue
        name = " ".join(cols[8:])
        if "->" not in name:
            continue
        peer = name.split("->", 1)[1]
        if LOOPBACK.match(peer):
            continue
        seen.append((cols[0], int(cols[1]), name))
    return seen

GH_SHAPES = ("gh auth", "gh api", " gh ", "/gh ", "(gh)", "security ")

reach = {"sockets": {}, "spawns": {}}
stop = threading.Event()
def sampler(root, t0):
    while not stop.is_set():
        members = tree(root)
        for pid, cmd in members[1:]:
            base = os.path.basename(cmd.split(" ", 1)[0]) if cmd else ""
            if base == "gh" or cmd.startswith("(gh)") or any(s in " " + cmd + " " for s in GH_SHAPES):
                reach["spawns"].setdefault(cmd[:120], round(time.time() - t0, 1))
        for cmd_name, pid, name in sockets_of([p for p, _ in members]):
            reach["sockets"].setdefault("%s %d %s" % (cmd_name, pid, name), round(time.time() - t0, 1))
        stop.wait(0.5)

pid, master = pty.fork()
if pid == 0:
    os.chdir(work)
    os.environ.clear()
    os.environ.update(env)
    os.execv(NODE, [NODE, BIN])
    os._exit(127)
try:
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
except OSError:
    pass

buf = bytearray()
def plain():
    return ESCAPES.sub(b"", bytes(buf))
def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.2)
        if master in r:
            try:
                b = os.read(master, 65536)
            except OSError:
                return False
            if not b:
                return False
            buf.extend(b)
    return True

t0 = time.time()
th = threading.Thread(target=sampler, args=(pid, t0), daemon=True)
th.start()
sent = False
mounted_at = None
while time.time() - t0 < BOOT_BUDGET_S:
    if not pump(0.5):
        break
    text = plain()
    if not sent and b"New Session" in text:
        os.write(master, b"\r")
        sent = True
    if sent and b"Type a prompt" in text:
        mounted_at = time.time()
        break
check("the product boots under the proof shape and opens a session", mounted_at is not None, "no composer within %.0fs; tail: %s" % (BOOT_BUDGET_S, " | ".join(l.strip() for l in plain().decode("utf8", "replace").splitlines() if l.strip())[-300:]))
if mounted_at is not None:
    print("  session open %.1fs after boot; watching %.0fs for any reach off the box" % (mounted_at - t0, WATCH_S), flush=True)
    end = mounted_at + WATCH_S
    while time.time() < end:
        pump(1.0)
        if reach["sockets"] or reach["spawns"]:
            pump(3.0)
            break
stop.set()
th.join(5)
check("no gh (nor its keychain helper) is spawned by a proof boot", not reach["spawns"], "; ".join("%ss %s" % (t, c) for c, t in reach["spawns"].items()))
check("no socket leaves the box during a proof boot", not reach["sockets"], "; ".join("%ss %s" % (t, s) for s, t in reach["sockets"].items()))

try:
    os.close(master)
except OSError:
    pass
deadline = time.time() + 20 * SCALE
exited = False
while time.time() < deadline:
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        exited = True
        break
    if done == pid:
        exited = True
        break
    time.sleep(0.2)
for p, _ in tree(pid)[1:] if not exited else []:
    for sig in (signal.SIGCONT, signal.SIGKILL):
        try:
            os.kill(p, sig)
        except OSError:
            pass
if not exited:
    for sig in (signal.SIGCONT, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except OSError:
            pass
for row in ps_table():
    if scratch in row[2]:
        for sig in (signal.SIGCONT, signal.SIGKILL):
            try:
                os.kill(row[0], sig)
            except OSError:
                pass
shutil.rmtree(scratch, ignore_errors=True)
if fails:
    print("\nFAIL proof-boot-reaches-nothing — %d failure(s)" % fails)
    sys.exit(1)
print("\nPASS proof-boot-reaches-nothing — a proof boot spawns no gh and opens no socket off the box")
sys.exit(0)
