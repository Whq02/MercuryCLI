import contextlib
import io
import json
import os
import re
import sys
import time
import traceback

import bpy


def _parse_paths(argv):
    if "--" not in argv:
        raise RuntimeError("missing '--' separator before driver arguments")
    idx = argv.index("--")
    rest = argv[idx + 1 :]
    if len(rest) < 2:
        raise RuntimeError("expected <request.json> <response.json> after '--'")
    return rest[0], rest[1]


def _cap_tail(text, cap_bytes):
    raw = text.encode("utf-8")
    over = max(0, len(raw) - cap_bytes)
    if over == 0:
        return text, 0
    return raw[-cap_bytes:].decode("utf-8", "replace"), over


def _whole_traceback(exc):
    tb = exc.__traceback__.tb_next if exc.__traceback__ is not None else None
    if tb is not None:
        return "".join(traceback.format_exception(type(exc), exc, tb))
    return "".join(traceback.format_exception_only(type(exc), exc))


_POLL_RE = re.compile(r"Operator (bpy\.ops\.[A-Za-z0-9_.]+)\.poll\(\) failed")


def _classify_exception(exc):
    msg = str(exc)
    if isinstance(exc, RuntimeError):
        m = _POLL_RE.search(msg)
        if m is not None:
            op_name = m.group(1)
            return (
                "WINDOW_REQUIRED",
                "operator %s requires a Blender window (headless -b runs with no window; open Blender with mercury_blender_bridge installed and enabled to run window operators): %s"
                % (op_name, msg),
            )
        if "background mode" in msg.lower() or ("opengl" in msg.lower() and "window" in msg.lower()):
            return (
                "WINDOW_REQUIRED",
                "operator requires a Blender window (headless -b runs with no window; open Blender with mercury_blender_bridge installed and enabled to run window operators): %s"
                % msg,
            )
    return ("PYTHON_EXCEPTION", "%s: %s" % (type(exc).__name__, msg))


def _run_render_still(args, ops_mod):
    output_path = args.get("outputPath")
    if not isinstance(output_path, str) or not output_path or not os.path.isabs(output_path):
        return (
            False,
            {
                "code": "BAD_ARGS",
                "message": "outputPath is required and must be absolute (the durable result lands there)",
            },
            None,
        )
    scene = ops_mod._active_scene()
    if scene is None:
        return (False, {"code": "INTERNAL", "message": "no scene exists in this file"}, None)
    frame = args.get("frame")
    if frame is not None and (not isinstance(frame, int) or isinstance(frame, bool)):
        return (False, {"code": "BAD_ARGS", "message": "frame must be a number"}, None)
    if isinstance(frame, int):
        scene.frame_set(frame)
    scene.render.filepath = output_path
    t0 = time.monotonic()
    try:
        bpy.ops.render.render("EXEC_DEFAULT", write_still=True)
    except BaseException as exc:
        code, message = _classify_exception(exc)
        return (False, {"code": code if code == "WINDOW_REQUIRED" else "INTERNAL", "message": message}, _whole_traceback(exc))
    duration_ms = int((time.monotonic() - t0) * 1000)
    if not os.path.isfile(output_path):
        return (
            False,
            {"code": "INTERNAL", "message": "render finished without writing %s" % output_path},
            None,
        )
    return (
        True,
        {
            "finished": True,
            "outputPath": output_path,
            "frame": scene.frame_current,
            "durationMs": duration_ms,
        },
        None,
    )


def _run_python(args, state_mod):
    source = args.get("source")
    if not isinstance(source, str) or not source:
        return (
            {"ok": False, "error": {"code": "BAD_ARGS", "message": "source is required"}},
            1,
        )
    if len(source.encode("utf-8")) > state_mod.PYTHON_SOURCE_CAP_BYTES:
        return (
            {
                "ok": False,
                "error": {
                    "code": "BAD_ARGS",
                    "message": "source exceeds the %d-byte cap" % state_mod.PYTHON_SOURCE_CAP_BYTES,
                },
            },
            1,
        )
    stdout_io = io.StringIO()
    stderr_io = io.StringIO()
    ns = {"__name__": "__mercury_python_run__"}
    t0 = time.monotonic()
    try:
        with contextlib.redirect_stdout(stdout_io), contextlib.redirect_stderr(stderr_io):
            exec(compile(source, "<mercury_python_run>", "exec"), ns)
    except SystemExit as sys_exc:
        raw_code = sys_exc.code
        if raw_code is not None and raw_code != 0:
            exit_code = raw_code if isinstance(raw_code, int) and 1 <= raw_code <= 255 else 1
            out_s, out_over = _cap_tail(stdout_io.getvalue(), state_mod.PYTHON_OUTPUT_CAP_BYTES)
            err_s, err_over = _cap_tail(stderr_io.getvalue(), state_mod.PYTHON_OUTPUT_CAP_BYTES)
            return (
                {
                    "ok": False,
                    "error": {"code": "PYTHON_EXCEPTION", "message": "SystemExit: %s" % (raw_code,)},
                    "traceback": _whole_traceback(sys_exc),
                    "stdout": out_s,
                    "stderr": err_s,
                    "truncated": {"stdout": out_over, "stderr": err_over},
                },
                exit_code,
            )
    except BaseException as exc:
        out_s, out_over = _cap_tail(stdout_io.getvalue(), state_mod.PYTHON_OUTPUT_CAP_BYTES)
        err_s, err_over = _cap_tail(stderr_io.getvalue(), state_mod.PYTHON_OUTPUT_CAP_BYTES)
        code, message = _classify_exception(exc)
        return (
            {
                "ok": False,
                "error": {"code": code, "message": message},
                "traceback": _whole_traceback(exc),
                "stdout": out_s,
                "stderr": err_s,
                "truncated": {"stdout": out_over, "stderr": err_over},
            },
            1,
        )

    elapsed_ms = int((time.monotonic() - t0) * 1000)
    out_s, out_over = _cap_tail(stdout_io.getvalue(), state_mod.PYTHON_OUTPUT_CAP_BYTES)
    err_s, err_over = _cap_tail(stderr_io.getvalue(), state_mod.PYTHON_OUTPUT_CAP_BYTES)
    value = None
    if "result" in ns:
        value = repr(ns.pop("result"))
        if len(value.encode("utf-8")) > state_mod.PYTHON_OUTPUT_CAP_BYTES:
            value = (
                value.encode("utf-8")[: state_mod.PYTHON_OUTPUT_CAP_BYTES].decode("utf-8", "replace")
                + "…"
            )
    return (
        {
            "ok": True,
            "result": {
                "value": value,
                "stdout": out_s,
                "stderr": err_s,
                "truncated": {"stdout": out_over, "stderr": err_over},
                "elapsedMs": elapsed_ms,
            },
        },
        0,
    )


def main():
    req_path, resp_path = _parse_paths(sys.argv)
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)

    from mercury_blender_bridge import ops, ring, state

    ring.attach_logging()
    ops.register_lifecycle()

    def finish(payload, exit_code):
        try:
            ops.unregister_lifecycle()
            ring.detach_logging()
        except Exception:
            pass
        with open(resp_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        sys.exit(exit_code)

    with open(req_path, "r", encoding="utf-8") as fh:
        req = json.load(fh)

    op = req.get("op")
    args = req.get("args") if isinstance(req.get("args"), dict) else {}
    blend = req.get("blend")

    if isinstance(blend, str) and blend:
        if not (os.path.isfile(blend) and blend.endswith(".blend")):
            finish(
                {"ok": False, "error": {"code": "BLEND_NOT_FOUND", "message": "no .blend at %s" % blend}},
                1,
            )
        try:
            bpy.ops.wm.open_mainfile(filepath=blend)
        except BaseException as exc:
            finish(
                {
                    "ok": False,
                    "error": {"code": "INTERNAL", "message": "failed to open %s: %s" % (blend, exc)},
                    "traceback": _whole_traceback(exc),
                },
                1,
            )

    if op == "render_still":
        ok, body, tb_text = _run_render_still(args, ops)
        if ok:
            finish({"ok": True, "result": body}, 0)
        payload = {"ok": False, "error": body}
        if tb_text:
            payload["traceback"] = tb_text
        finish(payload, 1)

    if op == "python_run":
        payload, exit_code = _run_python(args, state)
        finish(payload, exit_code)

    ok, body = ops.dispatch(op, args)
    if ok:
        finish({"ok": True, "result": body}, 0)
    finish({"ok": False, "error": body}, 1)


if __name__ == "__main__":
    main()
