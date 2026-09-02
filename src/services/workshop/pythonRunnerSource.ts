// ============================================================================
//  workshop/pythonRunnerSource — the Python Workshop kernel, shipped as an
//  EMBEDDED source string run via `python3 -u -c <src>` (the same
//  no-path-drift idiom as the JS worker). NDJSON protocol v1 over
//  stdin/stdout:
//    host → kernel:  {type:'run', cellId, code} · {type:'reset'} ·
//                    {type:'rpc-result', id, ok, value|error} · {type:'exit'}
//    kernel → host:  {type:'ready', protocol} · {type:'output', stream, text}
//                    · {type:'display', kind, value} · {type:'rpc', id, kind,
//                    payload} · {type:'cell-done', cellId, ok, …}
//
//  Semantics:
//    · one persistent globals dict — Python state persists naturally;
//    · top-level await via PyCF_ALLOW_TOP_LEVEL_AWAIT on ONE persistent
//      event loop;
//    · the last bare expression is the cell value (ast-split, REPL-style);
//    · sys.stdin raises — interactive input is rejected with a clear error;
//    · SIGINT interrupts the running cell (KeyboardInterrupt — session
//      state RETAINED); the host escalates to SIGKILL after a bounded
//      interval (state loss reported);
//    · no package installation — imports resolve or fail honestly.
// ============================================================================

export const WORKSHOP_PYTHON_RUNNER_SOURCE = `
import sys, json, threading, queue, io, ast, asyncio, traceback, os

PROTOCOL_V = 1
_out_lock = threading.Lock()

def _send(obj):
    with _out_lock:
        sys.__stdout__.write(json.dumps(obj) + "\\n")
        sys.__stdout__.flush()

_MAX_OUT_BUF = 1 << 20  # seamark SM-C (PB-6): a newline-less stream chunk-emits
                        # past 1MB instead of ballooning the kernel AND the host
                        # (flush() used to emit one giant JSON line at cell end).

class _OutStream(io.TextIOBase):
    def __init__(self, stream):
        self._stream = stream
        self._buf = ""
    def write(self, s):
        if not s:
            return 0
        self._buf += s
        while "\\n" in self._buf:
            line, self._buf = self._buf.split("\\n", 1)
            _send({"type": "output", "stream": self._stream, "text": line})
        if len(self._buf) >= _MAX_OUT_BUF:
            _send({"type": "output", "stream": self._stream, "text": self._buf})
            self._buf = ""
        return len(s)
    def flush(self):
        if self._buf:
            _send({"type": "output", "stream": self._stream, "text": self._buf})
            self._buf = ""

class _NoStdin(io.TextIOBase):
    def read(self, *a):
        raise RuntimeError("interactive stdin is not available in Workshop cells - pass data in code or via mercury.tool")
    def readline(self, *a):
        raise RuntimeError("interactive stdin is not available in Workshop cells - pass data in code or via mercury.tool")

_requests = queue.Queue()
_rpc_lock = threading.Lock()
_rpc_events = {}
_rpc_responses = {}

def _reader():
    for line in sys.__stdin__:
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if msg.get("type") == "rpc-result":
            rid = msg.get("id")
            with _rpc_lock:
                _rpc_responses[rid] = msg
                ev = _rpc_events.get(rid)
            if ev:
                ev.set()
        else:
            _requests.put(msg)

threading.Thread(target=_reader, daemon=True).start()

_rpc_seq = 0

def _rpc(kind, payload):
    global _rpc_seq
    _rpc_seq += 1
    rid = _rpc_seq
    ev = threading.Event()
    with _rpc_lock:
        _rpc_events[rid] = ev
    _send({"type": "rpc", "id": rid, "kind": kind, "payload": payload})
    if not ev.wait(timeout=600):
        with _rpc_lock:
            _rpc_events.pop(rid, None)
        raise TimeoutError("bridge call timed out (600s)")
    with _rpc_lock:
        msg = _rpc_responses.pop(rid)
        _rpc_events.pop(rid, None)
    if msg.get("ok"):
        return msg.get("value")
    raise RuntimeError(msg.get("error") or "bridge call failed")

class _Mercury:
    def tool(self, name, input=None):
        return _rpc("tool", {"name": name, "input": input or {}})
    def agent(self, input):
        return _rpc("agent", {"input": input})
    def inspect(self, ref):
        return _rpc("inspect", {"ref": ref})
    def display(self, value):
        kind = "json"
        if isinstance(value, str):
            text = value
            kind = "markdown" if value.lstrip().startswith("#") else "text"
            if value.startswith("mercury://"):
                kind = "ref"
        else:
            try:
                text = json.dumps(value, indent=1, default=str)
            except Exception:
                text = repr(value)
                kind = "text"
        _send({"type": "display", "kind": kind, "value": str(text)[:20000]})
    async def parallel(self, thunks):
        return await asyncio.gather(*[t() if callable(t) else t for t in thunks])
    async def pipeline(self, items, *stages):
        async def _run(item, i):
            v = item
            for stage in stages:
                v = stage(v, item, i)
                if asyncio.iscoroutine(v):
                    v = await v
            return v
        return await asyncio.gather(*[_run(it, i) for i, it in enumerate(items)])

mercury = _Mercury()
_cell_globals = {"__name__": "__workshop__", "mercury": mercury}
_loop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)
sys.stdout = _OutStream("stdout")
sys.stderr = _OutStream("stderr")
sys.stdin = _NoStdin()

def _run_cell(msg):
    cell_id = msg["cellId"]
    code = msg["code"]
    try:
        tree = ast.parse(code, mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = ast.Expression(tree.body[-1].value)
            tree.body = tree.body[:-1]
        flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        value = None
        if tree.body:
            co = compile(tree, "<" + cell_id + ">", "exec", flags=flags)
            result = eval(co, _cell_globals)
            if asyncio.iscoroutine(result):
                _loop.run_until_complete(result)
        if last_expr is not None:
            co = compile(last_expr, "<" + cell_id + ">", "eval", flags=flags)
            value = eval(co, _cell_globals)
            if asyncio.iscoroutine(value):
                value = _loop.run_until_complete(value)
        sys.stdout.flush()
        sys.stderr.flush()
        _send({
            "type": "cell-done",
            "cellId": cell_id,
            "ok": True,
            "valuePreview": "" if value is None else repr(value)[:2000],
        })
    except KeyboardInterrupt:
        sys.stdout.flush()
        _send({
            "type": "cell-done",
            "cellId": cell_id,
            "ok": False,
            "interrupted": True,
            "error": "KeyboardInterrupt - the cell was interrupted; session state is RETAINED",
        })
    except Exception:
        sys.stdout.flush()
        _send({
            "type": "cell-done",
            "cellId": cell_id,
            "ok": False,
            "error": traceback.format_exc()[-4000:],
        })

_send({"type": "ready", "protocol": PROTOCOL_V, "python": sys.version.split()[0]})
while True:
    try:
        msg = _requests.get()
    except KeyboardInterrupt:
        continue
    t = msg.get("type")
    if t == "run":
        _run_cell(msg)
    elif t == "reset":
        _cell_globals.clear()
        _cell_globals.update({"__name__": "__workshop__", "mercury": mercury})
        _send({"type": "reset-done"})
    elif t == "exit":
        break
`
