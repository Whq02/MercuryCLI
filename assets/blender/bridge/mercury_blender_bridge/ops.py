"""The verb handlers — ALL bpy lives here, main thread only (Mercury
Blender bridge). The pump timer dispatches through HANDLERS; the socket
thread never imports this module's world.

THE RENDER_ACTIVE LAW: mutate/exec verbs refuse while a
RENDER job runs (bpy.app.is_job_running('RENDER') is the truth source);
reads stay free — render_state DURING a render is that verb's whole point.
RENDER_PREVIEW (viewport preview shading) never refuses anything.

THE NO-RELOAD LAW: blend_open answers over a connection that HOLDS — this
module's state, the pump timer (persistent=True) and the @persistent
lifecycle handlers all survive bpy.ops.wm.open_mainfile by design.
"""

import contextlib
import io
import os
import time
import traceback

import bpy
from bpy.app.handlers import persistent

from . import ring, server, state

RENDER_GUARD_HINT = (
    "wait for render_finished (or read render_state); mutate/exec verbs refuse during renders, reads stay free"
)


def _err(code, message, hint=None):
    body = {"code": code, "message": message}
    if hint:
        body["hint"] = hint
    return (False, body)


def _ok(result):
    return (True, result)


def _render_active():
    try:
        return bool(bpy.app.is_job_running("RENDER"))
    except Exception:
        # An API drift here must fail CLOSED for mutate/exec (refuse) and
        # honest for reads — the bridge's own bookkeeping is the fallback.
        return bool(state.render_job["active"])


def _active_scene():
    scene = getattr(bpy.context, "scene", None)
    if scene is not None:
        return scene
    return bpy.data.scenes[0] if bpy.data.scenes else None


def _active_object_name():
    ob = getattr(bpy.context, "active_object", None)
    if ob is None:
        scene = _active_scene()
        if scene is not None and scene.view_layers:
            ob = scene.view_layers[0].objects.active
    return ob.name if ob is not None else None


# ── read verbs ───────────────────────────────────────────────────────────────


def scene_info(_args):
    scene = _active_scene()
    if scene is None:
        return _err("INTERNAL", "no scene exists in this file")
    return _ok(
        {
            "blendFile": bpy.data.filepath,
            "isSaved": bpy.data.is_saved,
            "isDirty": bpy.data.is_dirty,
            "blender": bpy.app.version_string,
            "scenes": [{"name": s.name, "isActive": s == scene} for s in bpy.data.scenes],
            "frameCurrent": scene.frame_current,
            "frameStart": scene.frame_start,
            "frameEnd": scene.frame_end,
            "engine": scene.render.engine,
            "mode": getattr(bpy.context, "mode", "OBJECT"),
            "activeObject": _active_object_name(),
        }
    )


def _object_visible(ob):
    try:
        return ob.visible_get()
    except Exception:
        # visible_get needs view-layer context a timer may lack — the
        # viewport-hide flag is the honest fallback.
        return not ob.hide_viewport


def objects_list(args):
    cap = args.get("maxObjects")
    if not isinstance(cap, int) or cap <= 0:
        cap = state.OBJECTS_NODE_CAP
    wanted = args.get("sceneName")
    scenes = [s for s in bpy.data.scenes if not isinstance(wanted, str) or s.name == wanted]
    if isinstance(wanted, str) and not scenes:
        return _err("BAD_ARGS", "no scene named '%s'" % wanted)
    counters = {"total": 0, "kept": 0}
    seen = set()

    def keep_node(name, type_, visible, children):
        counters["total"] += 1
        keep = counters["kept"] < cap
        if keep:
            counters["kept"] += 1
        kept_children = [c for c in children if c is not None] if keep else []
        return {"name": name, "type": type_, "visible": visible, "children": kept_children} if keep else None

    def walk_object(ob, children_of):
        # THE WALK LAW: the TOTAL counts every node even past the cap — only
        # the KEPT tree is bounded (truncatedNodes stays honest at any cap).
        if ob.name in seen:
            return None
        seen.add(ob.name)
        children = [walk_object(child, children_of) for child in children_of.get(ob, [])]
        return keep_node(ob.name, ob.type, _object_visible(ob), children)

    def walk_collection(coll, children_of):
        children = [walk_collection(c, children_of) for c in coll.children]
        children += [walk_object(ob, children_of) for ob in coll.objects if ob.parent is None]
        return keep_node(coll.name, "COLLECTION", True, children)

    out = []
    for scene in scenes:
        children_of = {}
        for ob in scene.objects:
            if ob.parent is not None:
                children_of.setdefault(ob.parent, []).append(ob)
        master = scene.collection
        roots = [walk_collection(c, children_of) for c in master.children]
        roots += [walk_object(ob, children_of) for ob in master.objects if ob.parent is None]
        out.append({"name": scene.name, "roots": [r for r in roots if r is not None]})
    return _ok(
        {
            "scenes": out,
            "nodeCount": counters["total"],
            "truncatedNodes": max(0, counters["total"] - counters["kept"]),
        }
    )


def render_state(_args):
    scene = _active_scene()
    if scene is None:
        return _err("INTERNAL", "no scene exists in this file")

    def job(kind):
        try:
            return bool(bpy.app.is_job_running(kind))
        except Exception:
            return False

    return _ok(
        {
            "jobs": {
                "render": job("RENDER"),
                "renderPreview": job("RENDER_PREVIEW"),
                "composite": job("COMPOSITE"),
                "objectBake": job("OBJECT_BAKE"),
            },
            "engine": scene.render.engine,
            "resolutionX": scene.render.resolution_x,
            "resolutionY": scene.render.resolution_y,
            "resolutionPercentage": scene.render.resolution_percentage,
            "outputPath": scene.render.filepath,
            "frameCurrent": scene.frame_current,
            "frameStart": scene.frame_start,
            "frameEnd": scene.frame_end,
        }
    )


def report_tail(args):
    severity = args.get("severity") if isinstance(args.get("severity"), str) else None
    limit = args.get("limit") if isinstance(args.get("limit"), int) else 100
    return _ok(ring.tail(limit=limit, severity=severity))


# ── mutate verbs ─────────────────────────────────────────────────────────────


def blend_open(args):
    if _render_active():
        return _err("RENDER_ACTIVE", "a render job is running", RENDER_GUARD_HINT)
    path = args.get("path")
    if not isinstance(path, str) or not path:
        return _err("BAD_ARGS", "path is required")
    if not (os.path.isfile(path) and path.endswith(".blend")):
        return _err("BLEND_NOT_FOUND", "no .blend at %s" % path)
    if bpy.data.is_dirty:
        return _err(
            "BLEND_DIRTY",
            "the open file has unsaved changes",
            "save it in Blender first (File > Save) — the bridge never discards unsaved work",
        )
    bpy.ops.wm.open_mainfile(filepath=path)
    # The no-reload law: the connection HOLDS across this open — the pump
    # timer is persistent and the load_post handler below already updated
    # the snapshot + emitted blend_changed by the time we answer.
    return _ok({"opened": path})


# ── exec verbs ───────────────────────────────────────────────────────────────


def render_still(args):
    if _render_active():
        return _err("RENDER_ACTIVE", "a render job is running", RENDER_GUARD_HINT)
    output_path = args.get("outputPath")
    if not isinstance(output_path, str) or not output_path or not os.path.isabs(output_path):
        return _err("BAD_ARGS", "outputPath is required and must be absolute (the durable result lands there)")
    scene = _active_scene()
    if scene is None:
        return _err("INTERNAL", "no scene exists in this file")
    frame = args.get("frame")
    if frame is not None and not isinstance(frame, int):
        return _err("BAD_ARGS", "frame must be a number")
    prev_filepath = scene.render.filepath
    prev_frame = scene.frame_current
    if isinstance(frame, int):
        scene.frame_set(frame)
    scene.render.filepath = output_path
    try:
        # INVOKE_DEFAULT runs the render as an editor JOB (the UI stays
        # live; render_complete/render_cancel report the end). A UI-less
        # context refuses this op — answered honestly below.
        bpy.ops.render.render("INVOKE_DEFAULT", write_still=True)
    except Exception as exc:
        scene.render.filepath = prev_filepath
        scene.frame_set(prev_frame)
        return _err(
            "INTERNAL",
            "could not start the render job: %s" % exc,
            "INVOKE renders need a Blender UI (background mode has none) — use the Launch tool's headless render profile instead",
        )
    state.render_job.update(
        active=True,
        outputPath=output_path,
        frame=scene.frame_current,
        prev_filepath=prev_filepath,
        prev_frame=prev_frame,
        started_at=time.monotonic(),
    )
    return _ok({"started": True, "outputPath": output_path, "frame": scene.frame_current})


def python_run(args):
    if _render_active():
        return _err("RENDER_ACTIVE", "a render job is running", RENDER_GUARD_HINT)
    source = args.get("source")
    if not isinstance(source, str) or not source:
        return _err("BAD_ARGS", "source is required")
    if len(source.encode("utf-8")) > state.PYTHON_SOURCE_CAP_BYTES:
        return _err("BAD_ARGS", "source exceeds the %d-byte cap" % state.PYTHON_SOURCE_CAP_BYTES)
    stdout_io = io.StringIO()
    stderr_io = io.StringIO()
    t0 = time.monotonic()
    try:
        with contextlib.redirect_stdout(stdout_io), contextlib.redirect_stderr(stderr_io):
            exec(compile(source, "<mercury_python_run>", "exec"), state.python_namespace)
    except Exception as exc:
        tail = "".join(traceback.format_exc().splitlines(keepends=True)[-12:])[:4096]
        return _err("PYTHON_EXCEPTION", "%s: %s" % (type(exc).__name__, exc), "traceback (tail): " + tail)
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    def cap(text):
        raw = text.encode("utf-8")
        over = max(0, len(raw) - state.PYTHON_OUTPUT_CAP_BYTES)
        return raw[: state.PYTHON_OUTPUT_CAP_BYTES].decode("utf-8", "replace"), over

    stdout, stdout_over = cap(stdout_io.getvalue())
    stderr, stderr_over = cap(stderr_io.getvalue())
    # `result` is CONSUMED by this run's answer (popped) — a stale value can
    # never leak into a later run's answer.
    value = None
    if "result" in state.python_namespace:
        value = repr(state.python_namespace.pop("result"))
        if len(value.encode("utf-8")) > state.PYTHON_OUTPUT_CAP_BYTES:
            value = value.encode("utf-8")[: state.PYTHON_OUTPUT_CAP_BYTES].decode("utf-8", "replace") + "…"
    return _ok(
        {
            "value": value,
            "stdout": stdout,
            "stderr": stderr,
            "truncated": {"stdout": stdout_over, "stderr": stderr_over},
            "elapsedMs": elapsed_ms,
        }
    )


# ── the dispatch table (keys == state.VERBS; the prover pins both against
#    the TypeScript contract) ────────────────────────────────────────────────

HANDLERS = {
    "scene_info": scene_info,
    "objects_list": objects_list,
    "blend_open": blend_open,
    "render_state": render_state,
    "render_still": render_still,
    "report_tail": report_tail,
    "python_run": python_run,
}


def dispatch(op, args):
    handler = HANDLERS.get(op)
    if handler is None:
        return _err("UNKNOWN_OP", "bridge does not handle '%s'" % op, "one of: %s" % ", ".join(state.VERBS))
    return handler(args if isinstance(args, dict) else {})


# ── lifecycle handlers (@persistent: they survive file loads — the
#    no-reload law's other half) ─────────────────────────────────────────────


@persistent
def _on_load_post(*_args):
    state.snapshot_update(blendFile=bpy.data.filepath)
    ring.handler_report("loaded %s" % (bpy.data.filepath or "(unsaved)"))
    server.emit("blend_changed", {"filepath": bpy.data.filepath})


@persistent
def _on_save_post(*_args):
    state.snapshot_update(blendFile=bpy.data.filepath)
    ring.handler_report("saved %s" % bpy.data.filepath)


def _finish_render(ok):
    # not ours: renders the operator started (F12) end here too — the
    # bridge's bookkeeping only covers renders IT started.
    if not state.render_job["active"]:
        return
    job = dict(state.render_job)
    state.render_job["active"] = False
    scene = _active_scene()
    if scene is not None:
        scene.render.filepath = job["prev_filepath"]
        try:
            scene.frame_set(job["prev_frame"])
        except Exception:
            pass
    wrote = os.path.isfile(job["outputPath"])
    duration_ms = int((time.monotonic() - job["started_at"]) * 1000)
    ring.handler_report(
        "render %s: %s" % ("finished" if ok and wrote else "cancelled" if not ok else "finished (file missing)", job["outputPath"])
    )
    server.emit(
        "render_finished",
        {
            "outputPath": job["outputPath"],
            "frame": job["frame"],
            "ok": bool(ok and wrote),
            "cancelled": not ok,
            "durationMs": duration_ms,
        },
    )


@persistent
def _on_render_complete(*_args):
    _finish_render(True)


@persistent
def _on_render_cancel(*_args):
    _finish_render(False)


def register_lifecycle():
    handlers = bpy.app.handlers
    if _on_load_post not in handlers.load_post:
        handlers.load_post.append(_on_load_post)
    if _on_save_post not in handlers.save_post:
        handlers.save_post.append(_on_save_post)
    if _on_render_complete not in handlers.render_complete:
        handlers.render_complete.append(_on_render_complete)
    if _on_render_cancel not in handlers.render_cancel:
        handlers.render_cancel.append(_on_render_cancel)


def unregister_lifecycle():
    handlers = bpy.app.handlers
    for lst, fn in (
        (handlers.load_post, _on_load_post),
        (handlers.save_post, _on_save_post),
        (handlers.render_complete, _on_render_complete),
        (handlers.render_cancel, _on_render_cancel),
    ):
        if fn in lst:
            lst.remove(fn)
