import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

interface FakeBlenderInvocation {
  argv: string[]
  pid: number
  cwd: string
}

interface FakeBlenderFixture {
  bin: string
  logPath: string
  invocations: () => FakeBlenderInvocation[]
  clearInvocations: () => void
}

const FAKE_BLENDER_PY = `#!/usr/bin/env python3
import json
import os
import runpy
import sys
import time
import traceback
import types

VERSION = os.environ.get("FAKE_BLENDER_VERSION", "__DEFAULT_VERSION__")
LOG_PATH = "__LOG_PATH__"

argv = list(sys.argv[1:])

def record_invocation():
    if not LOG_PATH:
        return
    entry = {"argv": argv, "pid": os.getpid(), "cwd": os.getcwd()}
    with open(LOG_PATH, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry) + "\\n")

record_invocation()

if "--version" in argv or "-v" in argv:
    sys.stdout.write("Blender %s\\n\\tbuild date: 2026-11-10\\n" % VERSION)
    sys.stdout.flush()
    sys.exit(0)

FORBIDDEN = {"-y", "--enable-autoexec", "--python-use-system-env", "--python-use-user-env"}
present_forbidden = [flag for flag in argv if flag in FORBIDDEN]
if present_forbidden:
    sys.stderr.write("REFUSED forbidden flag(s): %s\\n" % ",".join(present_forbidden))
    sys.stderr.flush()
    sys.exit(98)

background = ("-b" in argv) or ("--background" in argv)
if not background:
    sys.stderr.write("REFUSED window launch (-b missing)\\n")
    sys.stderr.flush()
    sys.exit(99)

quiet = ("-q" in argv) or ("--quiet" in argv)
offline = "--offline-mode" in argv
disable_autoexec = ("--disable-autoexec" in argv) or ("-Y" in argv)

python_exit_code = 0
if "--python-exit-code" in argv:
    idx = argv.index("--python-exit-code")
    if idx + 1 < len(argv):
        python_exit_code = int(argv[idx + 1])

script_path = None
if "--python" in argv:
    idx = argv.index("--python")
    if idx + 1 < len(argv):
        script_path = argv[idx + 1]
elif "-P" in argv:
    idx = argv.index("-P")
    if idx + 1 < len(argv):
        script_path = argv[idx + 1]

if not quiet:
    os.write(1, ("Blender %s (hash deadbeef)\\n" % VERSION).encode("utf-8"))

c_out = os.environ.get("FAKE_BLENDER_C_STDOUT", "")
if c_out:
    os.write(1, c_out.encode("utf-8"))
c_err = os.environ.get("FAKE_BLENDER_C_STDERR", "")
if c_err:
    os.write(2, c_err.encode("utf-8"))

parts = [int(p) if p.isdigit() else 0 for p in VERSION.split(".")[:3]]
while len(parts) < 3:
    parts.append(0)
ver_tuple = tuple(parts[:3])
default_engine = "BLENDER_EEVEE" if ver_tuple[0] >= 5 else "BLENDER_EEVEE_NEXT"

def install_fake_modules():
    for mod_name, mod_ver in (
        ("numpy", "2.3.4"),
        ("mathutils", None),
        ("bmesh", None),
        ("bpy_extras", None),
        ("imbuf", None),
    ):
        m = types.ModuleType(mod_name)
        m.__spec__ = types.SimpleNamespace(name=mod_name, loader=None)
        if mod_ver is not None:
            m.__version__ = mod_ver
        sys.modules[mod_name] = m
    for blocked in ("PIL", "scipy", "cv2", "matplotlib"):
        sys.modules.pop(blocked, None)

    orig_find_spec = __import__("importlib.util").util.find_spec
    def fake_find_spec(name, package=None):
        root = name.split(".")[0]
        if root in ("numpy", "mathutils", "bmesh", "bpy_extras", "imbuf", "bpy"):
            return types.SimpleNamespace(name=name)
        if root in ("PIL", "scipy", "cv2", "matplotlib"):
            return None
        return orig_find_spec(name, package)
    __import__("importlib.util").util.find_spec = fake_find_spec

    bpy_mod = types.ModuleType("bpy")
    bpy_mod.__spec__ = types.SimpleNamespace(name="bpy", loader=None)

    handlers_ns = types.ModuleType("bpy.app.handlers")
    def persistent(fn):
        return fn
    handlers_ns.persistent = persistent
    handlers_ns.load_post = []
    handlers_ns.save_post = []
    handlers_ns.render_complete = []
    handlers_ns.render_cancel = []

    app_ns = types.ModuleType("bpy.app")
    app_ns.version = ver_tuple
    app_ns.version_string = VERSION
    app_ns.background = True
    app_ns.online_access = not offline
    app_ns.handlers = handlers_ns
    app_ns.is_job_running = lambda _kind: False

    class FakeObj:
        def __init__(self, name, obj_type, parent=None, hide_viewport=False):
            self.name = name
            self.type = obj_type
            self.parent = parent
            self.hide_viewport = hide_viewport
        def visible_get(self):
            return not self.hide_viewport

    class FakeCollection:
        def __init__(self, name, objects=None, children=None):
            self.name = name
            self.objects = list(objects or [])
            self.children = list(children or [])

    class FakeRenderSettings:
        def __init__(self):
            self.engine = default_engine
            self.resolution_x = 1920
            self.resolution_y = 1080
            self.resolution_percentage = 100
            self.filepath = "/tmp/"

    class FakeScene:
        def __init__(self, name="Scene", objs=None):
            self.name = name
            self.frame_current = 1
            self.frame_start = 1
            self.frame_end = 250
            self.render = FakeRenderSettings()
            default_objs = objs if objs is not None else [
                FakeObj("Cube", "MESH"),
                FakeObj("Camera", "CAMERA"),
                FakeObj("Light", "LIGHT"),
            ]
            self.objects = list(default_objs)
            self.collection = FakeCollection("Scene Collection", objects=self.objects)
            active = self.objects[0] if self.objects else None
            self.view_layers = [types.SimpleNamespace(objects=types.SimpleNamespace(active=active))]
        def frame_set(self, frame):
            self.frame_current = int(frame)

    scene0 = FakeScene("Scene")
    data_ns = types.SimpleNamespace(
        filepath="",
        is_saved=False,
        is_dirty=False,
        scenes=[scene0],
    )
    context_ns = types.SimpleNamespace(
        scene=scene0,
        mode="OBJECT",
        active_object=scene0.objects[0],
    )

    def window_poll_fail(op_path):
        def _fail(*_args, **_kwargs):
            raise RuntimeError("Operator %s.poll() failed, context is incorrect" % op_path)
        return _fail

    class WindowSubMod:
        def __init__(self, prefix):
            self._prefix = prefix
        def __getattr__(self, name):
            return window_poll_fail("bpy.ops.%s.%s" % (self._prefix, name))

    def open_mainfile(filepath="", **_kw):
        if not filepath or not os.path.isfile(filepath):
            raise RuntimeError("Error: Cannot read '%s': No such file or directory" % filepath)
        raw = ""
        try:
            with open(filepath, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except Exception:
            raw = ""
        meta = None
        if raw.strip().startswith("{"):
            try:
                meta = json.loads(raw)
            except Exception:
                meta = None
        objs = None
        if isinstance(meta, dict) and isinstance(meta.get("custom_objects"), list):
            objs = [FakeObj(str(n), "MESH") for n in meta["custom_objects"]]
        new_scene = FakeScene("Scene", objs=objs)
        if isinstance(meta, dict):
            if isinstance(meta.get("engine"), str):
                new_scene.render.engine = meta["engine"]
            if isinstance(meta.get("frameEnd"), int):
                new_scene.frame_end = meta["frameEnd"]
            if not disable_autoexec and isinstance(meta.get("autoexec_marker_path"), str):
                with open(meta["autoexec_marker_path"], "w", encoding="utf-8") as afh:
                    afh.write("autoexec\\n")
        data_ns.filepath = filepath
        data_ns.is_saved = True
        data_ns.is_dirty = bool(isinstance(meta, dict) and meta.get("dirty"))
        data_ns.scenes = [new_scene]
        context_ns.scene = new_scene
        context_ns.active_object = new_scene.objects[0] if new_scene.objects else None
        for cb in list(handlers_ns.load_post):
            cb(filepath)
        return {"FINISHED"}

    def save_as_mainfile(filepath="", **_kw):
        parent = os.path.dirname(filepath)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"saved": True}))
        data_ns.filepath = filepath
        data_ns.is_saved = True
        data_ns.is_dirty = False
        for cb in list(handlers_ns.save_post):
            cb(filepath)
        return {"FINISHED"}

    def render_op(*ctx_args, write_still=False, **_kw):
        for c in ctx_args:
            if isinstance(c, str) and c.startswith("INVOKE"):
                raise RuntimeError("Operator bpy.ops.render.render.poll() failed, context is incorrect")
        sleep_ms = int(os.environ.get("FAKE_BLENDER_RENDER_SLEEP_MS", "0") or "0")
        if sleep_ms > 0:
            time.sleep(sleep_ms / 1000.0)
        scn = context_ns.scene
        if write_still and scn is not None and scn.render.filepath:
            out = scn.render.filepath
            parent = os.path.dirname(out)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(out, "wb") as fh:
                fh.write(("FAKE-HEADLESS-PNG:%d\\n" % scn.frame_current).encode("utf-8"))
        for cb in list(handlers_ns.render_complete):
            cb(scn)
        return {"FINISHED"}

    wm_ns = types.SimpleNamespace(
        open_mainfile=open_mainfile,
        save_as_mainfile=save_as_mainfile,
        window_new=window_poll_fail("bpy.ops.wm.window_new"),
        redraw_timer=window_poll_fail("bpy.ops.wm.redraw_timer"),
    )
    render_ns = types.SimpleNamespace(
        render=render_op,
        opengl=window_poll_fail("bpy.ops.render.opengl"),
        view_show=window_poll_fail("bpy.ops.render.view_show"),
    )
    ops_ns = types.SimpleNamespace(
        wm=wm_ns,
        render=render_ns,
        view3d=WindowSubMod("view3d"),
        screen=WindowSubMod("screen"),
    )

    bpy_mod.app = app_ns
    bpy_mod.data = data_ns
    bpy_mod.context = context_ns
    bpy_mod.ops = ops_ns
    sys.modules["bpy"] = bpy_mod
    sys.modules["bpy.app"] = app_ns
    sys.modules["bpy.app.handlers"] = handlers_ns

install_fake_modules()

if script_path is not None:
    try:
        runpy.run_path(script_path, run_name="__main__")
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        sys.exit(python_exit_code)

if not quiet:
    os.write(1, b"Blender quit\\n")
sys.exit(0)
`

export function createFakeBlenderFixture(
  dir: string,
  opts: { version?: string; name?: string } = {},
): FakeBlenderFixture {
  mkdirSync(dir, { recursive: true })
  const name = opts.name ?? 'fake-blender'
  const bin = path.join(dir, name)
  const logPath = path.join(dir, `${name}.invocations.jsonl`)
  writeFileSync(logPath, '')
  const version = opts.version ?? '5.3.0'
  const source = FAKE_BLENDER_PY
    .replace('__DEFAULT_VERSION__', version)
    .replace('__LOG_PATH__', logPath.split('\\').join('\\\\'))
  writeFileSync(bin, source, { mode: 0o755 })
  chmodSync(bin, 0o755)
  return {
    bin,
    logPath,
    invocations(): FakeBlenderInvocation[] {
      if (!existsSync(logPath)) return []
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l) as FakeBlenderInvocation)
    },
    clearInvocations(): void {
      writeFileSync(logPath, '')
    },
  }
}
