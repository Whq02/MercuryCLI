@tool
class_name MercuryVulcanThreeD
# mercury_vulcan — 3D Scene category handlers (static module, no instances).
# Every mutate op is one EditorUndoRedoManager action via ctx.undo ("vulcan: <op>").


static func ops() -> Array:
	return [
		"mesh_create", "camera_create", "light_create",
		"environment_set", "gridmap_set_cell", "gridmap_query",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"mesh_create":
			return _mesh_create(args, ctx)
		"camera_create":
			return _camera_create(args, ctx)
		"light_create":
			return _light_create(args, ctx)
		"environment_set":
			return _environment_set(args, ctx)
		"gridmap_set_cell":
			return _gridmap_set_cell(args, ctx)
		"gridmap_query":
			return _gridmap_query(args, ctx)
	return ctx.err("UNKNOWN_OP", "three_d does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _mesh_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var parent: Node = r.node
	var shape := String(args.get("shape", "box")).to_lower()
	var mesh = null  # untyped: each primitive subclass has its own size props
	match shape:
		"box":
			mesh = BoxMesh.new()
		"sphere":
			mesh = SphereMesh.new()
		"cylinder":
			mesh = CylinderMesh.new()
		"capsule":
			mesh = CapsuleMesh.new()
		"plane":
			mesh = PlaneMesh.new()
		"torus":
			mesh = TorusMesh.new()
		"quad":
			mesh = QuadMesh.new()
		_:
			return ctx.err("BAD_ARGS", "unknown mesh shape '%s'" % shape, "one of: box, sphere, cylinder, capsule, plane, torus, quad")
	if args.has("size"):
		_apply_mesh_size(mesh, shape, ctx.types.parse(args.get("size")))
	if args.has("material"):
		var mat_path: String = ctx.paths.require_res(String(args.get("material", "")))
		if mat_path == "":
			return ctx.err("BAD_PATH", "material must be a res://-relative path", "pass res://…material/.tres inside the project")
		var mat = load(mat_path)
		if mat == null or not (mat is Material):
			return ctx.err("LOAD_FAILED", "could not load a Material from %s" % mat_path, "check the path with project_file_search")
		mesh.material = mat
	var node := MeshInstance3D.new()
	node.name = String(args.get("name", "Mesh_%s" % shape.capitalize()))
	node.mesh = mesh
	return _add_node_undoable(node, parent, "vulcan: mesh_create", ctx)


static func _camera_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var parent: Node = r.node
	var node := Camera3D.new()
	node.name = String(args.get("name", "Camera3D"))
	if args.has("fov"):
		node.fov = float(args.get("fov"))
	var pos = ctx.types.parse(args.get("position")) if args.has("position") else null
	var look = ctx.types.parse(args.get("look_at")) if args.has("look_at") else null
	var make_current := bool(args.get("current", false))
	var root: Node = ctx.editor.get_edited_scene_root()
	var do := func():
		parent.add_child(node)
		node.owner = root
		if typeof(pos) == TYPE_VECTOR3:
			node.position = pos
		if typeof(look) == TYPE_VECTOR3 and node.is_inside_tree():
			node.look_at_from_position(node.global_position, look, Vector3.UP)
		if make_current:
			node.current = true
	var undo := func():
		parent.remove_child(node)
	ctx.undo.action("vulcan: camera_create", do, undo)
	return { "ok": true, "result": { "added": String(root.get_path_to(node)), "type": "Camera3D", "undoable": true } }


static func _light_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var parent: Node = r.node
	var kind := String(args.get("type", "directional")).to_lower()
	var node: Light3D = null
	match kind:
		"directional":
			node = DirectionalLight3D.new()
		"omni":
			node = OmniLight3D.new()
		"spot":
			node = SpotLight3D.new()
		_:
			return ctx.err("BAD_ARGS", "unknown light type '%s'" % kind, "one of: directional, omni, spot")
	node.name = String(args.get("name", node.get_class()))
	if args.has("color"):
		var c = ctx.types.parse(args.get("color"))
		if typeof(c) == TYPE_COLOR:
			node.light_color = c
	if args.has("energy"):
		node.light_energy = float(args.get("energy"))
	var pos = ctx.types.parse(args.get("position")) if args.has("position") else null
	if typeof(pos) == TYPE_VECTOR3:
		node.position = pos
	return _add_node_undoable(node, parent, "vulcan: light_create", ctx)


static func _environment_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return ctx.err("NO_SCENE", "no scene is being edited", "open or create a scene first (scene_open / scene_create)")
	var settings: Dictionary = ctx.types.parse_dict(args.get("settings", {}))
	if settings.is_empty():
		return ctx.err("BAD_ARGS", "settings dict is required", "pass Environment properties, e.g. {\"ambient_light_energy\": 0.5, \"glow_enabled\": true}")
	var we: WorldEnvironment = null
	if args.has("node"):
		var r := _resolve(String(args.get("node", "")), ctx)
		if r.has("err"):
			return r.err
		if not (r.node is WorldEnvironment):
			return ctx.err("BAD_TYPE", "%s is a %s, not a WorldEnvironment" % [args.get("node"), r.node.get_class()], "omit 'node' to auto-find or auto-create one")
		we = r.node
	else:
		we = _find_first(root, "WorldEnvironment") as WorldEnvironment
	var created_node := we == null
	if created_node:
		we = WorldEnvironment.new()
		we.name = "WorldEnvironment"
	var env: Environment = null if created_node else we.environment
	var created_env := env == null
	if created_env:
		env = Environment.new()
	for k in settings:
		if not (String(k) in env):
			return ctx.err("BAD_ARGS", "Environment has no property '%s'" % k, "examples: background_mode, ambient_light_color, ambient_light_energy, fog_enabled, glow_enabled, tonemap_mode")
	var old := {}
	if not created_env:
		for k in settings:
			old[k] = env.get(k)
	var do := func():
		if created_node:
			root.add_child(we)
			we.owner = root
		if created_env:
			we.environment = env
		for k in settings:
			env.set(k, settings[k])
	var undo := func():
		for k in old:
			env.set(k, old[k])
		if created_env:
			we.environment = null
		if created_node:
			root.remove_child(we)
	ctx.undo.action("vulcan: environment_set", do, undo)
	return { "ok": true, "result": { "node": String(root.get_path_to(we)), "created_node": created_node, "created_environment": created_env, "applied": settings.keys(), "undoable": true } }


static func _gridmap_set_cell(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("gridmap", "")), ctx)
	if r.has("err"):
		return r.err
	var gm: Node = r.node
	if not gm.is_class("GridMap"):
		return ctx.err("BAD_TYPE", "%s is a %s, not a GridMap" % [args.get("gridmap"), gm.get_class()], "point 'gridmap' at a GridMap node (see scene_tree)")
	var cell = _v3i(ctx.types.parse(args.get("cell")))
	if cell == null:
		return ctx.err("BAD_ARGS", "cell must be a Vector3i", "e.g. \"Vector3i(0, 0, 0)\" or [0, 0, 0]")
	var item = args.get("item")
	var item_idx := -1
	if typeof(item) == TYPE_STRING and not String(item).is_valid_int():
		var ml = gm.get("mesh_library")
		if ml == null:
			return ctx.err("BAD_ARGS", "GridMap has no mesh_library — cannot resolve item by name", "assign a MeshLibrary or pass a numeric item index")
		item_idx = ml.find_item_by_name(String(item))
		if item_idx < 0:
			var names: Array = []
			for id in ml.get_item_list():
				names.append(ml.get_item_name(id))
			return ctx.err("NOT_FOUND", "no MeshLibrary item named '%s'" % item, "items: %s" % ", ".join(names))
	else:
		item_idx = int(item) if item != null else -1
	var orientation := int(args.get("orientation", 0))
	var prior_item: int = gm.call("get_cell_item", cell)
	var prior_orient: int = gm.call("get_cell_item_orientation", cell)
	var do := func():
		gm.call("set_cell_item", cell, item_idx, orientation)
	var undo := func():
		gm.call("set_cell_item", cell, prior_item, prior_orient)
	ctx.undo.action("vulcan: gridmap_set_cell", do, undo)
	return { "ok": true, "result": { "cell": [cell.x, cell.y, cell.z], "item": item_idx, "orientation": orientation, "undoable": true } }


static func _gridmap_query(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("gridmap", "")), ctx)
	if r.has("err"):
		return r.err
	var gm: Node = r.node
	if not gm.is_class("GridMap"):
		return ctx.err("BAD_TYPE", "%s is a %s, not a GridMap" % [args.get("gridmap"), gm.get_class()], "point 'gridmap' at a GridMap node (see scene_tree)")
	if args.has("cell"):
		var cell = _v3i(ctx.types.parse(args.get("cell")))
		if cell == null:
			return ctx.err("BAD_ARGS", "cell must be a Vector3i", "e.g. \"Vector3i(0, 0, 0)\" or [0, 0, 0]")
		var item: int = gm.call("get_cell_item", cell)
		var res := { "cell": [cell.x, cell.y, cell.z], "item": item, "orientation": gm.call("get_cell_item_orientation", cell) }
		var ml = gm.get("mesh_library")
		if item >= 0 and ml != null:
			res["item_name"] = ml.get_item_name(item)
		return { "ok": true, "result": res }
	var used: Array = gm.call("get_used_cells")
	var cells: Array = []
	for c in used:
		cells.append([c.x, c.y, c.z])
		if cells.size() >= 500:
			break
	return { "ok": true, "result": { "used_count": used.size(), "cells": cells, "truncated": used.size() > cells.size() } }


# --- local helpers (small; shared candidates live in core/, which W-A owns) ---

static func _apply_mesh_size(mesh, shape: String, v) -> void:
	if typeof(v) == TYPE_FLOAT or typeof(v) == TYPE_INT:
		var f := float(v)
		match shape:
			"box":
				mesh.size = Vector3(f, f, f)
			"sphere":
				mesh.radius = f / 2.0
				mesh.height = f
			"cylinder":
				mesh.top_radius = f / 2.0
				mesh.bottom_radius = f / 2.0
				mesh.height = f
			"capsule":
				mesh.radius = f / 2.0
				mesh.height = f * 2.0
			"plane", "quad":
				mesh.size = Vector2(f, f)
			"torus":
				mesh.outer_radius = f
				mesh.inner_radius = f / 2.0
	elif typeof(v) == TYPE_VECTOR3:
		match shape:
			"box":
				mesh.size = v
			"plane", "quad":
				mesh.size = Vector2(v.x, v.y)
			"cylinder":
				mesh.top_radius = v.x / 2.0
				mesh.bottom_radius = v.x / 2.0
				mesh.height = v.y
			_:
				mesh.set("size", v)
	elif typeof(v) == TYPE_VECTOR2 and (shape == "plane" or shape == "quad"):
		mesh.size = v


static func _add_node_undoable(node: Node, parent: Node, action: String, ctx: MercuryVulcanContext) -> Dictionary:
	var root: Node = ctx.editor.get_edited_scene_root()
	var do := func():
		parent.add_child(node)
		node.owner = root
	var undo := func():
		parent.remove_child(node)
	ctx.undo.action(action, do, undo)
	return { "ok": true, "result": { "added": String(root.get_path_to(node)), "type": node.get_class(), "undoable": true } }


static func _find_first(root: Node, klass: String) -> Node:
	if root.is_class(klass):
		return root
	for c in root.get_children():
		var hit := _find_first(c, klass)
		if hit != null:
			return hit
	return null


static func _v3i(v):
	match typeof(v):
		TYPE_VECTOR3I:
			return v
		TYPE_VECTOR3:
			return Vector3i(v)
		TYPE_ARRAY:
			if v.size() == 3:
				return Vector3i(int(v[0]), int(v[1]), int(v[2]))
	return null


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
