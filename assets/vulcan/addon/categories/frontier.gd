@tool
class_name MercuryVulcanFrontier
# mercury_vulcan — Frontier category handlers (static module, no instances).
# REGISTRY NOTE (W-A): registry.gd MUST include this file in its category map.
# ops() deliberately EXCLUDES vulcan_status / vulcan_install / vulcan_uninstall —
# those are Mercury-side (never reach the wire; the addon coverage proof exempts them).
# runtime_wait_signal DELEGATES to ctx.runtime so the registry stays one-map.
# batch_transaction rides two ctx seams from core/context.gd:
#   · ctx.dispatch(op, args) — AWAITABLE; re-enters the registry for sub-ops
#   · ctx.op_class(op) -> String ("read"|"mutate"|"exec"|"") — optable class
#     lookup (core/op_classes.gd, generated from optable.json)
# It groups sub-ops with ctx.undo.begin/commit so N mutations land as ONE undo step;
# without ctx.dispatch it refuses with a teaching error instead of guessing.


static func ops() -> Array:
	return ["editor_doctor", "project_capsule", "scene_diff", "batch_transaction", "broken_refs", "import_get", "import_set", "refactor_rename_signal", "refactor_rename_export", "runtime_frames", "playtest_run", "runtime_wait_signal"]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"editor_doctor":
			return _editor_doctor(args, ctx)
		"project_capsule":
			return _project_capsule(args, ctx)
		"broken_refs":
			return _broken_refs(args, ctx)
		"import_get":
			return _import_get(args, ctx)
		"import_set":
			return _import_set(args, ctx)
		"refactor_rename_signal":
			return MercuryVulcanRefactorImpl.rename_signal(args, ctx)
		"refactor_rename_export":
			return MercuryVulcanRefactorImpl.rename_export(args, ctx)
		"runtime_frames":
			return await _runtime_frames(args, ctx)
		"playtest_run":
			return await _playtest_run(args, ctx)
		"scene_diff":
			return _scene_diff(args, ctx)
		"batch_transaction":
			return await _batch_transaction(args, ctx)
		"runtime_wait_signal":
			return await _runtime_wait_signal(args, ctx)
	return ctx.err("UNKNOWN_OP", "frontier does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _editor_doctor(_args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var info := Engine.get_version_info()
	var root: Node = ctx.editor.get_edited_scene_root()
	var open_scenes: Array = []
	for p in ctx.editor.get_open_scenes():
		open_scenes.append(String(p))
	var plugins: Array = []
	if ProjectSettings.has_setting("editor_plugins/enabled"):
		for p in ProjectSettings.get_setting("editor_plugins/enabled"):
			plugins.append(String(p))
	# Dirty-state proxy: the editor does not expose per-scene dirty flags to scripts;
	# report unsaved-marker via the scene's undo history having steps (approximate,
	# labeled). EditorUndoRedoManager itself has no has_undo — reach the per-history
	# UndoRedo object, guarded so an API drift degrades to "unknown" instead of erroring.
	var has_undo := false
	if root != null and ctx.editor.has_method("get_editor_undo_redo"):
		var undo_mgr = ctx.editor.get_editor_undo_redo()
		if undo_mgr != null and undo_mgr.has_method("get_object_history_id") and undo_mgr.has_method("get_history_undo_redo"):
			var hid: int = undo_mgr.get_object_history_id(root)
			var ur = undo_mgr.get_history_undo_redo(hid)
			if ur != null and ur.has_method("has_undo"):
				has_undo = ur.has_undo()
	var lsp_port = null
	var editor_settings = ctx.editor.get_editor_settings()
	if editor_settings != null and editor_settings.has_setting("network/language_server/remote_port"):
		lsp_port = editor_settings.get_setting("network/language_server/remote_port")
	return { "ok": true, "result": {
		"godot": "%d.%d.%d %s" % [info.major, info.minor, info.patch, String(info.get("status", ""))],
		"project": String(ProjectSettings.get_setting("application/config/name", "")),
		"edited_scene": root.scene_file_path if root != null else null,
		"edited_scene_root_type": root.get_class() if root != null else null,
		"open_scenes": open_scenes,
		"enabled_plugins": plugins,
		"undo_steps_present": has_undo,
		"dirty_note": "undo_steps_present is a PROXY for unsaved changes (the editor exposes no per-scene dirty flag to scripts)",
		"playing": ctx.runtime != null,
		"lsp_port": lsp_port,
	} }


# The one-call project picture: what an agent needs before its first edit.
# Every slice is budget-bounded; totals are always exact. Built-in ui_* input
# actions are omitted (input_map_list shows the full map with bindings).
static func _project_capsule(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var budget := clampi(int(args.get("budget", 40)), 5, 200)
	var info := Engine.get_version_info()
	var main_scene := String(ProjectSettings.get_setting("application/run/main_scene", ""))
	var features_v: Variant = ProjectSettings.get_setting("application/config/features", PackedStringArray())
	var autoloads := {}
	var input_actions: Array = []
	for p in ProjectSettings.get_property_list():
		var pname := String(p.get("name", ""))
		if pname.begins_with("autoload/"):
			var apath := String(ProjectSettings.get_setting(pname, ""))
			autoloads[pname.trim_prefix("autoload/")] = apath.trim_prefix("*")
		elif pname.begins_with("input/") and not pname.begins_with("input/ui_"):
			input_actions.append(pname.trim_prefix("input/"))
	input_actions.sort()
	var classes: Array = []
	var class_list: Array = ProjectSettings.get_global_class_list()
	for c in class_list:
		if classes.size() >= budget:
			break
		classes.append({
			"class": String(c.get("class", "")),
			"base": String(c.get("base", "")),
			"path": String(c.get("path", "")),
		})
	var census := {"scenes": 0, "scripts": 0, "scene_paths": []}
	var fs: EditorFileSystem = ctx.editor.get_resource_filesystem()
	if fs != null:
		_census_walk(fs.get_filesystem(), census, budget)
	var open_scenes: Array = []
	for s in ctx.editor.get_open_scenes():
		open_scenes.append(String(s))
	var edited := ""
	var root: Node = ctx.editor.get_edited_scene_root()
	if root != null:
		edited = root.scene_file_path
	var plugins: Array = []
	if ProjectSettings.has_setting("editor_plugins/enabled"):
		for p in ProjectSettings.get_setting("editor_plugins/enabled"):
			plugins.append(String(p))
	var presets: Array = []
	var pf := ConfigFile.new()
	if pf.load("res://export_presets.cfg") == OK:
		for section in pf.get_sections():
			if section.begins_with("preset.") and not section.contains("options"):
				presets.append({
					"name": String(pf.get_value(section, "name", "")),
					"platform": String(pf.get_value(section, "platform", "")),
				})
	return ctx.ok({
		"source": "editor",
		"engine": String(info.get("string", "")),
		"project": String(ProjectSettings.get_setting("application/config/name", "")),
		"main_scene": main_scene if not main_scene.is_empty() else "(none)",
		"features": Array(features_v),
		"autoloads": autoloads,
		"input_actions": input_actions.slice(0, budget),
		"input_action_count": input_actions.size(),
		"global_classes": classes,
		"global_class_count": class_list.size(),
		"scene_count": census["scenes"],
		"script_count": census["scripts"],
		"scene_paths": census["scene_paths"],
		"open_scenes": open_scenes,
		"edited_scene": edited if not edited.is_empty() else "(none)",
		"plugins": plugins,
		"export_presets": presets,
	})


static func _census_walk(dir: EditorFileSystemDirectory, census: Dictionary, budget: int) -> void:
	if dir == null:
		return
	for i in dir.get_file_count():
		var ftype := dir.get_file_type(i)
		if ftype == "PackedScene":
			census["scenes"] = int(census["scenes"]) + 1
			if (census["scene_paths"] as Array).size() < budget:
				(census["scene_paths"] as Array).append(dir.get_file_path(i))
		elif ftype == "GDScript":
			census["scripts"] = int(census["scripts"]) + 1
	for i in dir.get_subdir_count():
		_census_walk(dir.get_subdir(i), census, budget)


static func _scene_diff(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative .tscn", "e.g. res://scenes/level_1.tscn")
	var live: Node = ctx.editor.get_edited_scene_root()
	if live == null or live.scene_file_path != path:
		var edited := live.scene_file_path if live != null else "(none)"
		return ctx.err("EDITOR_LIMIT", "%s is not the currently edited scene (edited: %s)" % [path, edited], "scene_diff compares DISK vs the EDITED tab — editor_open_scene it first, or diff files with your VCS")
	if not FileAccess.file_exists(path):
		return { "ok": true, "result": { "path": path, "on_disk": false, "note": "scene has never been saved — everything is unsaved editor state", "diff": [] } }
	var ps = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if ps == null or not (ps is PackedScene):
		return ctx.err("LOAD_FAILED", "could not load %s fresh from disk" % path, "check editor_errors")
	var disk: Node = ps.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
	var diff: Array = []
	_diff_trees(disk, live, disk, live, diff)
	disk.free()
	return { "ok": true, "result": {
		"path": path,
		"identical": diff.is_empty(),
		"diff_count": diff.size(),
		"diff": diff.slice(0, 200),
		"truncated": diff.size() > 200,
		"legend": "side 'editor' = unsaved editor state; side 'disk' = the saved file",
	} }


static func _batch_transaction(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var sub_ops = args.get("ops")
	if not (sub_ops is Array) or sub_ops.is_empty():
		return ctx.err("BAD_ARGS", "ops array is required", "e.g. {\"ops\": [{\"op\": \"node_add\", \"args\": {…}}, {\"op\": \"node_set_property\", \"args\": {…}}]}")
	if not ctx.has_method("dispatch"):
		return ctx.err("EDITOR_LIMIT", "this addon build has no ctx.dispatch seam — batch_transaction cannot re-enter the registry", "run the ops individually; they will be separate undo steps")
	# Validate the plan BEFORE touching anything: mutate-class ops only.
	var plan: Array = []
	for entry in sub_ops:
		if not (entry is Dictionary) or String(entry.get("op", "")) == "":
			return ctx.err("BAD_ARGS", "each entry needs {op, args}", "e.g. {\"op\": \"node_set_property\", \"args\": {…}}")
		var sub := String(entry.get("op"))
		if sub == "batch_transaction":
			return ctx.err("BAD_ARGS", "batch_transaction cannot nest itself", "flatten the ops into one transaction")
		if ctx.has_method("op_class"):
			var cls := String(ctx.op_class(sub))
			if cls == "":
				return ctx.err("UNKNOWN_OP", "unknown op '%s' in transaction" % sub, "only optable mutate ops can join a transaction")
			if cls != "mutate":
				return ctx.err("BAD_ARGS", "'%s' is %s-class — transactions take MUTATE ops only" % [sub, cls], "run read/exec ops on their own, outside the transaction")
		var sub_args = entry.get("args", {})
		if not (sub_args is Dictionary):
			return ctx.err("BAD_ARGS", "args for '%s' must be a dict" % sub, "e.g. {\"op\": \"%s\", \"args\": {}}" % sub)
		plan.append([sub, sub_args])
	ctx.undo.begin("vulcan: batch_transaction")
	var results: Array = []
	var failed_at := -1
	for i in plan.size():
		var res: Dictionary = await ctx.dispatch(plan[i][0], plan[i][1])
		results.append({ "op": plan[i][0], "ok": bool(res.get("ok", false)), "detail": res.get("result", res.get("error")) })
		if not bool(res.get("ok", false)):
			failed_at = i
			break
	# Commit even on failure: the already-applied sub-ops stay ONE undo step so a
	# single Ctrl+Z (or editor_undo) cleanly reverts the partial transaction.
	ctx.undo.commit()
	if failed_at >= 0:
		return ctx.err("TRANSACTION_FAILED", "op %d/%d ('%s') failed — earlier ops in this transaction ARE applied as one undo step" % [failed_at + 1, plan.size(), plan[failed_at][0]], "editor_undo reverts the partial transaction in one step; details: %s" % JSON.stringify(results))
	return { "ok": true, "result": { "applied": plan.size(), "one_undo_step": true, "ops": results } }


# Reference triage across the whole project. A dependency that resolves by
# uid is healthy regardless of where its fallback path points (the engine
# loads by uid); a dep whose uid is unknown but whose path still exists is
# STALE (survives today, breaks on the next move); unknown uid + missing path
# is broken. Script res:// literals are checked by existence — paths built at
# runtime are invisible to this scan and stay unreported.
static func _broken_refs(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var budget := clampi(int(args.get("budget", 40)), 5, 200)
	var fs: EditorFileSystem = ctx.editor.get_resource_filesystem()
	if fs == null:
		return ctx.err("NO_FILESYSTEM", "the editor filesystem is not available", "is the editor still scanning? retry in a moment")
	var resource_files: Array = []
	var script_files: Array = []
	_collect_files(fs.get_filesystem(), resource_files, script_files)
	var findings: Array = []
	var total := 0
	for p in resource_files:
		for d in ResourceLoader.get_dependencies(p):
			var dep := String(d)
			var uid_part := ""
			var path_part := dep
			if dep.contains("::"):
				uid_part = dep.get_slice("::", 0)
				path_part = dep.get_slice("::", 1)
			elif dep.begins_with("uid://"):
				uid_part = dep
				path_part = ""
			if uid_part.begins_with("uid://"):
				var known := ResourceUID.has_id(ResourceUID.text_to_id(uid_part))
				if known:
					continue
				var fallback_exists := path_part != "" and ResourceLoader.exists(path_part)
				total += 1
				if findings.size() < budget:
					findings.append({
						"file": p,
						"ref": dep,
						"kind": "stale_uid" if fallback_exists else "broken",
						"note": "uid unknown; resolves by fallback path TODAY — re-save the referencing file to refresh the uid" if fallback_exists else "uid unknown and the fallback path is gone",
					})
			elif not ResourceLoader.exists(path_part):
				total += 1
				if findings.size() < budget:
					findings.append({ "file": p, "ref": dep, "kind": "broken", "note": "no resource at this path" })
	var include_addons := bool(args.get("include_addons", false))
	for sp in script_files:
		if not include_addons and sp.begins_with("res://addons/"):
			continue
		var src := FileAccess.get_file_as_string(sp)
		var line_no := 0
		for line in src.split("\n"):
			line_no += 1
			for m in _RES_LITERAL.search_all(line):
				var lit := m.get_string(1)
				# Extension-less literals (directories, editor-private files the
				# code creates at runtime) are uncheckable — skipped, not guessed.
				if lit.ends_with("/") or lit == "res://" or lit.get_extension().is_empty():
					continue
				if ResourceLoader.exists(lit) or FileAccess.file_exists(lit):
					continue
				total += 1
				if findings.size() < budget:
					findings.append({ "file": "%s:%d" % [sp, line_no], "ref": lit, "kind": "script_literal_missing", "note": "literal res:// path with no file behind it" })
	return ctx.ok({
		"scanned": { "resources": resource_files.size(), "scripts": script_files.size() },
		"finding_count": total,
		"findings": findings,
		"truncated": total > findings.size(),
		"note": "vendored res://addons scripts are scanned only with include_addons:true; extension-less literals are uncheckable and skipped; paths built at runtime are invisible to this scan",
	})


static var _RES_LITERAL := RegEx.create_from_string("\"(res://[^\"]*)\"")


static func _collect_files(dir: EditorFileSystemDirectory, resources: Array, scripts: Array) -> void:
	if dir == null:
		return
	for i in dir.get_file_count():
		var p := dir.get_file_path(i)
		if p.ends_with(".tscn") or p.ends_with(".scn") or p.ends_with(".tres") or p.ends_with(".res"):
			resources.append(p)
		elif p.ends_with(".gd"):
			scripts.append(p)
	for i in dir.get_subdir_count():
		_collect_files(dir.get_subdir(i), resources, scripts)


static func _import_get(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var p: String = ctx.paths.require_res(String(args.get("path", "")))
	if p.is_empty():
		return ctx.paths.last_error
	var cf := ConfigFile.new()
	if cf.load(p + ".import") != OK:
		return ctx.err("NO_IMPORT", "no .import sidecar for %s" % p,
			"only imported assets (textures, audio, models, fonts) have one — scenes, scripts and .tres resources import nothing")
	var params := {}
	if cf.has_section("params"):
		for key in cf.get_section_keys("params"):
			params[key] = ctx.types.to_jsonable(cf.get_value("params", key))
	var dest: Array = []
	for d in cf.get_value("deps", "dest_files", []):
		dest.append(String(d))
	return ctx.ok({
		"path": p,
		"importer": String(cf.get_value("remap", "importer", "")),
		"type": String(cf.get_value("remap", "type", "")),
		"uid": String(cf.get_value("remap", "uid", "")),
		"source_file": String(cf.get_value("deps", "source_file", "")),
		"dest_files": dest,
		"params": params,
	})


static func _import_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var p: String = ctx.paths.require_res(String(args.get("path", "")))
	if p.is_empty():
		return ctx.paths.last_error
	var wanted = args.get("params")
	if typeof(wanted) != TYPE_DICTIONARY or (wanted as Dictionary).is_empty():
		return ctx.err("BAD_ARGS", "params must be a non-empty object of key -> new value",
			"import_get lists the asset's current [params] keys")
	var cf := ConfigFile.new()
	if cf.load(p + ".import") != OK:
		return ctx.err("NO_IMPORT", "no .import sidecar for %s" % p,
			"only imported assets have one — import_get explains per path")
	var changed := {}
	var unknown: Array = []
	for key in wanted:
		var k := String(key)
		var had := cf.has_section_key("params", k)
		if not had:
			unknown.append(k)
		var old = cf.get_value("params", k, null)
		var parsed = ctx.types.parse(wanted[key])
		cf.set_value("params", k, parsed)
		changed[k] = { "from": ctx.types.to_jsonable(old) if had else "(unset)", "to": ctx.types.to_jsonable(parsed) }
	var save_err := cf.save(p + ".import")
	if save_err != OK:
		return ctx.err("SAVE_FAILED", "could not write %s.import (%s)" % [p, error_string(save_err)], "is the file writable?")
	var reimported := false
	if bool(args.get("reimport", true)):
		var fs: EditorFileSystem = ctx.editor.get_resource_filesystem()
		if fs != null:
			fs.reimport_files(PackedStringArray([p]))
			reimported = true
	return ctx.ok({
		"path": p,
		"changed": changed,
		"unknown_keys": unknown,
		"unknown_note": "" if unknown.is_empty() else "keys not in the current [params] — the importer may ignore them (import_get lists valid keys)",
		"reimported": reimported,
	})


static func _runtime_frames(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if ctx.runtime == null:
		return ctx.err("NO_RUNTIME", "runtime_frames needs a live play session", "start a play session with scene_play first, or use playtest_run for the whole loop")
	return await ctx.runtime.request("runtime_frames", args)


# The edit→run→observe loop as ONE evidence bundle: play, await the bridge,
# settle, sample frames + monitors, drain errors/log, screenshot, stop.
# Slices that fail mid-flow land in the bundle as their own {ok:false} —
# partial evidence beats an aborted run; only play/attach failures fail the op.
# The runtime legs go through ctx.server.proxy_to_runtime because ctx.runtime
# was captured before the play session existed.
static func _playtest_run(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if ctx.server == null:
		return ctx.err("NO_DISPATCH", "this context has no server seam", "addon bug (core/server.gd did not wire ctx.server); report it")
	var tree: SceneTree = (ctx.server as Node).get_tree()
	if ctx.server.runtime_connected():
		if ctx.editor.is_playing_scene():
			return ctx.err("ALREADY_PLAYING", "a bridged play session is already live", "scene_stop first — playtest_run wants a fresh run for clean evidence")
		# The editor says stopped: the bridge socket is trailing the last stop
		# (the server drops it on its play poll). Give it a beat.
		var linger0 := Time.get_ticks_msec()
		while ctx.server.runtime_connected() and Time.get_ticks_msec() - linger0 < 3000:
			await tree.create_timer(0.1).timeout
		if ctx.server.runtime_connected():
			return ctx.err("ALREADY_PLAYING", "a runtime bridge is still connected though the editor reports no play session", "scene_stop, then retry — or restart the editor if this persists")
	var duration := clampi(int(args.get("duration_ms", 5000)), 500, 30000)
	var settle := clampi(int(args.get("settle_ms", 1500)), 0, 10000)
	var attach_timeout := clampi(int(args.get("attach_timeout_ms", 45000)), 5000, 180000)
	var hitch_ms := clampf(float(args.get("hitch_ms", 50.0)), 17.0, 1000.0)
	var want_shot := bool(args.get("screenshot", true))
	var want_stop := bool(args.get("stop", true))
	var scene := str(args.get("scene", "current"))
	var play: Dictionary = await ctx.dispatch("scene_play", { "scene": scene })
	if not bool(play.get("ok", false)):
		return play
	var t0 := Time.get_ticks_msec()
	while not ctx.server.runtime_connected() and Time.get_ticks_msec() - t0 < attach_timeout:
		await tree.create_timer(0.2).timeout
	if not ctx.server.runtime_connected():
		var stop_note: Dictionary = await ctx.dispatch("scene_stop", {})
		return ctx.err("PLAYTEST_NO_BRIDGE",
			"the play session never bridged within %ds (session stopped: %s)" % [attach_timeout / 1000, str(bool(stop_note.get("ok", false)))],
			"vulcan_status checks the addon; a first spawn on a quarantined binary can be slow — raise attach_timeout_ms")
	var attached_ms := Time.get_ticks_msec() - t0
	if settle > 0:
		await tree.create_timer(settle / 1000.0).timeout
	var before: Dictionary = await ctx.server.proxy_to_runtime("profile_monitors", {})
	var frames: Dictionary = await ctx.server.proxy_to_runtime("runtime_frames", { "duration_ms": duration, "hitch_ms": hitch_ms })
	var after: Dictionary = await ctx.server.proxy_to_runtime("profile_monitors", {})
	var errors: Dictionary = await ctx.server.proxy_to_runtime("runtime_errors", { "limit": 40 })
	var log: Dictionary = await ctx.server.proxy_to_runtime("runtime_log", { "limit": 30 })
	var shot: Dictionary = {}
	if want_shot:
		shot = await ctx.server.proxy_to_runtime("runtime_screenshot", {})
	var stopped := false
	if want_stop:
		var stop_res: Dictionary = await ctx.dispatch("scene_stop", {})
		stopped = bool(stop_res.get("ok", false))
	var deltas := {}
	if bool(before.get("ok", false)) and bool(after.get("ok", false)):
		var b: Dictionary = before["result"]["monitors"]
		var a: Dictionary = after["result"]["monitors"]
		for key in ["orphan_nodes", "nodes", "objects", "static_memory"]:
			if b.has(key) and a.has(key):
				deltas[key] = a[key] - b[key]
	return ctx.ok({
		"scene": scene,
		"attached_ms": attached_ms,
		"settle_ms": settle,
		"frames": frames.get("result", frames),
		"monitors_before": before.get("result", before),
		"monitors_after": after.get("result", after),
		"monitor_deltas": deltas,
		"errors": errors.get("result", errors),
		"log_tail": log.get("result", log),
		"screenshot": shot.get("result", shot) if want_shot else "(disabled)",
		"stopped": stopped if want_stop else "(left running)",
	})


static func _runtime_wait_signal(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if ctx.runtime == null:
		return ctx.err("NO_RUNTIME", "runtime_wait_signal needs a live play session", "start a play session with scene_play first")
	return await ctx.runtime.request("runtime_wait_signal", args)


# --- structural scene diff (bounded; property compare on storage-flagged props) ---

static func _diff_trees(disk_root: Node, live_root: Node, disk_node: Node, live_node: Node, out: Array) -> void:
	if out.size() >= 400:
		return
	var where := String(disk_root.get_path_to(disk_node)) if disk_node != disk_root else "."
	if disk_node.get_class() != live_node.get_class():
		out.append({ "node": where, "kind": "type_changed", "disk": disk_node.get_class(), "editor": live_node.get_class() })
		return
	for p in disk_node.get_property_list():
		if (int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE) == 0:
			continue
		var pname := String(p.get("name", ""))
		if pname == "" or pname == "owner" or pname == "scene_file_path":
			continue
		var a = disk_node.get(pname)
		var b = live_node.get(pname)
		if var_to_str(a) != var_to_str(b):
			out.append({ "node": where, "kind": "property", "property": pname, "disk": var_to_str(a).left(120), "editor": var_to_str(b).left(120) })
			if out.size() >= 400:
				return
	var disk_names := {}
	for c in disk_node.get_children():
		disk_names[String(c.name)] = c
	var live_names := {}
	for c in live_node.get_children():
		live_names[String(c.name)] = c
	for name in disk_names:
		if not live_names.has(name):
			out.append({ "node": "%s/%s" % [where, name], "kind": "removed_in_editor" })
		else:
			_diff_trees(disk_root, live_root, disk_names[name], live_names[name], out)
	for name in live_names:
		if not disk_names.has(name):
			out.append({ "node": "%s/%s" % [where, name], "kind": "added_in_editor", "class": live_names[name].get_class() })
