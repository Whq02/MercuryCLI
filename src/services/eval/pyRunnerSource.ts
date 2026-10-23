
export const PY_RUNNER_SOURCE: string = `# Mercury eval kernel runner (generated; do not edit in place)
import ast, base64, io, json, os, queue, signal, sys, threading, traceback, types


_PROTOCOL_PORT = [None]


def _open_protocol():
    if "--protocol-port" in sys.argv:
        at = sys.argv.index("--protocol-port")
        _PROTOCOL_PORT[0] = int(sys.argv[at + 1])
        del sys.argv[at:at + 2]
        import socket
        sock = socket.create_connection(("127.0.0.1", _PROTOCOL_PORT[0]))
        return sock.makefile("w", buffering=1, encoding="utf-8")
    return os.fdopen(3, "w", buffering=1, encoding="utf-8")


_PROTO = _open_protocol()
_PROTO_LOCK = threading.Lock()
_TOKEN = [None]
_CWD = [None]
_CURRENT_CELL = [None]
_EXEC_COUNT = [0]
_BRIDGE_SEQ = [0]
_BRIDGE_WAITS = {}
_QUEUE = queue.Queue()
_STDIN_FD = os.dup(sys.stdin.fileno())


def _check_floor_path(raw_path, writing=False):
    if not _CURRENT_CELL[0] or not isinstance(raw_path, (str, bytes, os.PathLike)):
        return
    try:
        p = os.fsdecode(raw_path)
    except Exception:
        return
    if not p or not isinstance(p, str):
        return
    p = p.strip()
    cands = []
    for base in (os.path.abspath(p), os.path.realpath(p)):
        n = base.replace("\\\\", "/").rstrip("/").lower()
        if n not in cands:
            cands.append(n)
    dot_home = "." + "mercury"
    homes = []
    for h in (os.environ.get("MERCURY_CONFIG_DIR"), os.environ.get("MERCURY_HOME"), os.path.expanduser("~/" + dot_home)):
        if h:
            for form in (str(h), os.path.realpath(h)):
                nf = form.replace("\\\\", "/").rstrip("/").lower()
                if nf not in homes:
                    homes.append(nf)
    u_homes = []
    for h in (os.environ.get("HOME"), os.environ.get("USERPROFILE"), os.path.expanduser("~")):
        if h:
            for form in (str(h), os.path.realpath(h)):
                nf = form.replace("\\\\", "/").rstrip("/").lower()
                if nf not in u_homes:
                    u_homes.append(nf)
    for c in cands:
        parent, name = os.path.dirname(c), os.path.basename(c)
        if parent in homes or parent.endswith("/" + dot_home):
            if name in (".credentials.json", ".provider-secrets.json", "browser-secrets.json") or name.endswith("-auth.json") or name.startswith(".credentials.json.corrupt.") or name.startswith(".provider-secrets.json.corrupt."):
                raise PermissionError(f"Reading or writing {p} is refused: {c} holds Mercury's own credentials.")
        if writing:
            if any(c == h + "/runtime" or c.startswith(h + "/runtime/") for h in homes):
                raise PermissionError(f"Writing {p} is refused: {c} is part of Mercury's running runtime.")
            sys_c = "/etc" + c[len("/private/etc"):] if c == "/private/etc" or c.startswith("/private/etc/") else c
            if sys_c in ("/etc/sudoers", "/etc/passwd", "/etc/shadow") or any(sys_c == b or sys_c.startswith(b + "/") for b in ("/etc/sudoers.d", "/etc/systemd", "/library/keychains")):
                raise PermissionError(f"Writing {p} is refused: {c} is a protected system or credential path.")
            for uh in u_homes:
                if any(c == f"{uh}/{f}" for f in (".netrc", ".pgpass", ".npmrc", ".pypirc", ".git-credentials")) or any(c == f"{uh}/{d}" or c.startswith(f"{uh}/{d}/") for d in (".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config/gh", ".config/gcloud", "library/keychains", ".local/share/keyrings")):
                    raise PermissionError(f"Writing {p} is refused: {c} is a protected system or credential path.")


def _audit_hook(event, args):
    if not _CURRENT_CELL[0]:
        return
    if event == "open" and len(args) >= 2:
        mode = str(args[1] or "r")
        _check_floor_path(args[0], any(ch in mode for ch in "wax+"))
    elif event in ("os.remove", "os.unlink", "os.rmdir", "os.truncate", "os.chmod") and len(args) >= 1:
        _check_floor_path(args[0], True)
    elif event in ("os.rename", "os.replace") and len(args) >= 2:
        _check_floor_path(args[0], True)
        _check_floor_path(args[1], True)


sys.addaudithook(_audit_hook)


def _emit(frame):
    frame["token"] = _TOKEN[0]
    with _PROTO_LOCK:
        _PROTO.write(json.dumps(frame, default=str) + "\\n")
        _PROTO.flush()


def _leave(code):
    try:
        _PROTO_LOCK.acquire(timeout=0.5)
        for stream in (_PROTO, sys.stdout, sys.stderr, sys.__stdout__, sys.__stderr__):
            try:
                stream.flush()
            except BaseException:
                pass
    except BaseException:
        pass
    finally:
        os._exit(code)


def _term_handler(signum, frame):
    _leave(0)


def _safe_str(obj):
    try:
        return str(obj)
    except BaseException:
        try:
            return object.__repr__(obj)
        except BaseException:
            return "<unprintable>"


def _safe_format_exc():
    try:
        return traceback.format_exc()
    except BaseException:
        return ""


class _RejectingStdin(io.TextIOBase):
    def readable(self):
        return False

    def _refuse(self, *a, **k):
        raise RuntimeError(
            "interactive stdin is not available in eval cells; "
            "pass data in as code or read files instead"
        )

    read = _refuse
    readline = _refuse
    readlines = _refuse


def _take_line(raw):
    try:
        msg = json.loads(raw.decode("utf-8"))
    except Exception:
        return
    t = msg.get("t")
    if t == "hello":
        _TOKEN[0] = msg.get("token")
        _CWD[0] = msg.get("cwd")
        _QUEUE.put(msg)
    elif t == "exec":
        _QUEUE.put(msg)
    elif t == "bridge_result":
        w = _BRIDGE_WAITS.get(msg.get("bridgeId"))
        if w is not None:
            w["ok"] = bool(msg.get("ok"))
            w["value"] = msg.get("value")
            w["error"] = msg.get("error")
            w["errorKind"] = msg.get("errorKind", "error")
            w["event"].set()
    elif t == "bye":
        _QUEUE.put(msg)


def _reader():
    # Raw reads on a duplicate of fd 0: the thread blocks in the kernel's
    # read(2) and holds no io buffer lock, so nothing the main thread closes
    # or finalizes can wait on it. EOF and a dead descriptor both say bye.
    pending = b""
    while True:
        try:
            chunk = os.read(_STDIN_FD, 65536)
        except BaseException:
            chunk = b""
        if not chunk:
            break
        pending += chunk
        while True:
            at = pending.find(b"\\n")
            if at < 0:
                break
            line = pending[:at + 1]
            pending = pending[at + 1:]
            try:
                _take_line(line)
            except BaseException:
                pass
    _QUEUE.put({"t": "bye"})


def _bridge(kind, payload):
    _BRIDGE_SEQ[0] += 1
    bid = "b%d" % _BRIDGE_SEQ[0]
    ev = threading.Event()
    wait = {"event": ev}
    _BRIDGE_WAITS[bid] = wait
    try:
        _emit({
            "t": "bridge",
            "bridgeId": bid,
            "id": _CURRENT_CELL[0] or "",
            "kind": kind,
            "payload": payload,
        })
        while not ev.wait(0.2):
            pass
    finally:
        _BRIDGE_WAITS.pop(bid, None)
    if not wait.get("ok"):
        error = RuntimeError(str(wait.get("error") or "bridge call failed"))
        error.kind = wait.get("errorKind", "error")
        raise error
    return wait.get("value")


def _attempt(name, tool_input):
    # The error as a value: {"ok": True, "value": ...} or {"ok": False,
    # "error": ...}, so a batch of calls finishes and reports each outcome.
    try:
        return {"ok": True, "value": _bridge("tool", {"name": name, "input": tool_input or {}})}
    except KeyboardInterrupt:
        raise
    except BaseException as e:
        return {"ok": False, "error": str(e)[:2000]}


class _ToolProxy:
    def __call__(self, name, tool_input=None):
        return _bridge("tool", {"name": name, "input": tool_input or {}})

    def attempt(self, name, tool_input=None, **kwargs):
        return _attempt(name, tool_input if tool_input is not None else kwargs)

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def call(**kwargs):
            return _bridge("tool", {"name": name, "input": kwargs})

        return call


def display(obj, mime=None):
    if mime is not None:
        _emit({"t": "display", "id": _CURRENT_CELL[0] or "", "mime": mime, "data": str(obj)})
        return
    if isinstance(obj, dict) and all(isinstance(k, str) and "/" in k for k in obj):
        for k, v in obj.items():
            _emit({"t": "display", "id": _CURRENT_CELL[0] or "", "mime": k, "data": str(v)})
        return
    _emit({"t": "display", "id": _CURRENT_CELL[0] or "", "mime": "text/plain", "data": repr(obj)})


def display_markdown(text):
    _emit({"t": "display", "id": _CURRENT_CELL[0] or "", "mime": "text/markdown", "data": str(text)})


def display_json(obj):
    _emit({
        "t": "display",
        "id": _CURRENT_CELL[0] or "",
        "mime": "application/json",
        "data": json.dumps(obj, default=str),
    })


def display_image(data, mime="image/png"):
    if isinstance(data, (bytes, bytearray)):
        payload = base64.b64encode(bytes(data)).decode("ascii")
    else:
        payload = str(data)
    _emit({"t": "display", "id": _CURRENT_CELL[0] or "", "mime": mime, "data": payload, "b64": True})


tool = _ToolProxy()


def agent(prompt, agent_type=None, label=None, schema=None, strict=True, worktree=False):
    return _bridge("agent", {
        "prompt": prompt,
        "agentType": agent_type,
        "label": label,
        "schema": schema,
        "strict": bool(strict),
        "worktree": bool(worktree),
    })


def sample(spec=None, **kwargs):
    if spec is None:
        spec = kwargs
    elif isinstance(spec, dict):
        spec = {**spec, **kwargs}
    return _bridge("sample", spec)


def completion(prompt, system=None, model=None, tier=None, schema=None):
    return _bridge("completion", {
        "prompt": prompt,
        "system": system,
        "model": model,
        "tier": tier,
        "schema": schema,
    })


def parallel(thunks, width=None, settled=False):
    from concurrent.futures import ThreadPoolExecutor

    thunks = list(thunks)
    if not thunks:
        if settled:
            parallel.results = []
        return []
    w = int(width or _bridge("width", {}) or 2)
    w = max(1, min(w, len(thunks)))

    def settle(thunk):
        try:
            return {"ok": True, "value": thunk()}
        except BaseException as e:
            kind = "cancelled" if isinstance(e, KeyboardInterrupt) else "permission" if isinstance(e, PermissionError) else getattr(e, "kind", "error")
            return {"ok": False, "error": {"kind": kind, "name": type(e).__name__, "message": _safe_str(e)}}

    with ThreadPoolExecutor(max_workers=w) as pool:
        futures = [pool.submit(settle, t) if settled else pool.submit(t) for t in thunks]
        results = []
        for f in futures:  # input order preserved; lowest-index failure wins
            results.append(f.result())
        if settled:
            parallel.results = results
            failed = [str(i) for i, result in enumerate(results) if not result["ok"]]
            if failed:
                print("Parallel failed indices (0-based): " + ", ".join(failed) + "; results remain in parallel.results.")
        return results


def pipeline(items, *stages, width=None):
    current = list(items)
    for stage in stages:
        current = parallel([(lambda it=it, s=stage: s(it)) for it in current], width=width)
    return current


def read_file(path, **kwargs):
    return _bridge("tool", {"name": "Read", "input": {"file_path": os.path.abspath(path), **kwargs}})


def write_file(path, content):
    return _bridge("tool", {"name": "Write", "input": {"file_path": os.path.abspath(path), "content": content}})


def _matplotlib_flush(cell_id):
    if "matplotlib" not in sys.modules:
        return
    try:
        import matplotlib.pyplot as plt

        for num in list(plt.get_fignums()):
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png")
            _emit({
                "t": "display",
                "id": cell_id,
                "mime": "image/png",
                "data": base64.b64encode(buf.getvalue()).decode("ascii"),
                "b64": True,
            })
        plt.close("all")
    except Exception:
        pass


def _interrupt_handler(signum, frame):
    raise KeyboardInterrupt()


_NS = {
    "__name__": "__main__",
    "display": display,
    "display_markdown": display_markdown,
    "display_json": display_json,
    "display_image": display_image,
    "tool": tool,
    "sample": sample,
    "agent": agent,
    "completion": completion,
    "parallel": parallel,
    "pipeline": pipeline,
    "read_file": read_file,
    "write_file": write_file,
}


def _run_cell(cell_id, code):
    _CURRENT_CELL[0] = cell_id
    _EXEC_COUNT[0] += 1
    _emit({"t": "started", "id": cell_id})
    status = "ok"
    cancelled = False
    names_before = set(_NS.keys())
    try:
        if hasattr(signal, "SIGINT"):
            signal.signal(signal.SIGINT, _interrupt_handler)
        tree = ast.parse(code, mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = ast.Expression(tree.body[-1].value)
            last_expr = ast.fix_missing_locations(last_expr)
            tree.body = tree.body[:-1]
        exec(compile(tree, "<cell>", "exec"), _NS)
        if last_expr is not None:
            value = eval(compile(last_expr, "<cell>", "eval"), _NS)
            if value is not None:
                _NS["_"] = value
                _emit({"t": "result", "id": cell_id, "repr": repr(value)[:10000]})
    except KeyboardInterrupt:
        _ignore_sigint()
        status = "cancelled"
        cancelled = True
        _emit({
            "t": "error", "id": cell_id, "name": "KeyboardInterrupt",
            "value": "cell interrupted", "traceback": "",
        })
    except SystemExit as e:
        _ignore_sigint()
        status = "error"
        _emit({
            "t": "error", "id": cell_id, "name": "SystemExit",
            "value": "exit(%s) — the kernel survives; use reset to recreate it" % (_safe_str(e.code),),
            "traceback": "",
        })
    except BaseException as e:
        _ignore_sigint()
        status = "error"
        # The names this cell bound before the error: the namespace keeps
        # them, and the next cell can rely on exactly these.
        survived = sorted(k for k in _NS.keys() if k not in names_before and not k.startswith("_"))
        _emit({
            "t": "error", "id": cell_id, "name": type(e).__name__,
            "value": _safe_str(e)[:2000], "traceback": _safe_format_exc()[:8000],
            "survived": survived,
        })
    finally:
        _ignore_sigint()
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except BaseException:
            pass
        _end_marks(cell_id)
        _matplotlib_flush(cell_id)
        _CURRENT_CELL[0] = None
    _emit({"t": "done", "id": cell_id, "status": status, "cancelled": cancelled})


def _ignore_sigint():
    if hasattr(signal, "SIGINT"):
        try:
            signal.signal(signal.SIGINT, signal.SIG_IGN)
        except BaseException:
            pass


def _end_marks(cell_id):
    # The cell's end mark on fd 1 AND fd 2, written after the flush and
    # ahead of the done frame: the host settles the cell only once both
    # marks have arrived, so a done frame on fd 3 can never overtake the
    # cell's last output bytes on the data pipes. os.write hits the fds
    # themselves — user code that rebinds sys.stdout cannot swallow it.
    mark = ("\\x1fmercury-eval-end " + cell_id + " " + str(_TOKEN[0]) + "\\x1f").encode("utf-8")
    for fd in (1, 2):
        try:
            os.write(fd, mark)
        except Exception:
            pass


def main():
    if hasattr(signal, "SIGINT"):
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _term_handler)
    sys.stdin = _RejectingStdin()
    reader = threading.Thread(target=_reader, daemon=True)
    reader.start()
    while True:
        msg = _QUEUE.get()
        t = msg.get("t")
        if t == "hello":
            cwd = msg.get("cwd")
            if cwd:
                try:
                    os.chdir(cwd)
                except Exception:
                    pass
            _NS["env"] = types.MappingProxyType(dict(os.environ))
            _emit({"t": "ready"})
        elif t == "exec":
            _run_cell(str(msg.get("id")), str(msg.get("code")))
        elif t == "bye":
            _leave(0)


if __name__ == "__main__":
    code = 0
    try:
        main()
    except BaseException:
        code = 1
        try:
            traceback.print_exc()
        except BaseException:
            pass
    finally:
        _leave(code)
`
