@tool
class_name MercuryVulcanShader
# mercury_vulcan — Shader category handlers (static module, no instances).
# .gdshader files are text — created/edited via FileAccess (undo restores prior
# bytes or deletes). Compile-checking is BEST-EFFORT: GDScript cannot read shader
# compile diagnostics directly; the result says so and points at editor_errors.


static func ops() -> Array:
	return [
		"shader_read", "shader_param_list", "shader_create",
		"shader_edit", "shader_assign", "shader_param_set",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"shader_read":
			return _read(args, ctx)
		"shader_param_list":
			return _param_list(args, ctx)
		"shader_create":
			return _create(args, ctx)
		"shader_edit":
			return _edit(args, ctx)
		"shader_assign":
			return _assign(args, ctx)
		"shader_param_set":
			return _param_set(args, ctx)
	return ctx.err("UNKNOWN_OP", "shader does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _read(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var raw := String(args.get("path", ""))
	if raw == "":
		return ctx.err("BAD_ARGS", "path is required", "a res://….gdshader file, or a NodePath whose material's shader to read")
	if raw.begins_with("res://") or raw.ends_with(".gdshader"):
		var path: String = ctx.paths.require_res(raw)
		if path == "":
			return ctx.err("BAD_PATH", "path must be res://-relative", "e.g. res://shaders/glow.gdshader")
		var f := FileAccess.open(path, FileAccess.READ)
		if f == null:
			return ctx.err("NOT_FOUND", "no file at %s" % path, "check with project_file_search pattern *.gdshader")
		return { "ok": true, "result": { "path": path, "code": f.get_as_text() } }
	var found := _material_of(raw, ctx)
	if found.has("err"):
		return found.err
	var mat = found.material
	if not (mat is ShaderMaterial) or mat.shader == null:
		return ctx.err("NOT_FOUND", "%s has a %s without a Shader" % [raw, mat.get_class() if mat != null else "no material"], "assign one with shader_assign")
	return { "ok": true, "result": { "node": raw, "shader": mat.shader.resource_path, "code": mat.shader.code } }


static func _param_list(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _shader_material(args.get("material"), ctx)
	if got.has("err"):
		return got.err
	var mat: ShaderMaterial = got.material
	var uniforms: Array = []
	for u in mat.shader.get_shader_uniform_list():
		var name := String(u.get("name", ""))
		if name == "":
			continue
		uniforms.append({
			"name": name,
			"type": int(u.get("type", 0)),
			"hint_string": String(u.get("hint_string", "")),
			"value": _j(mat.get_shader_parameter(name)),
		})
	return { "ok": true, "result": { "material": got.describe, "shader": mat.shader.resource_path, "uniforms": uniforms } }


static func _create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative .gdshader target", "e.g. res://shaders/glow.gdshader")
	if FileAccess.file_exists(path):
		return ctx.err("BAD_ARGS", "%s already exists" % path, "use shader_edit to change it, or pick a new path")
	var code := String(args.get("code", ""))
	if code == "":
		var mode := String(args.get("mode", "canvas_item")).to_lower()
		if not ["canvas_item", "spatial", "particles", "sky", "fog"].has(mode):
			return ctx.err("BAD_ARGS", "unknown shader mode '%s'" % mode, "one of: canvas_item, spatial, particles, sky, fog")
		code = "shader_type %s;\n\nvoid fragment() {\n\t// mercury_vulcan template — edit me\n}\n" % mode
	var fs = ctx.editor.get_resource_filesystem()
	var do := func():
		var f := FileAccess.open(path, FileAccess.WRITE)
		if f != null:
			f.store_string(code)
			f.close()
			if fs != null:
				fs.update_file(path)
	var undo := func():
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
		if fs != null:
			fs.update_file(path)
	ctx.undo.action("vulcan: shader_create", do, undo)
	if not FileAccess.file_exists(path):
		return ctx.err("SAVE_FAILED", "could not write %s" % path, "does the directory exist? create it first or pick another path")
	return { "ok": true, "result": { "created": path, "bytes": code.length(), "undoable": true, "compile_check": "best-effort — watch editor_errors after the editor picks it up" } }


static func _edit(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative .gdshader file", "e.g. res://shaders/glow.gdshader")
	var code := String(args.get("code", ""))
	if code == "":
		return ctx.err("BAD_ARGS", "code is required", "pass the full new shader source")
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ctx.err("NOT_FOUND", "no file at %s" % path, "create it first with shader_create")
	var old := f.get_as_text()
	f.close()
	var fs = ctx.editor.get_resource_filesystem()
	var write := func(text: String):
		var w := FileAccess.open(path, FileAccess.WRITE)
		if w != null:
			w.store_string(text)
			w.close()
			if fs != null:
				fs.update_file(path)
	var do := func():
		write.call(code)
	var undo := func():
		write.call(old)
	ctx.undo.action("vulcan: shader_edit", do, undo)
	# Reload the in-memory resource so open materials pick up the change now.
	if ResourceLoader.exists(path):
		var sh = load(path)
		if sh is Shader:
			sh.code = code
	return { "ok": true, "result": { "edited": path, "bytes": code.length(), "undoable": true, "compile_check": "best-effort — check editor_errors for shader compile diagnostics" } }


static func _assign(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("node", "")), ctx)
	if r.has("err"):
		return r.err
	var node: Node = r.node
	var spath: String = ctx.paths.require_res(String(args.get("shader", "")))
	if spath == "":
		return ctx.err("BAD_PATH", "shader must be a res://-relative .gdshader path", "e.g. res://shaders/glow.gdshader")
	var sh = load(spath)
	if sh == null or not (sh is Shader):
		return ctx.err("LOAD_FAILED", "could not load a Shader from %s" % spath, "create it first with shader_create")
	var prop := ""
	if "material" in node:
		prop = "material"
	elif "material_override" in node:
		prop = "material_override"
	else:
		return ctx.err("BAD_TYPE", "%s (%s) has no material property" % [args.get("node"), node.get_class()], "CanvasItem or GeometryInstance3D nodes take shaders")
	var mat := ShaderMaterial.new()
	mat.shader = sh
	var old = node.get(prop)
	var do := func():
		node.set(prop, mat)
	var undo := func():
		node.set(prop, old)
	ctx.undo.action("vulcan: shader_assign", do, undo)
	return { "ok": true, "result": { "node": String(args.get("node")), "property": prop, "shader": spath, "undoable": true } }


static func _param_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _shader_material(args.get("material"), ctx)
	if got.has("err"):
		return got.err
	var mat: ShaderMaterial = got.material
	var param := String(args.get("parameter", ""))
	if param == "" or not args.has("value"):
		return ctx.err("BAD_ARGS", "parameter and value are required", "list uniforms first with shader_param_list")
	var known := false
	for u in mat.shader.get_shader_uniform_list():
		if String(u.get("name", "")) == param:
			known = true
			break
	if not known:
		var names: Array = []
		for u in mat.shader.get_shader_uniform_list():
			names.append(String(u.get("name", "")))
		return ctx.err("NOT_FOUND", "shader has no uniform '%s'" % param, "uniforms: %s" % (", ".join(names) if names.size() > 0 else "(none)"))
	var value = ctx.types.parse(args.get("value"))
	var old = mat.get_shader_parameter(param)
	var do := func():
		mat.set_shader_parameter(param, value)
		if got.has("save_path"):
			ResourceSaver.save(mat, got.save_path)
	var undo := func():
		mat.set_shader_parameter(param, old)
		if got.has("save_path"):
			ResourceSaver.save(mat, got.save_path)
	ctx.undo.action("vulcan: shader_param_set", do, undo)
	return { "ok": true, "result": { "material": got.describe, "parameter": param, "value": _j(value), "undoable": true } }


# --- material resolution: res:// material file or a node's material ---

static func _shader_material(raw_v, ctx: MercuryVulcanContext) -> Dictionary:
	var raw := String(raw_v) if raw_v != null else ""
	if raw == "":
		return { "err": ctx.err("BAD_ARGS", "material is required", "a res://….tres ShaderMaterial, or a NodePath whose material to use") }
	if raw.begins_with("res://") or raw.ends_with(".tres") or raw.ends_with(".res") or raw.ends_with(".material"):
		var path: String = ctx.paths.require_res(raw)
		if path == "":
			return { "err": ctx.err("BAD_PATH", "material path must be res://-relative", "e.g. res://materials/glow.tres") }
		var mat = load(path)
		if mat == null or not (mat is ShaderMaterial):
			return { "err": ctx.err("LOAD_FAILED", "%s is not a ShaderMaterial" % path, "assign a shader to a node with shader_assign, then save it as .tres") }
		if mat.shader == null:
			return { "err": ctx.err("NOT_FOUND", "%s has no Shader assigned" % path, "assign one with shader_assign") }
		return { "material": mat, "describe": path, "save_path": path }
	var found := _material_of(raw, ctx)
	if found.has("err"):
		return found
	var mat = found.material
	if not (mat is ShaderMaterial):
		return { "err": ctx.err("BAD_TYPE", "%s's material is a %s, not a ShaderMaterial" % [raw, mat.get_class() if mat != null else "null"], "assign a shader first with shader_assign") }
	if mat.shader == null:
		return { "err": ctx.err("NOT_FOUND", "%s's ShaderMaterial has no Shader" % raw, "assign one with shader_assign") }
	return { "material": mat, "describe": "node:%s" % raw }


static func _material_of(raw: String, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(raw, ctx)
	if r.has("err"):
		return r
	var node: Node = r.node
	var mat = null
	if "material" in node and node.get("material") != null:
		mat = node.get("material")
	elif "material_override" in node and node.get("material_override") != null:
		mat = node.get("material_override")
	if mat == null:
		return { "err": ctx.err("NOT_FOUND", "%s (%s) has no material assigned" % [raw, node.get_class()], "assign one with shader_assign") }
	return { "material": mat }


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
	return var_to_str(v)


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
