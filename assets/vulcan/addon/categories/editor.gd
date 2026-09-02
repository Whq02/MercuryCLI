@tool
class_name MercuryVulcanEditor
# categories/editor.gd -- the editor_* ops (Mercury VULCAN).
# Static handler module: no instances. ctx API: core/context.gd.
# COORDINATION: editor_errors reads the core/log.gd capture ring
# (MercuryVulcanLog; preloaded here so first-enable compile order never
# depends on global class_name registration).
# COORDINATION: editor_undo/editor_redo call ctx.undo.manager() -- core/undo.gd
# should expose the EditorUndoRedoManager; a graceful error covers its absence.

const VulcanLog := preload("../core/log.gd")

const SHOT_DIR := "res://.godot/mercury-vulcan-shots"
const ALLOW_EXECUTE_SETTING := "mercury_vulcan/allow_execute_script"


static func ops() -> Array:
	return [
		"editor_state", "editor_errors", "editor_screenshot", "editor_select",
		"editor_open_scene", "editor_reload", "editor_undo", "editor_redo",
		"editor_execute_script",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"editor_state":
			return _state(ctx)
		"editor_errors":
			return _errors(args, ctx)
		"editor_screenshot":
			return _screenshot(args, ctx)
		"editor_select":
			return _select(args, ctx)
		"editor_open_scene":
			return _open_scene(args, ctx)
		"editor_reload":
			return _reload(args, ctx)
		"editor_undo":
			return _undo_redo(ctx, true)
		"editor_redo":
			return _undo_redo(ctx, false)
		"editor_execute_script":
			return _execute_script(args, ctx)
	return ctx.err("UNKNOWN_OP", "the editor category does not own '%s'" % op, "see MercuryVulcanEditor.ops() for the editor op list")


static func _state(ctx: MercuryVulcanContext) -> Dictionary:
	var ed = ctx.editor
	var root: Node = ed.get_edited_scene_root()
	var sel := []
	for n in ed.get_selection().get_selected_nodes():
		sel.append(str(root.get_path_to(n)) if root != null else str(n.get_path()))
	var v: Dictionary = Engine.get_version_info()
	return { "ok": true, "result": {
		"godot": "%d.%d.%d" % [v.major, v.minor, v.patch],
		"project": str(ProjectSettings.get_setting("application/config/name", "")),
		"edited_scene": (root.scene_file_path if root != null else ""),
		"edited_root": (str(root.name) if root != null else ""),
		"edited_root_type": (root.get_class() if root != null else ""),
		"open_scenes": Array(ed.get_open_scenes()),
		"selection": sel,
		"playing": ed.is_playing_scene(),
		"playing_scene": ed.get_playing_scene(),
	} }


static func _errors(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var limit := int(args.get("limit", 50))
	if limit <= 0:
		limit = 50
	var rows: Array = VulcanLog.recent(limit)
	return { "ok": true, "result": { "entries": rows, "count": rows.size(), "capture": VulcanLog.mode() } }


static func _screenshot(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var ed = ctx.editor
	var view := str(args.get("view", "editor"))
	var vp: Viewport = null
	match view:
		"editor":
			vp = ed.get_base_control().get_viewport()
		"2d":
			vp = ed.get_editor_viewport_2d()
		"3d":
			vp = ed.get_editor_viewport_3d(0)
		_:
			return ctx.err("BAD_ARG", "view must be editor|2d|3d", "omit view to capture the whole editor window")
	if vp == null:
		return ctx.err("NO_VIEWPORT", "could not resolve the %s viewport" % view, "try view:'editor'")
	var img: Image = vp.get_texture().get_image()
	if img == null or img.is_empty():
		return ctx.err("CAPTURE_FAILED", "the viewport returned no image", "make sure the editor window is visible (not minimized)")
	var out := ""
	if args.has("out") and str(args["out"]) != "":
		out = ctx.paths.require_res(str(args["out"]))
		if out == "":
			return ctx.err("BAD_PATH", "out must be a res://-relative path", "e.g. res://.godot/mercury-vulcan-shots/shot.png")
	else:
		var stamp := Time.get_datetime_string_from_system(false, true).replace(":", "-").replace(" ", "_")
		out = "%s/%s.png" % [SHOT_DIR, stamp]
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(out.get_base_dir()))
	var werr := img.save_png(ProjectSettings.globalize_path(out))
	if werr != OK:
		return ctx.err("SAVE_FAILED", "could not save the screenshot (error %d)" % werr, "check that the target directory is writable")
	return { "ok": true, "result": { "path": out, "width": img.get_width(), "height": img.get_height() } }


static func _select(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if str(args.get("node", "")) == "":
		return ctx.err("BAD_ARG", "node is required", "pass a NodePath relative to the edited scene root")
	var found := _node(args.get("node", ""), ctx)
	if found.has("err"):
		return found["err"]
	var node: Node = found["node"]
	var ed = ctx.editor
	var sel = ed.get_selection()
	var prev: Array = sel.get_selected_nodes().duplicate()
	var do_select := func():
		sel.clear()
		sel.add_node(node)
		ed.edit_node(node)
	var undo_select := func():
		sel.clear()
		for p in prev:
			if is_instance_valid(p):
				sel.add_node(p)
	ctx.undo.action("vulcan: editor_select", do_select, undo_select)
	return { "ok": true, "result": { "selected": str(args.get("node")), "type": node.get_class() } }


static func _open_scene(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var raw := str(args.get("path", ""))
	if raw == "":
		return ctx.err("BAD_ARG", "path is required", "pass a res:// scene, script, or resource path")
	var path: String = ctx.paths.require_res(raw)
	if path == "":
		return ctx.err("BAD_PATH", "path must be res://-relative", "e.g. res://scenes/main.tscn")
	if not FileAccess.file_exists(path):
		return ctx.err("NOT_FOUND", "no file at %s" % path, "project_file_search finds project files by pattern")
	var ed = ctx.editor
	var prev_root: Node = ed.get_edited_scene_root()
	var prev_scene: String = prev_root.scene_file_path if prev_root != null else ""
	if path.ends_with(".tscn") or path.ends_with(".scn"):
		var do_open := func():
			ed.open_scene_from_path(path)
		var undo_open := func():
			if prev_scene != "" and prev_scene != path:
				ed.open_scene_from_path(prev_scene)
		ctx.undo.action("vulcan: editor_open_scene", do_open, undo_open)
		return { "ok": true, "result": { "opened": path, "kind": "scene" } }
	var res = load(path)
	if res == null:
		return ctx.err("LOAD_FAILED", "could not load %s" % path, "is the file imported? try editor_reload with what:'filesystem'")
	var do_edit := func():
		ed.edit_resource(res)
		ed.select_file(path)
	ctx.undo.action("vulcan: editor_open_scene", do_edit, func(): pass)
	return { "ok": true, "result": { "opened": path, "kind": res.get_class() } }


static func _reload(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var what := str(args.get("what", "filesystem"))
	var ed = ctx.editor
	match what:
		"filesystem":
			ctx.undo.action("vulcan: editor_reload", func(): ed.get_resource_filesystem().scan(), func(): pass)
			return { "ok": true, "result": { "reloaded": "filesystem", "note": "rescan started (asynchronous)" } }
		"scripts":
			ctx.undo.action("vulcan: editor_reload", func(): ed.get_resource_filesystem().scan_sources(), func(): pass)
			return { "ok": true, "result": { "reloaded": "scripts", "note": "source rescan started; the editor hot-reloads changed scripts" } }
		"scene":
			var root: Node = ed.get_edited_scene_root()
			if root == null or root.scene_file_path == "":
				return ctx.err("NO_SCENE", "no saved scene is being edited", "open a scene first, or save it once (scene_save)")
			var p := root.scene_file_path
			ctx.undo.action("vulcan: editor_reload", func(): ed.reload_scene_from_path(p), func(): pass)
			return { "ok": true, "result": { "reloaded": "scene", "path": p, "note": "unsaved changes in that scene are discarded by the reload" } }
	return ctx.err("BAD_ARG", "what must be scripts|scene|filesystem", "e.g. {\"what\": \"filesystem\"}")


# Deliberately NOT wrapped in ctx.undo.action: these two ARE the undo machinery;
# wrapping them would corrupt the history they drive.
static func _undo_redo(ctx: MercuryVulcanContext, is_undo: bool) -> Dictionary:
	var mgr = ctx.undo.manager() if ctx.undo.has_method("manager") else null
	if mgr == null:
		return ctx.err("UNDO_UNAVAILABLE", "the undo helper does not expose the EditorUndoRedoManager", "core/undo.gd must provide manager(); use the editor's own Ctrl+Z meanwhile")
	var root: Node = ctx.editor.get_edited_scene_root()
	var hid: int = mgr.get_object_history_id(root) if root != null else 0
	var ur: UndoRedo = mgr.get_history_undo_redo(hid)
	if ur == null:
		return ctx.err("UNDO_UNAVAILABLE", "no undo history for the edited scene", "make an edit first")
	var acted := false
	var action_name := ""
	if is_undo:
		if ur.has_undo():
			action_name = ur.get_current_action_name()
			acted = ur.undo()
	else:
		if ur.has_redo():
			acted = ur.redo()
			action_name = ur.get_current_action_name()
	if not acted:
		var code := "NOTHING_TO_UNDO" if is_undo else "NOTHING_TO_REDO"
		return ctx.err(code, "the history is empty in that direction", "editor_state shows the edited scene; make (or undo) an edit first")
	return { "ok": true, "result": { ("undone" if is_undo else "redone"): action_name } }


# The ONLY sanctioned code-execution op in this category. It never shells out
# (no OS.execute anywhere in this addon outside this file, and none here either):
# the code runs as a temp in-memory @tool GDScript resource.
static func _execute_script(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if not bool(ProjectSettings.get_setting(ALLOW_EXECUTE_SETTING, true)):
		return ctx.err("EXEC_DISABLED", "editor_execute_script is disabled in this project",
			"the project setting %s is false (the defense-in-depth off-switch); flip it in Project Settings to re-enable" % ALLOW_EXECUTE_SETTING)
	var code := str(args.get("code", ""))
	if code.strip_edges() == "":
		return ctx.err("BAD_ARG", "code is required and must define func run()", "e.g. func run():\n\treturn 40 + 2")
	if code.find("func run(") == -1:
		return ctx.err("NO_RUN_FUNC", "the code must define func run()", "wrap your logic in: func run():\n\t...")
	var has_extends := false
	for line in code.split("\n"):
		var t: String = line.strip_edges()
		if t.begins_with("extends "):
			has_extends = true
		if t.begins_with("class_name "):
			return ctx.err("BAD_SCRIPT", "class_name is not allowed in a one-shot script", "drop the class_name line")
	var src := ("@tool\n" + code) if has_extends else ("@tool\nextends RefCounted\n" + code)
	if code.find("_vulcan_out") == -1:
		src += "\n\nvar _vulcan_out: Array = []\n\nfunc vout(v) -> void:\n\t_vulcan_out.append(str(v))\n"
	var script := GDScript.new()
	script.source_code = src
	var perr := script.reload()
	if perr != OK:
		return ctx.err("SCRIPT_PARSE", "the script failed to parse (error %d)" % perr, "check editor_errors for the parse message; the code is wrapped as '@tool extends RefCounted' unless it has its own extends")
	var inst = script.new()
	if inst == null:
		return ctx.err("SCRIPT_INSTANCE", "could not instantiate the script", "if you used your own extends, the base must be instantiable (RefCounted or Node)")
	if not inst.has_method("run"):
		return ctx.err("NO_RUN_FUNC", "the parsed script has no run() method", "define func run() at the top level")
	var timeout_ms := int(args.get("timeout_ms", 15000))
	var t0 := Time.get_ticks_msec()
	var ret = inst.run()
	var took := Time.get_ticks_msec() - t0
	var out := []
	if "_vulcan_out" in inst:
		out = inst.get("_vulcan_out")
	if inst is Node:
		(inst as Node).queue_free()
	var result := {
		"returned": _jsonable(ret),
		"took_ms": took,
		"output": out,
	}
	if took > timeout_ms:
		result["timed_out"] = true
		result["note"] = "run() executes synchronously on the editor main thread; the timeout is measured after the fact, not preemptive"
	return { "ok": true, "result": result }


# -- small local helpers (duplication over a core/ dependency, per the contract) --

static func _node(path_v, ctx: MercuryVulcanContext) -> Dictionary:
	var path := str(path_v)
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return { "err": ctx.err("NO_SCENE", "no scene is being edited", "open or create a scene first (scene_open / scene_create)") }
	if path == "" or path == "." or path == str(root.name):
		return { "node": root }
	var n: Node = root.get_node_or_null(NodePath(path))
	if n == null:
		var near := []
		for c in root.get_children():
			near.append(str(c.name))
		var hint := "paths are relative to the scene root '%s'; top-level children: %s" % [root.name, (", ".join(PackedStringArray(near)) if near.size() > 0 else "(none)")]
		return { "err": ctx.err("NODE_NOT_FOUND", "no node at '%s' in the edited scene" % path, hint) }
	return { "node": n }


static func _jsonable(v):
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return v
		TYPE_ARRAY:
			var a := []
			for e in v:
				a.append(_jsonable(e))
			return a
		TYPE_DICTIONARY:
			var d := {}
			for k in v:
				d[str(k)] = _jsonable(v[k])
			return d
		TYPE_OBJECT:
			return str(v)
		_:
			return var_to_str(v)
