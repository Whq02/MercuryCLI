@tool
class_name MercuryVulcanPhysics
# mercury_vulcan — Physics category handlers (static module, no instances).
# physics_raycast / physics_query DESIGN CHOICE (documented per the writer contract):
# they run against the edited scene's viewport worlds (find_world_2d/3d →
# direct_space_state) on the editor main thread while physics is NOT stepping.
# That is the safe in-editor window — but results reflect the last physics-server
# sync, so a just-moved (unsaved) collider can read stale. When the space state is
# unavailable, they return EDITOR_LIMIT pointing at runtime ops during a play session.


static func ops() -> Array:
	return [
		"physics_body_create", "physics_shape_add", "physics_area_create",
		"physics_layers_set", "physics_raycast", "physics_query",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"physics_body_create":
			return _body_create(args, ctx)
		"physics_shape_add":
			return _shape_add(args, ctx)
		"physics_area_create":
			return _area_create(args, ctx)
		"physics_layers_set":
			return _layers_set(args, ctx)
		"physics_raycast":
			return _raycast(args, ctx)
		"physics_query":
			return _query(args, ctx)
	return ctx.err("UNKNOWN_OP", "physics does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


const _BODY_TYPES := [
	"StaticBody2D", "RigidBody2D", "CharacterBody2D",
	"StaticBody3D", "RigidBody3D", "CharacterBody3D",
]


static func _body_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var kind := String(args.get("type", ""))
	if not _BODY_TYPES.has(kind):
		return ctx.err("BAD_ARGS", "unknown body type '%s'" % kind, "one of: %s" % ", ".join(_BODY_TYPES))
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var node: Node = ClassDB.instantiate(kind)
	node.name = String(args.get("name", kind))
	return _add_node_undoable(node, r.node, "vulcan: physics_body_create", ctx)


static func _shape_add(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("body", "")), ctx)
	if r.has("err"):
		return r.err
	var body: Node = r.node
	var is_2d := body is Node2D
	var is_3d := body is Node3D
	if not is_2d and not is_3d:
		return ctx.err("BAD_TYPE", "%s is a %s — not a 2D/3D node" % [args.get("body"), body.get_class()], "point 'body' at a PhysicsBody/Area node")
	var kind := String(args.get("shape", "")).to_lower()
	var size = ctx.types.parse(args.get("size")) if args.has("size") else null
	var shape = null  # untyped: subclass-specific size/radius props
	var shape3 = null
	match kind:
		"rectangle":
			shape = RectangleShape2D.new()
			if typeof(size) == TYPE_VECTOR2:
				shape.size = size
			elif size != null:
				shape.size = Vector2(float(size), float(size))
		"circle":
			shape = CircleShape2D.new()
			if size != null:
				shape.radius = float(size)
		"capsule":
			if is_2d:
				shape = CapsuleShape2D.new()
				if typeof(size) == TYPE_VECTOR2:
					shape.radius = size.x
					shape.height = size.y
				elif size != null:
					shape.radius = float(size)
			else:
				shape3 = CapsuleShape3D.new()
				if typeof(size) == TYPE_VECTOR2:
					shape3.radius = size.x
					shape3.height = size.y
				elif size != null:
					shape3.radius = float(size)
		"box":
			shape3 = BoxShape3D.new()
			if typeof(size) == TYPE_VECTOR3:
				shape3.size = size
			elif size != null:
				shape3.size = Vector3(float(size), float(size), float(size))
		"sphere":
			shape3 = SphereShape3D.new()
			if size != null:
				shape3.radius = float(size)
		"cylinder":
			shape3 = CylinderShape3D.new()
			if typeof(size) == TYPE_VECTOR2:
				shape3.radius = size.x
				shape3.height = size.y
			elif size != null:
				shape3.radius = float(size)
		_:
			return ctx.err("BAD_ARGS", "unknown shape '%s'" % kind, "2D: rectangle, circle, capsule · 3D: box, sphere, cylinder, capsule")
	if is_2d and shape == null:
		return ctx.err("BAD_ARGS", "'%s' is a 3D shape but %s is 2D" % [kind, body.name], "use rectangle, circle, or capsule for 2D bodies")
	if is_3d and shape3 == null:
		return ctx.err("BAD_ARGS", "'%s' is a 2D shape but %s is 3D" % [kind, body.name], "use box, sphere, cylinder, or capsule for 3D bodies")
	var cs = null
	if is_2d:
		cs = CollisionShape2D.new()
		cs.shape = shape
	else:
		cs = CollisionShape3D.new()
		cs.shape = shape3
	cs.name = String(args.get("name", "CollisionShape_%s" % kind))
	return _add_node_undoable(cs, body, "vulcan: physics_shape_add", ctx)


static func _area_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var kind := String(args.get("type", "Area2D"))
	if kind != "Area2D" and kind != "Area3D":
		return ctx.err("BAD_ARGS", "type must be Area2D or Area3D", "got '%s'" % kind)
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var node: Node = ClassDB.instantiate(kind)
	node.name = String(args.get("name", kind))
	return _add_node_undoable(node, r.node, "vulcan: physics_area_create", ctx)


static func _layers_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("node", "")), ctx)
	if r.has("err"):
		return r.err
	var node = r.node  # untyped: collision_layer/mask live on CollisionObject subclasses
	if not ("collision_layer" in node):
		return ctx.err("BAD_TYPE", "%s (%s) has no collision layers" % [args.get("node"), node.get_class()], "point 'node' at a PhysicsBody, Area, or CollisionObject node")
	if not args.has("layers") and not args.has("masks"):
		return ctx.err("BAD_ARGS", "pass layers and/or masks", "arrays of layer numbers 1..32, e.g. {\"layers\": [1, 3]}")
	var old_layer: int = node.collision_layer
	var old_mask: int = node.collision_mask
	var new_layer := _mask_bits(args.get("layers")) if args.has("layers") else old_layer
	var new_mask := _mask_bits(args.get("masks")) if args.has("masks") else old_mask
	var do := func():
		node.collision_layer = new_layer
		node.collision_mask = new_mask
	var undo := func():
		node.collision_layer = old_layer
		node.collision_mask = old_mask
	ctx.undo.action("vulcan: physics_layers_set", do, undo)
	return { "ok": true, "result": { "node": String(args.get("node")), "collision_layer": new_layer, "collision_mask": new_mask, "undoable": true } }


static func _raycast(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var from_v = ctx.types.parse(args.get("from"))
	var to_v = ctx.types.parse(args.get("to"))
	var space := String(args.get("space", "")).to_lower()
	if space == "":
		space = "3d" if typeof(from_v) == TYPE_VECTOR3 else "2d"
	if space == "2d" and (typeof(from_v) != TYPE_VECTOR2 or typeof(to_v) != TYPE_VECTOR2):
		return ctx.err("BAD_ARGS", "2d raycast needs Vector2 from/to", "e.g. {\"from\": \"Vector2(0, 0)\", \"to\": \"Vector2(100, 0)\"}")
	if space == "3d" and (typeof(from_v) != TYPE_VECTOR3 or typeof(to_v) != TYPE_VECTOR3):
		return ctx.err("BAD_ARGS", "3d raycast needs Vector3 from/to", "e.g. {\"from\": \"Vector3(0, 1, 0)\", \"to\": \"Vector3(0, -10, 0)\"}")
	var dss = _space_state(space, ctx)
	if dss is Dictionary:
		return dss
	var hit: Dictionary = {}
	if space == "2d":
		var q := PhysicsRayQueryParameters2D.create(from_v, to_v)
		q.collide_with_areas = bool(args.get("collide_with_areas", false))
		hit = dss.intersect_ray(q)
	else:
		var q3 := PhysicsRayQueryParameters3D.create(from_v, to_v)
		q3.collide_with_areas = bool(args.get("collide_with_areas", false))
		hit = dss.intersect_ray(q3)
	if hit.is_empty():
		return { "ok": true, "result": { "hit": false, "note": "editor-space query — results reflect the last physics sync; for live gameplay use runtime ops during a play session" } }
	return { "ok": true, "result": {
		"hit": true,
		"position": _vec(hit.get("position")),
		"normal": _vec(hit.get("normal")),
		"collider": _collider_info(hit.get("collider"), ctx),
	} }


static func _query(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var space := String(args.get("space", "2d")).to_lower()
	var pos = ctx.types.parse(args.get("position"))
	var size = ctx.types.parse(args.get("size")) if args.has("size") else 10.0
	var kind := String(args.get("shape", "circle")).to_lower()
	var dss = _space_state(space, ctx)
	if dss is Dictionary:
		return dss
	var hits: Array = []
	if space == "2d":
		if typeof(pos) != TYPE_VECTOR2:
			return ctx.err("BAD_ARGS", "2d query needs a Vector2 position", "e.g. {\"position\": \"Vector2(100, 50)\"}")
		var shape = null
		if kind == "box":
			shape = RectangleShape2D.new()
			shape.size = size if typeof(size) == TYPE_VECTOR2 else Vector2(float(size), float(size))
		else:
			shape = CircleShape2D.new()
			shape.radius = float(size) if typeof(size) != TYPE_VECTOR2 else size.x
		var p := PhysicsShapeQueryParameters2D.new()
		p.shape = shape
		p.transform = Transform2D(0.0, pos)
		p.collide_with_areas = true
		if args.has("collision_mask"):
			p.collision_mask = _mask_bits(args.get("collision_mask")) if args.get("collision_mask") is Array else int(args.get("collision_mask"))
		for h in dss.intersect_shape(p, 32):
			hits.append(_collider_info(h.get("collider"), ctx))
	else:
		if typeof(pos) != TYPE_VECTOR3:
			return ctx.err("BAD_ARGS", "3d query needs a Vector3 position", "e.g. {\"position\": \"Vector3(0, 1, 0)\"}")
		var shape3 = null
		match kind:
			"box":
				shape3 = BoxShape3D.new()
				shape3.size = size if typeof(size) == TYPE_VECTOR3 else Vector3(float(size), float(size), float(size))
			"sphere", "circle":
				shape3 = SphereShape3D.new()
				shape3.radius = float(size) if typeof(size) != TYPE_VECTOR3 else size.x
			_:
				return ctx.err("BAD_ARGS", "unknown 3d query shape '%s'" % kind, "one of: sphere, box")
		var p3 := PhysicsShapeQueryParameters3D.new()
		p3.shape = shape3
		p3.transform = Transform3D(Basis.IDENTITY, pos)
		p3.collide_with_areas = true
		if args.has("collision_mask"):
			p3.collision_mask = _mask_bits(args.get("collision_mask")) if args.get("collision_mask") is Array else int(args.get("collision_mask"))
		for h in dss.intersect_shape(p3, 32):
			hits.append(_collider_info(h.get("collider"), ctx))
	return { "ok": true, "result": { "count": hits.size(), "colliders": hits, "note": "editor-space query — reflects the last physics sync" } }


# --- local helpers ---

static func _space_state(space: String, ctx: MercuryVulcanContext):
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return ctx.err("NO_SCENE", "no scene is being edited", "open or create a scene first (scene_open / scene_create)")
	var vp := root.get_viewport()
	if vp == null:
		return ctx.err("EDITOR_LIMIT", "the edited scene has no viewport yet", "use runtime ops during a play session (scene_play first)")
	if space == "2d":
		var w2 := vp.find_world_2d()
		if w2 == null or w2.direct_space_state == null:
			return ctx.err("EDITOR_LIMIT", "no 2D physics space available in-editor", "use runtime ops during a play session (scene_play first)")
		return w2.direct_space_state
	var w3 := vp.find_world_3d()
	if w3 == null or w3.direct_space_state == null:
		return ctx.err("EDITOR_LIMIT", "no 3D physics space available in-editor", "use runtime ops during a play session (scene_play first)")
	return w3.direct_space_state


static func _collider_info(obj, ctx: MercuryVulcanContext) -> Dictionary:
	if obj == null or not is_instance_valid(obj):
		return { "class": "unknown" }
	var info := { "class": obj.get_class(), "name": String(obj.name) if obj is Node else "" }
	var root: Node = ctx.editor.get_edited_scene_root()
	if obj is Node and root != null and root.is_ancestor_of(obj):
		info["path"] = String(root.get_path_to(obj))
	return info


static func _vec(v):
	match typeof(v):
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [v.x, v.y]
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return [v.x, v.y, v.z]
	return v


static func _mask_bits(nums) -> int:
	var m := 0
	if nums is Array:
		for n in nums:
			var i := int(n)
			if i >= 1 and i <= 32:
				m |= 1 << (i - 1)
	return m


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
