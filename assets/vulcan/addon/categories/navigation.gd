@tool
class_name MercuryVulcanNavigation
# mercury_vulcan — Navigation category handlers (static module, no instances).
# nav_query_path runs against the edited scene viewport's navigation map; in-editor
# maps only reflect BAKED region data, so an empty path often means "not baked or
# not synced" — the result says so instead of pretending certainty.


static func ops() -> Array:
	return [
		"nav_region_create", "nav_agent_create", "nav_link_create",
		"nav_layers_set", "nav_bake", "nav_query_path",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"nav_region_create":
			return _region_create(args, ctx)
		"nav_agent_create":
			return _agent_create(args, ctx)
		"nav_link_create":
			return _link_create(args, ctx)
		"nav_layers_set":
			return _layers_set(args, ctx)
		"nav_bake":
			return _bake(args, ctx)
		"nav_query_path":
			return _query_path(args, ctx)
	return ctx.err("UNKNOWN_OP", "navigation does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _dim(args: Dictionary) -> String:
	return String(args.get("dimensions", "2d")).to_lower()


static func _region_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var d := _dim(args)
	if d != "2d" and d != "3d":
		return ctx.err("BAD_ARGS", "dimensions must be 2d or 3d", "got '%s'" % d)
	var node: Node = null
	if d == "2d":
		var region := NavigationRegion2D.new()
		region.navigation_polygon = NavigationPolygon.new()
		node = region
	else:
		var region3 := NavigationRegion3D.new()
		region3.navigation_mesh = NavigationMesh.new()
		node = region3
	node.name = String(args.get("name", node.get_class()))
	return _add_node_undoable(node, r.node, "vulcan: nav_region_create", ctx)


static func _agent_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var d := _dim(args)
	if d != "2d" and d != "3d":
		return ctx.err("BAD_ARGS", "dimensions must be 2d or 3d", "got '%s'" % d)
	var node = NavigationAgent2D.new() if d == "2d" else NavigationAgent3D.new()
	node.name = String(args.get("name", node.get_class()))
	if args.has("radius"):
		node.radius = float(args.get("radius"))
	return _add_node_undoable(node, r.node, "vulcan: nav_agent_create", ctx)


static func _link_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var d := _dim(args)
	var start = ctx.types.parse(args.get("start"))
	var end = ctx.types.parse(args.get("end"))
	var want := TYPE_VECTOR2 if d == "2d" else TYPE_VECTOR3
	if typeof(start) != want or typeof(end) != want:
		return ctx.err("BAD_ARGS", "start/end must be %s for %s links" % ["Vector2" if d == "2d" else "Vector3", d], "e.g. {\"start\": \"Vector2(0, 0)\", \"end\": \"Vector2(64, -32)\"}")
	var node = NavigationLink2D.new() if d == "2d" else NavigationLink3D.new()
	node.name = String(args.get("name", node.get_class()))
	node.start_position = start
	node.end_position = end
	node.bidirectional = bool(args.get("bidirectional", true))
	return _add_node_undoable(node, r.node, "vulcan: nav_link_create", ctx)


static func _layers_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("node", "")), ctx)
	if r.has("err"):
		return r.err
	var node = r.node  # untyped: navigation_layers lives on region/agent/link classes
	if not ("navigation_layers" in node):
		return ctx.err("BAD_TYPE", "%s (%s) has no navigation_layers" % [args.get("node"), node.get_class()], "point 'node' at a NavigationRegion, NavigationAgent, or NavigationLink node")
	var layers = args.get("layers")
	if not (layers is Array):
		return ctx.err("BAD_ARGS", "layers must be an array of layer numbers", "e.g. {\"layers\": [1, 2]}")
	var bits := 0
	for n in layers:
		var i := int(n)
		if i >= 1 and i <= 32:
			bits |= 1 << (i - 1)
	var old: int = node.navigation_layers
	var do := func():
		node.navigation_layers = bits
	var undo := func():
		node.navigation_layers = old
	ctx.undo.action("vulcan: nav_layers_set", do, undo)
	return { "ok": true, "result": { "node": String(args.get("node")), "navigation_layers": bits, "undoable": true } }


static func _bake(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("region", "")), ctx)
	if r.has("err"):
		return r.err
	var region: Node = r.node
	var on_thread := bool(args.get("on_thread", true))
	if region is NavigationRegion2D:
		var r2 := region as NavigationRegion2D
		if r2.navigation_polygon == null:
			return ctx.err("BAD_ARGS", "%s has no NavigationPolygon resource" % region.name, "create the region with nav_region_create, or assign one via node_set_property")
		r2.bake_navigation_polygon(on_thread)
		return { "ok": true, "result": { "region": String(args.get("region")), "baking": true, "on_thread": on_thread, "note": "bake is asynchronous when on_thread — re-check with nav_query_path" } }
	if region is NavigationRegion3D:
		var r3 := region as NavigationRegion3D
		if r3.navigation_mesh == null:
			return ctx.err("BAD_ARGS", "%s has no NavigationMesh resource" % region.name, "create the region with nav_region_create, or assign one via node_set_property")
		r3.bake_navigation_mesh(on_thread)
		return { "ok": true, "result": { "region": String(args.get("region")), "baking": true, "on_thread": on_thread, "note": "bake is asynchronous when on_thread — re-check with nav_query_path" } }
	return ctx.err("BAD_TYPE", "%s is a %s, not a NavigationRegion" % [args.get("region"), region.get_class()], "point 'region' at a NavigationRegion2D/3D node")


static func _query_path(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return ctx.err("NO_SCENE", "no scene is being edited", "open or create a scene first (scene_open / scene_create)")
	var from_v = ctx.types.parse(args.get("from"))
	var to_v = ctx.types.parse(args.get("to"))
	var d := String(args.get("map", "")).to_lower()
	if d == "":
		d = "3d" if typeof(from_v) == TYPE_VECTOR3 else "2d"
	var vp := root.get_viewport()
	if vp == null:
		return ctx.err("EDITOR_LIMIT", "the edited scene has no viewport yet", "query during a play session instead (scene_play first)")
	var pts: Array = []
	if d == "2d":
		if typeof(from_v) != TYPE_VECTOR2 or typeof(to_v) != TYPE_VECTOR2:
			return ctx.err("BAD_ARGS", "2d path query needs Vector2 from/to", "e.g. {\"from\": \"Vector2(0, 0)\", \"to\": \"Vector2(200, 100)\"}")
		var w2 := vp.find_world_2d()
		if w2 == null:
			return ctx.err("EDITOR_LIMIT", "no 2D world available in-editor", "query during a play session instead (scene_play first)")
		for p in NavigationServer2D.map_get_path(w2.navigation_map, from_v, to_v, true):
			pts.append([p.x, p.y])
	else:
		if typeof(from_v) != TYPE_VECTOR3 or typeof(to_v) != TYPE_VECTOR3:
			return ctx.err("BAD_ARGS", "3d path query needs Vector3 from/to", "e.g. {\"from\": \"Vector3(0, 0, 0)\", \"to\": \"Vector3(10, 0, 5)\"}")
		var w3 := vp.find_world_3d()
		if w3 == null:
			return ctx.err("EDITOR_LIMIT", "no 3D world available in-editor", "query during a play session instead (scene_play first)")
		for p in NavigationServer3D.map_get_path(w3.navigation_map, from_v, to_v, true):
			pts.append([p.x, p.y, p.z])
	var res := { "points": pts, "count": pts.size() }
	if pts.is_empty():
		res["note"] = "empty path — the editor nav map may be unbaked or unsynced; run nav_bake, or query during a play session"
	return { "ok": true, "result": res }


# --- local helpers ---

static func _add_node_undoable(node: Node, parent: Node, action: String, ctx: MercuryVulcanContext) -> Dictionary:
	var root: Node = ctx.editor.get_edited_scene_root()
	var do := func():
		parent.add_child(node)
		node.owner = root
	var undo := func():
		parent.remove_child(node)
	ctx.undo.action(action, do, undo)
	return { "ok": true, "result": { "added": String(root.get_path_to(node)), "type": node.get_class(), "undoable": true } }


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
