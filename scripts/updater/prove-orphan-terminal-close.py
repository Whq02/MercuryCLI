#!/usr/bin/env python3
import os, sys, pty, time, select, signal, subprocess, tempfile, shutil, json

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BIN = os.environ.get("MERCURY_ORPHAN_BIN", os.path.join(REPO, "dist", "mercury.mjs"))
NODE = os.path.join(REPO, "dist", "vendor", "node", "bin", "node")
if not os.path.exists(NODE):
    NODE = shutil.which("node")
EXIT_BUDGET_S = float(os.environ.get("MERCURY_ORPHAN_EXIT_BUDGET", "12"))

fails = 0
def check(name, ok, detail=""):
    global fails
    if not ok:
        fails += 1
    print(("PASS" if ok else "FAIL") + "  " + name + ((" — " + detail) if (detail and not ok) else ""))

if not os.path.exists(BIN):
    print("FAIL  the built bundle is missing at " + BIN + " — run `bun run build.ts`")
    sys.exit(1)

def own_children(parent):
    try:
        out = subprocess.run(["ps", "-axo", "pid,ppid,command"], capture_output=True, text=True).stdout
    except Exception:
        return []
    kids = []
    for line in out.splitlines()[1:]:
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid_s, ppid_s, cmd = parts
        if not (pid_s.isdigit() and ppid_s.isdigit()):
            continue
        if int(ppid_s) == parent and (HANG_MARK in cmd):
            kids.append(int(pid_s))
    return kids

scratch = tempfile.mkdtemp(prefix="orphan-close-")
home = os.path.join(scratch, "home")
work = os.path.join(scratch, "work")
os.makedirs(home); os.makedirs(work)

HANG_MARK = os.path.join(scratch, "hang-gh.mjs")
with open(HANG_MARK, "w") as f:
    f.write("const a=process.argv.slice(2)\nif(a[0]==='auth'){process.exit(0)}\nsetInterval(()=>{}, 1<<30)\n")

seed = subprocess.run(
    ["bun", "-e",
     "const {seedFirstRun}=await import('./scripts/lib/firstRunSeed.ts');seedFirstRun(process.argv[1],[process.argv[2]])",
     home, work],
    cwd=REPO, capture_output=True, text=True)
if seed.returncode != 0:
    print("FAIL  seeding the onboarded home failed — " + (seed.stderr or seed.stdout)[-400:])
    shutil.rmtree(scratch, ignore_errors=True)
    sys.exit(1)

env = dict(os.environ)
env.update({
    "MERCURY_FULLSCREEN": "1",
    "MERCURY_CONFIG_DIR": home,
    "MERCURY_DAEMON_DIR": os.path.join(home, "daemon"),
    "MERCURY_DOCTOR_STATE_DIR": os.path.join(home, "doctor"),
    "MERCURY_CREDENTIAL_STORE": "file",
    "MERCURY_DAEMON_NO_SELF_WARM": "1",
    "MERCURY_UPDATE_NOTICE": "1",
    "MERCURY_UPDATE_CHANNEL_REPO": "Whq02/MercuryCLI",
    "MERCURY_GH_CMD": json.dumps(["node", HANG_MARK]),
    "BROWSER": "/usr/bin/true",
    "ANTHROPIC_API_KEY": "proof-key-ci-gate-not-a-real-key",
    "TERM": "xterm-256color",
})
for k in ("CI", "NODE_ENV", "ANTHROPIC_BASE_URL"):
    env.pop(k, None)

buf = bytearray()
def drain(fd, seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                b = os.read(fd, 65536)
            except OSError:
                return False
            if not b:
                return False
            buf.extend(b)
    return True

def wait_for(fd, needle, seconds):
    end = time.time() + seconds
    nb = needle.encode() if isinstance(needle, str) else needle
    while time.time() < end:
        if nb in bytes(buf):
            return True
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                b = os.read(fd, 65536)
            except OSError:
                break
            if not b:
                break
            buf.extend(b)
    return nb in bytes(buf)

pid, master = pty.fork()
if pid == 0:
    os.environ.clear()
    os.environ.update(env)
    os.execv(NODE, [NODE, BIN])
    os._exit(127)

spawned_kids = set()
armed = wait_for(master, b"\x1b[?1049h", 45) or wait_for(master, b"\x1b[?1047h", 2) or wait_for(master, "New Session", 5)
check("the built product boots and arms the terminal in a PTY (alternate screen on)", armed)
os.write(master, b"\r")
wait_for(master, "Type a prompt", 30)
deadline = time.time() + 14
while time.time() < deadline:
    for k in own_children(pid):
        spawned_kids.add(k)
    drain(master, 0.5)
in_flight = len(spawned_kids) > 0
print("  fixture gh children of THIS drive in flight at close: " + str(len(spawned_kids)))

close_at = time.time()
os.close(master)

status = None
while time.time() - close_at < EXIT_BUDGET_S:
    wpid, st = os.waitpid(pid, os.WNOHANG)
    if wpid == pid:
        status = st
        break
    time.sleep(0.1)

exited = status is not None
check("the process ENDS after the terminal closes (never wedges on a dead-terminal write)",
      exited, "no exit within %.0fs of the close — the orphan wedge" % EXIT_BUDGET_S)
if exited:
    print("  exited %.2fs after the close" % (time.time() - close_at))

time.sleep(0.5)
survivors = []
for k in spawned_kids:
    try:
        os.kill(k, 0)
        survivors.append(k)
    except OSError:
        pass
if in_flight:
    check("the drive's own fixture gh child does not outlive the ended parent", len(survivors) == 0, str(survivors))

if not exited:
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
for k in spawned_kids:
    try:
        os.kill(k, signal.SIGKILL)
    except OSError:
        pass

shutil.rmtree(scratch, ignore_errors=True)
if fails:
    print("\nFAIL orphan-terminal-close — %d failure(s)" % fails)
    sys.exit(1)
print("\nPASS orphan-terminal-close — a closed terminal ends the process; no dead-terminal write wedges it")
sys.exit(0)
