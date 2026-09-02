@tool
class_name MercuryVulcanTheme
# mercury_vulcan — Theme/UI category handlers (static module, no instances).
# The 'theme' argument accepts a res://….tres Theme file OR a NodePath (the node's
# own theme is used; created + assigned undoably if missing). File-backed themes are
# re-saved inside the do/undo callables so disk follows the undo history.


static func ops() -> Array:
	return [
		"theme_create", "theme_color_set", "theme_font_set",
		"theme_constant_set", "theme_stylebox_set", "theme_apply",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"theme_create":
			return _create(args, ctx)
		"theme_color_set":
			return _color_set(args, ctx)
		"theme_font_set":
			return _font_set(args, ctx)
		"theme_constant_set":
			return _constant_set(args, ctx)
		"theme_stylebox_set":
			return _stylebox_set(args, ctx)
		"theme_apply":
			return _apply(args, ctx)
	return ctx.err("UNKNOWN_OP", "theme does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative .tres target", "e.g. res://ui/main_theme.tres")
	if FileAccess.file_exists(path):
		return ctx.err("BAD_ARGS", "%s already exists" % path, "pick a new path, or edit it with theme_color_set / theme_stylebox_set")
	var theme := Theme.new()
	if args.has("base"):
		var base_path: String = ctx.paths.require_res(String(args.get("base", "")))
		if base_path == "":
			return ctx.err("BAD_PATH", "base must be a res://-relative theme path", "e.g. res://ui/base_theme.tres")
		var base = load(base_path)
		if base == null or not (base is Theme):
			return ctx.err("LOAD_FAILED", "could not load a Theme from %s" % base_path, "check the path with project_file_search")
		theme.merge_with(base)
	var fs = ctx.editor.get_resource_filesystem()
	var do := func():
		var err := ResourceSaver.save(theme, path)
		if err == OK and fs != null:
			fs.update_file(path)
	var undo := func():
		DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
		if fs != null:
			fs.update_file(path)
	ctx.undo.action("vulcan: theme_create", do, undo)
	if not FileAccess.file_exists(path):
		return ctx.err("SAVE_FAILED", "could not save %s" % path, "check the directory exists (create it with resource_create in a valid dir, or pick another path)")
	return { "ok": true, "result": { "created": path, "base": args.get("base", null), "undoable": true } }


static func _color_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _theme_target(args, ctx)
	if got.has("err"):
		return got.err
	var color = ctx.types.parse(args.get("color"))
	if typeof(color) != TYPE_COLOR:
		return ctx.err("BAD_ARGS", "unparseable color '%s'" % [args.get("color")], "use #rrggbb, #rrggbbaa, or Color(r, g, b, a)")
	var name := String(args.get("name", ""))
	var type := String(args.get("type", ""))
	if name == "" or type == "":
		return ctx.err("BAD_ARGS", "name and type are required", "e.g. {\"name\": \"font_color\", \"type\": \"Button\"}")
	var theme: Theme = got.theme
	var had: bool = theme.has_color(name, type)
	var old: Color = theme.get_color(name, type) if had else Color()
	var do := func():
		_attach(got)
		theme.set_color(name, type, color)
		_persist(got, ctx)
	var undo := func():
		if had:
			theme.set_color(name, type, old)
		else:
			theme.clear_color(name, type)
		_detach(got)
		_persist(got, ctx)
	ctx.undo.action("vulcan: theme_color_set", do, undo)
	return { "ok": true, "result": { "set": "%s/%s" % [type, name], "color": "#" + color.to_html(color.a < 1.0), "theme": got.describe, "undoable": true } }


static func _font_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _theme_target(args, ctx)
	if got.has("err"):
		return got.err
	var name := String(args.get("name", "font"))
	var type := String(args.get("type", ""))
	if type == "":
		return ctx.err("BAD_ARGS", "type is required", "e.g. {\"type\": \"Label\", \"font\": \"res://fonts/main.ttf\"}")
	var theme: Theme = got.theme
	var font: Font = null
	if args.has("font"):
		var fpath: String = ctx.paths.require_res(String(args.get("font", "")))
		if fpath == "":
			return ctx.err("BAD_PATH", "font must be a res://-relative path", "e.g. res://fonts/main.ttf")
		var loaded = load(fpath)
		if loaded == null or not (loaded is Font):
			return ctx.err("LOAD_FAILED", "could not load a Font from %s" % fpath, "ttf/otf/fontdata resources qualify; check with project_file_search")
		font = loaded
	var size := int(args.get("size", 0))
	if font == null and size <= 0:
		return ctx.err("BAD_ARGS", "pass font and/or size", "e.g. {\"font\": \"res://fonts/main.ttf\", \"size\": 18}")
	var had_font: bool = theme.has_font(name, type)
	var old_font: Font = theme.get_font(name, type) if had_font else null
	var had_size: bool = theme.has_font_size(name + "_size" if name != "font" else "font_size", type)
	var size_name := name + "_size" if name != "font" else "font_size"
	var old_size: int = theme.get_font_size(size_name, type) if had_size else 0
	var do := func():
		_attach(got)
		if font != null:
			theme.set_font(name, type, font)
		if size > 0:
			theme.set_font_size(size_name, type, size)
		_persist(got, ctx)
	var undo := func():
		if font != null:
			if had_font:
				theme.set_font(name, type, old_font)
			else:
				theme.clear_font(name, type)
		if size > 0:
			if had_size:
				theme.set_font_size(size_name, type, old_size)
			else:
				theme.clear_font_size(size_name, type)
		_detach(got)
		_persist(got, ctx)
	ctx.undo.action("vulcan: theme_font_set", do, undo)
	return { "ok": true, "result": { "set": "%s/%s" % [type, name], "size": size if size > 0 else null, "theme": got.describe, "undoable": true } }


static func _constant_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _theme_target(args, ctx)
	if got.has("err"):
		return got.err
	var name := String(args.get("name", ""))
	var type := String(args.get("type", ""))
	if name == "" or type == "" or not args.has("value"):
		return ctx.err("BAD_ARGS", "name, type, and value are required", "e.g. {\"name\": \"separation\", \"type\": \"HBoxContainer\", \"value\": 12}")
	var value := int(args.get("value"))
	var theme: Theme = got.theme
	var had: bool = theme.has_constant(name, type)
	var old: int = theme.get_constant(name, type) if had else 0
	var do := func():
		_attach(got)
		theme.set_constant(name, type, value)
		_persist(got, ctx)
	var undo := func():
		if had:
			theme.set_constant(name, type, old)
		else:
			theme.clear_constant(name, type)
		_detach(got)
		_persist(got, ctx)
	ctx.undo.action("vulcan: theme_constant_set", do, undo)
	return { "ok": true, "result": { "set": "%s/%s" % [type, name], "value": value, "theme": got.describe, "undoable": true } }


static func _stylebox_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _theme_target(args, ctx)
	if got.has("err"):
		return got.err
	var name := String(args.get("name", ""))
	var type := String(args.get("type", ""))
	if name == "" or type == "":
		return ctx.err("BAD_ARGS", "name and type are required", "e.g. {\"name\": \"normal\", \"type\": \"Button\", \"stylebox\": \"flat\", \"properties\": {\"bg_color\": \"#222233\"}}")
	var kind := String(args.get("stylebox", "flat")).to_lower()
	var sb = null  # untyped: subclass-specific setters below
	match kind:
		"flat":
			sb = StyleBoxFlat.new()
		"texture":
			sb = StyleBoxTexture.new()
		"line":
			sb = StyleBoxLine.new()
		_:
			return ctx.err("BAD_ARGS", "unknown stylebox kind '%s'" % kind, "one of: flat, texture, line")
	var props: Dictionary = ctx.types.parse_dict(args.get("properties", {}))
	for k in props:
		var key := String(k)
		# corner/border sugar for StyleBoxFlat
		if sb is StyleBoxFlat and key == "corners":
			sb.set_corner_radius_all(int(props[k]))
			continue
		if sb is StyleBoxFlat and key == "borders":
			sb.set_border_width_all(int(props[k]))
			continue
		if not (key in sb):
			return ctx.err("BAD_ARGS", "%s has no property '%s'" % [sb.get_class(), key], "flat: bg_color, border_color, corners (all radii), borders (all widths); texture: texture, modulate_color; line: color, thickness")
		if key == "texture" and props[k] is String:
			var tpath: String = ctx.paths.require_res(String(props[k]))
			if tpath == "":
				return ctx.err("BAD_PATH", "texture must be a res://-relative path", "e.g. res://ui/panel.png")
			sb.set(key, load(tpath))
		else:
			sb.set(key, props[k])
	var theme: Theme = got.theme
	var had: bool = theme.has_stylebox(name, type)
	var old: StyleBox = theme.get_stylebox(name, type) if had else null
	var do := func():
		_attach(got)
		theme.set_stylebox(name, type, sb)
		_persist(got, ctx)
	var undo := func():
		if had:
			theme.set_stylebox(name, type, old)
		else:
			theme.clear_stylebox(name, type)
		_detach(got)
		_persist(got, ctx)
	ctx.undo.action("vulcan: theme_stylebox_set", do, undo)
	return { "ok": true, "result": { "set": "%s/%s" % [type, name], "stylebox": sb.get_class(), "theme": got.describe, "undoable": true } }


static func _apply(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("node", "")), ctx)
	if r.has("err"):
		return r.err
	var node: Node = r.node
	if not (node is Control):
		return ctx.err("BAD_TYPE", "%s is a %s — themes apply to Control nodes" % [args.get("node"), node.get_class()], "point 'node' at a Control (UI) subtree root")
	var ctrl := node as Control
	var tpath: String = ctx.paths.require_res(String(args.get("theme", "")))
	if tpath == "":
		return ctx.err("BAD_PATH", "theme must be a res://-relative .tres path", "e.g. res://ui/main_theme.tres")
	var theme = load(tpath)
	if theme == null or not (theme is Theme):
		return ctx.err("LOAD_FAILED", "could not load a Theme from %s" % tpath, "create one first with theme_create")
	var old: Theme = ctrl.theme
	var do := func():
		ctrl.theme = theme
	var undo := func():
		ctrl.theme = old
	ctx.undo.action("vulcan: theme_apply", do, undo)
	return { "ok": true, "result": { "node": String(args.get("node")), "theme": tpath, "undoable": true } }


# --- theme target resolution: res:// file or a node's own theme ---
# Returns {theme, describe, save_path?, node?, assign?} or {err}. When the target is
# a node without a theme, a fresh Theme is created here and assigned inside the undo
# action's do (assign=true) so the whole edit is one undoable step.

static func _theme_target(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var raw := String(args.get("theme", ""))
	if raw == "":
		return { "err": ctx.err("BAD_ARGS", "theme is required", "a res://….tres theme file, or a NodePath whose node theme to edit") }
	if raw.begins_with("res://") or raw.ends_with(".tres") or raw.ends_with(".res"):
		var path: String = ctx.paths.require_res(raw)
		if path == "":
			return { "err": ctx.err("BAD_PATH", "theme path must be res://-relative", "e.g. res://ui/main_theme.tres") }
		var theme = load(path)
		if theme == null or not (theme is Theme):
			return { "err": ctx.err("LOAD_FAILED", "could not load a Theme from %s" % path, "create one first with theme_create") }
		return { "theme": theme, "describe": path, "save_path": path }
	var r := _resolve(raw, ctx)
	if r.has("err"):
		return r
	var node: Node = r.node
	if not (node is Control):
		return { "err": ctx.err("BAD_TYPE", "%s is a %s — only Control nodes carry a theme" % [raw, node.get_class()], "pass a res://….tres path or a Control NodePath") }
	var ctrl := node as Control
	if ctrl.theme != null:
		return { "theme": ctrl.theme, "describe": "node:%s" % raw, "node": ctrl }
	var fresh := Theme.new()
	return { "theme": fresh, "describe": "node:%s (new theme)" % raw, "node": ctrl, "assign_node": ctrl }


# do-side: attach a freshly created node theme (inside the undo action, never eagerly)
static func _attach(got: Dictionary) -> void:
	if got.has("assign_node") and got.assign_node.theme != got.theme:
		got.assign_node.theme = got.theme


# undo-side: remove the freshly created node theme again
static func _detach(got: Dictionary) -> void:
	if got.has("assign_node"):
		got.assign_node.theme = null


static func _persist(got: Dictionary, ctx: MercuryVulcanContext) -> void:
	if got.has("save_path"):
		ResourceSaver.save(got.theme, got.save_path)
		var fs = ctx.editor.get_resource_filesystem()
		if fs != null:
			fs.update_file(got.save_path)


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
