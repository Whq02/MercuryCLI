@tool
class_name MercuryVulcanTesting
# mercury_vulcan — Testing/QA category handlers (static module, no instances).
#
# Test convention (documented): res://tests/**/*_test.gd, methods named test_*.
# test_run executes IN-EDITOR (no sub-process): each script is instantiated and its
# test_* methods called. GDScript has NO exceptions — "try/catch semantics" here means:
# a test PASSES when it returns null/true, FAILS when it returns false or a String
# (the failure message). A hard script error aborts the whole run (engine limitation;
# the report will be missing — rerun after fixing the script). GUT/gdUnit4 suites are
# DETECTED and reported by test_list but not executed (their own runners do that).
# Reports persist under .godot/mercury-vulcan-tests/ (last.json + <run_id>.json).
# Screenshot baselines live under .godot/mercury-vulcan-baselines/<name>.png; compare
# = per-pixel mean abs RGB diff via the Image API vs a 0..1 tolerance.


const _TESTS_DIR := "res://tests"
const _REPORT_DIR := "res://.godot/mercury-vulcan-tests"
const _BASELINE_DIR := "res://.godot/mercury-vulcan-baselines"


static func ops() -> Array:
	return [
		"test_list", "test_report", "test_run",
		"test_assert", "test_screenshot_baseline", "test_screenshot_compare",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"test_list":
			return _list(args, ctx)
		"test_report":
			return _report(args, ctx)
		"test_run":
			return _run(args, ctx)
		"test_assert":
			return await _assert(args, ctx)
		"test_screenshot_baseline":
			return await _baseline(args, ctx)
		"test_screenshot_compare":
			return await _compare(args, ctx)
	return ctx.err("UNKNOWN_OP", "testing does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _list(_args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var scripts: Array = []
	for path in _test_files(_TESTS_DIR):
		var entry := { "path": path, "tests": [] }
		var script = load(path)
		if script is GDScript:
			for m in script.get_script_method_list():
				var name := String(m.get("name", ""))
				if name.begins_with("test_"):
					entry.tests.append(name)
		scripts.append(entry)
	var frameworks: Array = []
	if DirAccess.dir_exists_absolute(ProjectSettings.globalize_path("res://addons/gut")):
		frameworks.append("GUT (res://addons/gut — run with its own runner)")
	if DirAccess.dir_exists_absolute(ProjectSettings.globalize_path("res://addons/gdUnit4")):
		frameworks.append("gdUnit4 (res://addons/gdUnit4 — run with its own runner)")
	return { "ok": true, "result": {
		"convention": "res://tests/**/*_test.gd with func test_*() methods",
		"scripts": scripts,
		"detected_frameworks": frameworks,
	} }


static func _report(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var which := String(args.get("run", "last"))
	if not which.is_valid_identifier() and not which.is_valid_int():
		which = "last"
	var path := "%s/%s.json" % [_REPORT_DIR, which]
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ctx.err("NOT_FOUND", "no test report at %s" % path, "run tests first with test_run")
	var parsed = JSON.parse_string(f.get_as_text())
	if parsed == null:
		return ctx.err("LOAD_FAILED", "report file is not valid JSON", "rerun test_run to regenerate it")
	return { "ok": true, "result": parsed }


static func _run(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var scope := _TESTS_DIR
	if args.has("path"):
		scope = ctx.paths.require_res(String(args.get("path", "")))
		if scope == "":
			return ctx.err("BAD_PATH", "path must be res://-relative", "a test script or directory under res://tests")
	var filter := String(args.get("filter", ""))
	var files: Array = []
	if scope.ends_with(".gd"):
		if not FileAccess.file_exists(scope):
			return ctx.err("NOT_FOUND", "no test script at %s" % scope, "see test_list")
		files.append(scope)
	else:
		files = _test_files(scope)
	if files.is_empty():
		return ctx.err("NOT_FOUND", "no *_test.gd files under %s" % scope, "convention: res://tests/**/*_test.gd with func test_*() methods")
	var run_id := "run_%d" % int(Time.get_unix_time_from_system())
	var results: Array = []
	var passed := 0
	var failed := 0
	for path in files:
		var script = load(path)
		if not (script is GDScript):
			results.append({ "script": path, "test": "(load)", "pass": false, "message": "could not load script" })
			failed += 1
			continue
		var inst = script.new()
		if inst == null:
			results.append({ "script": path, "test": "(new)", "pass": false, "message": "could not instantiate — test scripts should extend RefCounted or Node" })
			failed += 1
			continue
		for m in script.get_script_method_list():
			var mname := String(m.get("name", ""))
			if not mname.begins_with("test_"):
				continue
			if filter != "" and not mname.contains(filter):
				continue
			var t0 := Time.get_ticks_usec()
			var ret = inst.call(mname)
			var ms := (Time.get_ticks_usec() - t0) / 1000.0
			var ok: bool = true
			var message := ""
			if typeof(ret) == TYPE_BOOL and ret == false:
				ok = false
				message = "returned false"
			elif typeof(ret) == TYPE_STRING and String(ret) != "":
				ok = false
				message = String(ret)
			results.append({ "script": path, "test": mname, "pass": ok, "message": message, "ms": ms })
			if ok:
				passed += 1
			else:
				failed += 1
		if inst is Node:
			inst.free()
	var report := {
		"run": run_id,
		"at": Time.get_datetime_string_from_system(),
		"scope": scope,
		"filter": filter,
		"passed": passed,
		"failed": failed,
		"total": passed + failed,
		"results": results,
		"semantics": "pass = returned null/true; fail = returned false or a String message; hard script errors abort the run (GDScript has no exceptions)",
	}
	_write_report(report, run_id)
	return { "ok": true, "result": report }


static func _assert(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if ctx.runtime == null:
		return ctx.err("NO_RUNTIME", "test_assert evaluates in the RUNNING game and no play session is live", "start a play session with scene_play first")
	var expression := String(args.get("expression", ""))
	if expression == "":
		return ctx.err("BAD_ARGS", "expression is required", "a GDScript expression expected to be true, e.g. \"get_node('/root/Main/Player').health > 0\"")
	var fwd: Dictionary = await ctx.runtime.request("runtime_eval", { "expression": expression })
	if not bool(fwd.get("ok", false)):
		return fwd
	var value = fwd.get("result")
	if value is Dictionary and value.has("value"):
		value = value.get("value")
	var ok := bool(value)
	return { "ok": true, "result": {
		"pass": ok,
		"expression": expression,
		"value": value,
		"message": String(args.get("message", "")) if not ok else "",
	} }


static func _baseline(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var name := String(args.get("name", ""))
	if not name.is_valid_identifier():
		return ctx.err("BAD_ARGS", "name must be a simple identifier", "e.g. {\"name\": \"main_menu\"}")
	var img = await _capture(args, ctx)
	if img is Dictionary:
		return img
	_ensure_dir(_BASELINE_DIR)
	var path := "%s/%s.png" % [_BASELINE_DIR, name]
	var err: int = img.save_png(ProjectSettings.globalize_path(path))
	if err != OK:
		return ctx.err("SAVE_FAILED", "could not write %s (error %d)" % [path, err], "is .godot/ writable?")
	return { "ok": true, "result": { "baseline": name, "path": path, "size": [img.get_width(), img.get_height()], "source": "runtime" if ctx.runtime != null else "editor viewport" } }


static func _compare(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var name := String(args.get("name", ""))
	if not name.is_valid_identifier():
		return ctx.err("BAD_ARGS", "name must be a simple identifier", "e.g. {\"name\": \"main_menu\", \"tolerance\": 0.03}")
	var path := "%s/%s.png" % [_BASELINE_DIR, name]
	var base := Image.new()
	if base.load(ProjectSettings.globalize_path(path)) != OK:
		return ctx.err("NOT_FOUND", "no baseline named '%s'" % name, "capture one first with test_screenshot_baseline")
	var img = await _capture(args, ctx)
	if img is Dictionary:
		return img
	var resized := false
	if img.get_width() != base.get_width() or img.get_height() != base.get_height():
		img.resize(base.get_width(), base.get_height(), Image.INTERPOLATE_BILINEAR)
		resized = true
	base.convert(Image.FORMAT_RGB8)
	img.convert(Image.FORMAT_RGB8)
	var total := 0.0
	var w := base.get_width()
	var h := base.get_height()
	for y in h:
		for x in w:
			var a := base.get_pixel(x, y)
			var b: Color = img.get_pixel(x, y)
			total += absf(a.r - b.r) + absf(a.g - b.g) + absf(a.b - b.b)
	var mean := total / float(w * h * 3)
	var tolerance := clampf(float(args.get("tolerance", 0.02)), 0.0, 1.0)
	return { "ok": true, "result": {
		"baseline": name,
		"mean_abs_diff": mean,
		"tolerance": tolerance,
		"pass": mean <= tolerance,
		"size": [w, h],
		"capture_resized_to_baseline": resized,
		"source": "runtime" if ctx.runtime != null else "editor viewport",
	} }


# --- capture: runtime bridge when playing, else the editor viewport ---
# Returns an Image, or an error Dictionary (callers duck-type on Dictionary).

static func _capture(args: Dictionary, ctx: MercuryVulcanContext):
	if ctx.runtime != null:
		var shot_path := "%s/_capture_tmp.png" % _BASELINE_DIR
		_ensure_dir(_BASELINE_DIR)
		var fwd: Dictionary = await ctx.runtime.request("runtime_screenshot", { "out": shot_path })
		if not bool(fwd.get("ok", false)):
			return fwd
		var img := Image.new()
		if img.load(ProjectSettings.globalize_path(shot_path)) != OK:
			return ctx.err("LOAD_FAILED", "runtime screenshot did not land at %s" % shot_path, "retry; if it persists, screenshot via runtime_screenshot and inspect")
		DirAccess.remove_absolute(ProjectSettings.globalize_path(shot_path))
		return img
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return ctx.err("NO_SCENE", "no scene is being edited and no play session is live", "open a scene, or scene_play first")
	var vp: Viewport = null
	if root is Node2D or root is Control:
		vp = ctx.editor.get_editor_viewport_2d()
	else:
		vp = ctx.editor.get_editor_viewport_3d(0)
	if vp == null:
		return ctx.err("EDITOR_LIMIT", "no editor viewport available", "capture during a play session instead (scene_play first)")
	var tex := vp.get_texture()
	if tex == null:
		return ctx.err("EDITOR_LIMIT", "editor viewport has no texture yet", "focus the 2D/3D main screen and retry")
	var img2 := tex.get_image()
	if args.has("target"):
		# 'target' names a node whose on-screen rect to crop to (best-effort, 2D only).
		var r := _resolve(String(args.get("target", "")), ctx)
		if r.has("err"):
			return r.err
		var n: Node = r.node
		if n is Control:
			var ctrl := n as Control
			var rect: Rect2 = ctrl.get_global_rect()
			var clipped := rect.intersection(Rect2(Vector2.ZERO, Vector2(img2.get_width(), img2.get_height())))
			if clipped.size.x >= 1 and clipped.size.y >= 1:
				img2 = img2.get_region(Rect2i(clipped))
	return img2


# --- local helpers ---

static func _test_files(scope: String) -> Array:
	var out: Array = []
	if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(scope)):
		return out
	var dirs: Array = [scope]
	while not dirs.is_empty():
		var dir_path: String = dirs.pop_back()
		var d := DirAccess.open(dir_path)
		if d == null:
			continue
		d.list_dir_begin()
		var entry := d.get_next()
		while entry != "":
			var full := dir_path.path_join(entry)
			if d.current_is_dir():
				if not entry.begins_with("."):
					dirs.append(full)
			elif entry.ends_with("_test.gd"):
				out.append(full)
			entry = d.get_next()
		d.list_dir_end()
	out.sort()
	return out


static func _ensure_dir(res_path: String) -> void:
	var g := ProjectSettings.globalize_path(res_path)
	if not DirAccess.dir_exists_absolute(g):
		DirAccess.make_dir_recursive_absolute(g)


static func _write_report(report: Dictionary, run_id: String) -> void:
	_ensure_dir(_REPORT_DIR)
	var text := JSON.stringify(report, "\t")
	for target in ["last", run_id]:
		var f := FileAccess.open("%s/%s.json" % [_REPORT_DIR, target], FileAccess.WRITE)
		if f != null:
			f.store_string(text)
			f.close()


static func _resolve(raw: String, ctx: MercuryVulcanContext) -> Dictionary:
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return { "err": ctx.err("NO_SCENE", "no scene is being edited", "open or create a scene first (scene_open / scene_create)") }
	var rel := raw.strip_edges().trim_prefix("/root/").trim_prefix("/").trim_prefix("./")
	if rel == "" or rel == "." or rel == root.name:
		return { "node": root }
	var cur: Node = root
	for part in rel.split("/"):
		var nxt: Node = cur.get_node_or_null(NodePath(String(part)))
		if nxt == null:
			var names: Array = []
			for c in cur.get_children():
				names.append(String(c.name))
			var where := "the scene root '%s'" % root.name if cur == root else "'%s'" % String(root.get_path_to(cur))
			var near := ", ".join(names) if names.size() > 0 else "(no children)"
			return { "err": ctx.err("NODE_NOT_FOUND", "no node '%s' under %s" % [part, where], "children there: %s" % near) }
		cur = nxt
	return { "node": cur }
