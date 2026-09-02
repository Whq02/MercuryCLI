// ============================================================================
//  services/eval/pyRunnerSource — the bundled Python kernel runner.
//
//  One self-contained script (stdlib only, Python 3.10+), cached on disk by
//  content hash and spawned as a subprocess. Protocol per protocol.ts:
//  host→runner NDJSON on stdin, runner→host NDJSON on FD 3; user stdout and
//  stderr stay on fd 1/2 where the host captures them raw, so a native
//  library printing to fd 1 can never split a protocol frame.
//
//  Runner laws (mirrored by prove-kernel-cancel):
//  · SIGINT is IGNORED between cells (a stray signal cannot kill an idle
//    kernel) and raises KeyboardInterrupt only while user code runs;
//  · interactive stdin is a typed refusal, never a hang;
//  · bridge waits poll in short slices so an interrupt lands promptly and
//    portably (Windows has no interruptible lock acquire);
//  · every protocol frame carries the token from the host's hello.
// ============================================================================

export const PY_RUNNER_SOURCE: string = `# Mercury eval kernel runner (generated; do not edit in place)
import ast, base64, io, json, os, queue, signal, sys, threading, traceback, types

_PROTO = os.fdopen(3, "w", buffering=1, encoding="utf-8")
_PROTO_LOCK = threading.Lock()
_TOKEN = [None]
_CWD = [None]
_CURRENT_CELL = [None]
_EXEC_COUNT = [0]
_BRIDGE_SEQ = [0]
_BRIDGE_WAITS = {}
_QUEUE = queue.Queue()
_REAL_STDIN = sys.stdin.buffer


def _emit(frame):
    frame["token"] = _TOKEN[0]
    with _PROTO_LOCK:
        _PROTO.write(json.dumps(frame, default=str) + "\\n")
        _PROTO.flush()


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


def _reader():
    for raw in iter(_REAL_STDIN.readline, b""):
        try:
            msg = json.loads(raw.decode("utf-8"))
        except Exception:
            continue
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
                w["event"].set()
        elif t == "bye":
            _QUEUE.put(msg)
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
        raise RuntimeError(str(wait.get("error") or "bridge call failed"))
    return wait.get("value")


class _ToolProxy:
    def __call__(self, name, tool_input=None):
        return _bridge("tool", {"name": name, "input": tool_input or {}})

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


def completion(prompt, system=None, model=None, tier=None, schema=None):
    return _bridge("completion", {
        "prompt": prompt,
        "system": system,
        "model": model,
        "tier": tier,
        "schema": schema,
    })


def parallel(thunks, width=None):
    from concurrent.futures import ThreadPoolExecutor

    thunks = list(thunks)
    if not thunks:
        return []
    w = int(width or _bridge("width", {}) or 2)
    w = max(1, min(w, len(thunks)))
    with ThreadPoolExecutor(max_workers=w) as pool:
        futures = [pool.submit(t) for t in thunks]
        results = []
        for f in futures:  # input order preserved; lowest-index failure wins
            results.append(f.result())
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
    if hasattr(signal, "SIGINT"):
        signal.signal(signal.SIGINT, _interrupt_handler)
    try:
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
        status = "cancelled"
        cancelled = True
        _emit({
            "t": "error", "id": cell_id, "name": "KeyboardInterrupt",
            "value": "cell interrupted", "traceback": "",
        })
    except SystemExit as e:
        status = "error"
        _emit({
            "t": "error", "id": cell_id, "name": "SystemExit",
            "value": "exit(%s) — the kernel survives; use reset to recreate it" % (e.code,),
            "traceback": "",
        })
    except BaseException as e:
        status = "error"
        _emit({
            "t": "error", "id": cell_id, "name": type(e).__name__,
            "value": str(e)[:2000], "traceback": traceback.format_exc()[:8000],
        })
    finally:
        if hasattr(signal, "SIGINT"):
            signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        _end_marks(cell_id)
        _matplotlib_flush(cell_id)
        _CURRENT_CELL[0] = None
    _emit({"t": "done", "id": cell_id, "status": status, "cancelled": cancelled})


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
            return


if __name__ == "__main__":
    main()
`
