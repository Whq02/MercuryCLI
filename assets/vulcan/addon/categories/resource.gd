@tool
class_name MercuryVulcanResource
# mercury_vulcan — Resource category handlers (static module, no instances).
# autoload_add/remove write ProjectSettings ("autoload/<name>" = "*res://…") and
# save() inside the undo callables, so Ctrl+Z reverts the project.godot change too.


static func ops() -> Array:
	return [
		"resource_read", "resource_create", "resource_edit",
		"resource_duplicate", "autoload_add", "autoload_remove",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"resource_read":
			return _read(args, ctx)
		"resource_create":
			return _create(args, ctx)
		"resource_edit":
			return _edit(args, ctx)
		"resource_duplicate":
			return _duplicate(args, ctx)
		"autoload_add":
			return _autoload_add(args, ctx)
		"autoload_remove":
			return _autoload_remove(args, ctx)
	return ctx.err("UNKNOWN_OP", "resource does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _read(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative resource file", "e.g. res://data/enemy_stats.tres")
	if not ResourceLoader.exists(path):
		return ctx.err("NOT_FOUND", "no resource at %s" % path, "check with project_file_search")
	var res = load(path)
	if res == null:
		return ctx.err("LOAD_FAILED", "could not load %s" % path, "is it a valid .tres/.res file? check editor_errors")
	var props := {}
	var count := 0
	for p in res.get_property_list():
		if (int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE) == 0:
			continue
		var name := String(p.get("name", ""))
		if name == "" or name == "resource_path" or name == "script":
			continue
		props[name] = _j(res.get(name))
		count += 1
		if count >= 120:
			props["…"] = "(truncated at 120 properties)"
			break
	var script_path := ""
	if res.get_script() != null:
		script_path = res.get_script().resource_path
	return { "ok": true, "result": { "path": path, "type": res.get_class(), "script": script_path, "properties": props } }


static func _create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative .tres target", "e.g. res://data/enemy_stats.tres")
	if FileAccess.file_exists(path):
		return ctx.err("BAD_ARGS", "%s already exists" % path, "use resource_edit, or pick a new path")
	var type := String(args.get("type", ""))
	if type == "":
		return ctx.err("BAD_ARGS", "type is required", "a Resource class, e.g. Resource, Curve, Gradient, AudioBusLayout, LabelSettings")
	if not ClassDB.class_exists(type):
		return ctx.err("BAD_ARGS", "no class named '%s'" % type, "check the exact class name in the Godot docs; custom script resources: create via script_create + a .tres with script property")
	if not ClassDB.is_parent_class(type, "Resource"):
		return ctx.err("BAD_TYPE", "'%s' is not a Resource class" % type, "resource_create makes .tres files; for nodes use node_add")
	if not ClassDB.can_instantiate(type):
		return ctx.err("BAD_TYPE", "'%s' cannot be instantiated" % type, "it is abstract or editor-internal; pick a concrete Resource class")
	var res: Resource = ClassDB.instantiate(type)
	var props: Dictionary = ctx.types.parse_dict(args.get("properties", {}))
	for k in props:
		if not (String(k) in res):
			return ctx.err("BAD_ARGS", "%s has no property '%s'" % [type, k], "read the class docs, or create bare and inspect with resource_read")
		res.set(k, props[k])
	var fs = ctx.editor.get_resource_filesystem()
	var do := func():
		var err := ResourceSaver.save(res, path)
		if err == OK and fs != null:
			fs.update_file(path)
	var undo := func():
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
		if fs != null:
			fs.update_file(path)
	ctx.undo.action("vulcan: resource_create", do, undo)
	if not FileAccess.file_exists(path):
		return ctx.err("SAVE_FAILED", "could not save %s" % path, "does the directory exist? pick a path under an existing folder")
	return { "ok": true, "result": { "created": path, "type": type, "properties_set": props.keys(), "undoable": true } }


static func _edit(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative resource file", "e.g. res://data/enemy_stats.tres")
	if not ResourceLoader.exists(path):
		return ctx.err("NOT_FOUND", "no resource at %s" % path, "create it first with resource_create")
	var res = load(path)
	if res == null:
		return ctx.err("LOAD_FAILED", "could not load %s" % path, "is it a valid resource? check editor_errors")
	var props: Dictionary = ctx.types.parse_dict(args.get("properties", {}))
	if props.is_empty():
		return ctx.err("BAD_ARGS", "properties dict is required", "e.g. {\"max_value\": 10, \"bake_resolution\": 128}")
	for k in props:
		if not (String(k) in res):
			return ctx.err("BAD_ARGS", "%s has no property '%s'" % [res.get_class(), k], "inspect it first with resource_read")
	var old := {}
	for k in props:
		old[k] = res.get(k)
	var fs = ctx.editor.get_resource_filesystem()
	var do := func():
		for k in props:
			res.set(k, props[k])
		ResourceSaver.save(res, path)
		if fs != null:
			fs.update_file(path)
	var undo := func():
		for k in old:
			res.set(k, old[k])
		ResourceSaver.save(res, path)
		if fs != null:
			fs.update_file(path)
	ctx.undo.action("vulcan: resource_edit", do, undo)
	return { "ok": true, "result": { "edited": path, "properties_set": props.keys(), "undoable": true } }


static func _duplicate(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var src: String = ctx.paths.require_res(String(args.get("path", "")))
	if src == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative source file", "e.g. res://data/enemy_stats.tres")
	var out: String = ctx.paths.require_res(String(args.get("out", "")))
	if out == "":
		return ctx.err("BAD_PATH", "out must be a res://-relative target", "e.g. res://data/enemy_stats_boss.tres")
	if not ResourceLoader.exists(src):
		return ctx.err("NOT_FOUND", "no resource at %s" % src, "check with project_file_search")
	if FileAccess.file_exists(out):
		return ctx.err("BAD_ARGS", "%s already exists" % out, "pick a new out path")
	var res = load(src)
	if res == null:
		return ctx.err("LOAD_FAILED", "could not load %s" % src, "is it a valid resource?")
	var copy: Resource = res.duplicate(true)
	var fs = ctx.editor.get_resource_filesystem()
	var do := func():
		var err := ResourceSaver.save(copy, out)
		if err == OK and fs != null:
			fs.update_file(out)
	var undo := func():
		DirAccess.remove_absolute(ProjectSettings.globalize_path(out))
		if fs != null:
			fs.update_file(out)
	ctx.undo.action("vulcan: resource_duplicate", do, undo)
	if not FileAccess.file_exists(out):
		return ctx.err("SAVE_FAILED", "could not save %s" % out, "does the target directory exist?")
	return { "ok": true, "result": { "from": src, "to": out, "undoable": true } }


static func _autoload_add(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var name := String(args.get("name", ""))
	if name == "" or not name.is_valid_identifier():
		return ctx.err("BAD_ARGS", "name must be a valid identifier", "e.g. {\"name\": \"GameState\", \"path\": \"res://autoload/game_state.gd\"}")
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative script or scene", "e.g. res://autoload/game_state.gd")
	if not FileAccess.file_exists(path):
		return ctx.err("NOT_FOUND", "no file at %s" % path, "create the script first (script_create)")
	var key := "autoload/%s" % name
	var had: bool = ProjectSettings.has_setting(key)
	var old = ProjectSettings.get_setting(key) if had else null
	var value := "*%s" % path
	var do := func():
		ProjectSettings.set_setting(key, value)
		ProjectSettings.save()
	var undo := func():
		ProjectSettings.set_setting(key, old if had else null)
		ProjectSettings.save()
	ctx.undo.action("vulcan: autoload_add", do, undo)
	return { "ok": true, "result": { "autoload": name, "path": path, "replaced": had, "undoable": true, "note": "singleton is available on the next play session / editor restart" } }


static func _autoload_remove(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var name := String(args.get("name", ""))
	var key := "autoload/%s" % name
	if name == "" or not ProjectSettings.has_setting(key):
		var existing: Array = []
		for p in ProjectSettings.get_property_list():
			var pname := String(p.get("name", ""))
			if pname.begins_with("autoload/"):
				existing.append(pname.trim_prefix("autoload/"))
		return ctx.err("NOT_FOUND", "no autoload named '%s'" % name, "registered autoloads: %s" % (", ".join(existing) if existing.size() > 0 else "(none)"))
	var old = ProjectSettings.get_setting(key)
	var do := func():
		ProjectSettings.set_setting(key, null)
		ProjectSettings.save()
	var undo := func():
		ProjectSettings.set_setting(key, old)
		ProjectSettings.save()
	ctx.undo.action("vulcan: autoload_remove", do, undo)
	return { "ok": true, "result": { "removed": name, "was": String(old), "undoable": true } }


# --- local helpers ---

static func _j(v):
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return v
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [v.x, v.y]
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return [v.x, v.y, v.z]
		TYPE_VECTOR4, TYPE_VECTOR4I:
			return [v.x, v.y, v.z, v.w]
		TYPE_COLOR:
			return "#" + v.to_html(v.a < 1.0)
		TYPE_OBJECT:
			if v == null:
				return null
			if v is Resource and v.resource_path != "":
				return v.resource_path
			return "<%s>" % v.get_class()
		TYPE_ARRAY:
			var out: Array = []
			for item in v:
				out.append(_j(item))
				if out.size() >= 64:
					out.append("(truncated)")
					break
			return out
		TYPE_DICTIONARY:
			var outd := {}
			for k in v:
				outd[String(k)] = _j(v[k])
			return outd
	return var_to_str(v)
