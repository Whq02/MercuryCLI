@tool
class_name MercuryVulcanParticles
# mercury_vulcan — Particle category handlers (static module, no instances).
# Presets are authored for GPU particles (ParticleProcessMaterial); CPU nodes get a
# teaching refusal pointing at particles_material_set (which does set node-level
# properties for CPU particles directly).


static func ops() -> Array:
	return [
		"particles_create", "particles_material_set", "particles_gradient_set",
		"particles_preset_apply", "particles_emit",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"particles_create":
			return _create(args, ctx)
		"particles_material_set":
			return _material_set(args, ctx)
		"particles_gradient_set":
			return _gradient_set(args, ctx)
		"particles_preset_apply":
			return _preset_apply(args, ctx)
		"particles_emit":
			return _emit(args, ctx)
	return ctx.err("UNKNOWN_OP", "particles does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


const _TYPES := {
	"gpu2d": "GPUParticles2D", "gpu3d": "GPUParticles3D",
	"cpu2d": "CPUParticles2D", "cpu3d": "CPUParticles3D",
}


static func _create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var kind := String(args.get("type", "gpu2d")).to_lower()
	if not _TYPES.has(kind):
		return ctx.err("BAD_ARGS", "unknown particles type '%s'" % kind, "one of: gpu2d, gpu3d, cpu2d, cpu3d")
	var r := _resolve(String(args.get("parent", ".")), ctx)
	if r.has("err"):
		return r.err
	var node = ClassDB.instantiate(_TYPES[kind])  # untyped: amount/process_material are subclass props
	node.name = String(args.get("name", _TYPES[kind]))
	if args.has("amount"):
		node.amount = maxi(1, int(args.get("amount")))
	if kind.begins_with("gpu"):
		node.process_material = ParticleProcessMaterial.new()
	var root: Node = ctx.editor.get_edited_scene_root()
	var parent: Node = r.node
	var do := func():
		parent.add_child(node)
		node.owner = root
	var undo := func():
		parent.remove_child(node)
	ctx.undo.action("vulcan: particles_create", do, undo)
	return { "ok": true, "result": { "added": String(root.get_path_to(node)), "type": node.get_class(), "undoable": true } }


static func _material_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("node", "")), ctx)
	if r.has("err"):
		return r.err
	var node = r.node
	var props: Dictionary = ctx.types.parse_dict(args.get("properties", {}))
	if props.is_empty():
		return ctx.err("BAD_ARGS", "properties dict is required", "e.g. {\"gravity\": \"Vector3(0, 98, 0)\", \"spread\": 30, \"initial_velocity_max\": 120}")
	var is_gpu := _is_gpu(node)
	var is_cpu := _is_cpu(node)
	if not is_gpu and not is_cpu:
		return ctx.err("BAD_TYPE", "%s is a %s, not a particles node" % [args.get("node"), node.get_class()], "point 'node' at a GPU/CPUParticles2D/3D node (see scene_tree)")
	var target: Object = node
	var created_mat := false
	if is_gpu:
		target = node.process_material
		if target == null or not (target is ParticleProcessMaterial):
			target = ParticleProcessMaterial.new()
			created_mat = true
	for k in props:
		if not (String(k) in target):
			var kind = "ParticleProcessMaterial" if is_gpu else node.get_class()
			return ctx.err("BAD_ARGS", "%s has no property '%s'" % [kind, k], "common: gravity, spread, initial_velocity_min/max, scale_min/max, damping_min/max, angle_min/max, lifetime is on the NODE (use node_set_property)")
	var old := {}
	if not created_mat:
		for k in props:
			old[k] = target.get(k)
	var mat_obj := target
	var do := func():
		if created_mat:
			node.process_material = mat_obj
		for k in props:
			mat_obj.set(k, props[k])
	var undo := func():
		for k in old:
			mat_obj.set(k, old[k])
		if created_mat:
			node.process_material = null
	ctx.undo.action("vulcan: particles_material_set", do, undo)
	return { "ok": true, "result": { "node": String(args.get("node")), "target": "process_material" if is_gpu else "node", "applied": props.keys(), "undoable": true } }


static func _gradient_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("node", "")), ctx)
	if r.has("err"):
		return r.err
	var node = r.node
	var points = args.get("points")
	if not (points is Array) or points.is_empty():
		return ctx.err("BAD_ARGS", "points array is required", "e.g. [{\"offset\": 0, \"color\": \"#ffffff\"}, {\"offset\": 1, \"color\": \"Color(1, 0, 0, 0)\"}]")
	var grad := Gradient.new()
	var offsets := PackedFloat32Array()
	var colors := PackedColorArray()
	for p in points:
		if not (p is Dictionary) or not p.has("offset") or not p.has("color"):
			return ctx.err("BAD_ARGS", "each point needs offset and color", "e.g. {\"offset\": 0.5, \"color\": \"#ff8800\"}")
		var c = ctx.types.parse(p.get("color"))
		if typeof(c) != TYPE_COLOR:
			return ctx.err("BAD_ARGS", "unparseable color '%s'" % [p.get("color")], "use #rrggbb, #rrggbbaa, or Color(r, g, b, a)")
		offsets.append(clampf(float(p.get("offset")), 0.0, 1.0))
		colors.append(c)
	grad.offsets = offsets
	grad.colors = colors
	if _is_gpu(node):
		var mat = node.process_material
		if mat == null or not (mat is ParticleProcessMaterial):
			return ctx.err("BAD_ARGS", "%s has no ParticleProcessMaterial" % node.name, "run particles_material_set first (it creates one)")
		var tex := GradientTexture1D.new()
		tex.gradient = grad
		var old = mat.color_ramp
		var do := func():
			mat.color_ramp = tex
		var undo := func():
			mat.color_ramp = old
		ctx.undo.action("vulcan: particles_gradient_set", do, undo)
		return { "ok": true, "result": { "node": String(args.get("node")), "points": points.size(), "target": "process_material.color_ramp", "undoable": true } }
	if _is_cpu(node):
		var old_ramp = node.color_ramp
		var do_cpu := func():
			node.color_ramp = grad
		var undo_cpu := func():
			node.color_ramp = old_ramp
		ctx.undo.action("vulcan: particles_gradient_set", do_cpu, undo_cpu)
		return { "ok": true, "result": { "node": String(args.get("node")), "points": points.size(), "target": "color_ramp", "undoable": true } }
	return ctx.err("BAD_TYPE", "%s is a %s, not a particles node" % [args.get("node"), node.get_class()], "point 'node' at a GPU/CPUParticles2D/3D node")


static func _preset_apply(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("node", "")), ctx)
	if r.has("err"):
		return r.err
	var node = r.node
	if _is_cpu(node):
		return ctx.err("UNSUPPORTED", "presets target GPU particles; %s is CPU" % node.name, "use particles_material_set to set CPU node properties directly, or create a gpu2d/gpu3d node")
	if not _is_gpu(node):
		return ctx.err("BAD_TYPE", "%s is a %s, not a particles node" % [args.get("node"), node.get_class()], "point 'node' at a GPUParticles2D/3D node")
	var name := String(args.get("preset", "")).to_lower()
	var preset := _preset(name)
	if preset.is_empty():
		return ctx.err("BAD_ARGS", "unknown preset '%s'" % name, "one of: fire, smoke, sparks, rain, snow, explosion, magic, trail")
	var mat := ParticleProcessMaterial.new()
	for k in preset.material:
		mat.set(k, preset.material[k])
	if preset.has("gradient"):
		var grad := Gradient.new()
		var offsets := PackedFloat32Array()
		var colors := PackedColorArray()
		for p in preset.gradient:
			offsets.append(p[0])
			colors.append(p[1])
		grad.offsets = offsets
		grad.colors = colors
		var tex := GradientTexture1D.new()
		tex.gradient = grad
		mat.color_ramp = tex
	var old_mat = node.process_material
	var old_node := {}
	for k in preset.node:
		old_node[k] = node.get(k)
	var do := func():
		node.process_material = mat
		for k in preset.node:
			node.set(k, preset.node[k])
	var undo := func():
		node.process_material = old_mat
		for k in old_node:
			node.set(k, old_node[k])
	ctx.undo.action("vulcan: particles_preset_apply", do, undo)
	return { "ok": true, "result": { "node": String(args.get("node")), "preset": name, "undoable": true, "note": "presets are tuned 2D-first; scale velocities/gravity for 3D scenes" } }


static func _emit(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("node", "")), ctx)
	if r.has("err"):
		return r.err
	var node = r.node
	if not _is_gpu(node) and not _is_cpu(node):
		return ctx.err("BAD_TYPE", "%s is a %s, not a particles node" % [args.get("node"), node.get_class()], "point 'node' at a GPU/CPUParticles2D/3D node")
	if not args.has("emitting"):
		return ctx.err("BAD_ARGS", "emitting bool is required", "e.g. {\"emitting\": true, \"one_shot\": true}")
	if args.has("one_shot"):
		node.one_shot = bool(args.get("one_shot"))
	node.emitting = bool(args.get("emitting"))
	if node.emitting and node.one_shot:
		node.restart()
	return { "ok": true, "result": { "node": String(args.get("node")), "emitting": node.emitting, "one_shot": node.one_shot } }


# --- authored presets (GPU / ParticleProcessMaterial) ---

static func _preset(name: String) -> Dictionary:
	match name:
		"fire":
			return {
				"node": { "amount": 48, "lifetime": 0.9, "one_shot": false, "explosiveness": 0.0 },
				"material": { "direction": Vector3(0, -1, 0), "spread": 12.0, "gravity": Vector3(0, -60, 0), "initial_velocity_min": 30.0, "initial_velocity_max": 70.0, "scale_min": 0.6, "scale_max": 1.2, "damping_min": 8.0, "damping_max": 16.0 },
				"gradient": [[0.0, Color(1.0, 0.95, 0.6, 1.0)], [0.35, Color(1.0, 0.6, 0.15, 1.0)], [0.8, Color(0.85, 0.2, 0.1, 0.8)], [1.0, Color(0.3, 0.05, 0.02, 0.0)]],
			}
		"smoke":
			return {
				"node": { "amount": 24, "lifetime": 2.4, "one_shot": false, "explosiveness": 0.0 },
				"material": { "direction": Vector3(0, -1, 0), "spread": 20.0, "gravity": Vector3(0, -18, 0), "initial_velocity_min": 8.0, "initial_velocity_max": 22.0, "scale_min": 1.0, "scale_max": 2.4, "damping_min": 2.0, "damping_max": 5.0 },
				"gradient": [[0.0, Color(0.35, 0.35, 0.38, 0.0)], [0.2, Color(0.4, 0.4, 0.42, 0.55)], [1.0, Color(0.55, 0.55, 0.58, 0.0)]],
			}
		"sparks":
			return {
				"node": { "amount": 32, "lifetime": 0.5, "one_shot": false, "explosiveness": 0.15 },
				"material": { "direction": Vector3(0, -1, 0), "spread": 60.0, "gravity": Vector3(0, 240, 0), "initial_velocity_min": 140.0, "initial_velocity_max": 260.0, "scale_min": 0.2, "scale_max": 0.5, "damping_min": 0.0, "damping_max": 4.0 },
				"gradient": [[0.0, Color(1.0, 1.0, 0.85, 1.0)], [0.5, Color(1.0, 0.75, 0.3, 1.0)], [1.0, Color(0.9, 0.4, 0.1, 0.0)]],
			}
		"rain":
			return {
				"node": { "amount": 160, "lifetime": 1.2, "one_shot": false, "explosiveness": 0.0 },
				"material": { "direction": Vector3(0, 1, 0), "spread": 3.0, "gravity": Vector3(0, 640, 0), "initial_velocity_min": 220.0, "initial_velocity_max": 300.0, "scale_min": 0.3, "scale_max": 0.6, "emission_shape": ParticleProcessMaterial.EMISSION_SHAPE_BOX, "emission_box_extents": Vector3(320, 4, 1) },
				"gradient": [[0.0, Color(0.6, 0.7, 0.9, 0.7)], [1.0, Color(0.6, 0.7, 0.95, 0.25)]],
			}
		"snow":
			return {
				"node": { "amount": 90, "lifetime": 5.0, "one_shot": false, "explosiveness": 0.0 },
				"material": { "direction": Vector3(0, 1, 0), "spread": 12.0, "gravity": Vector3(0, 28, 0), "initial_velocity_min": 6.0, "initial_velocity_max": 20.0, "scale_min": 0.25, "scale_max": 0.7, "emission_shape": ParticleProcessMaterial.EMISSION_SHAPE_BOX, "emission_box_extents": Vector3(320, 4, 1) },
				"gradient": [[0.0, Color(1.0, 1.0, 1.0, 0.0)], [0.15, Color(1.0, 1.0, 1.0, 0.95)], [1.0, Color(0.92, 0.95, 1.0, 0.0)]],
			}
		"explosion":
			return {
				"node": { "amount": 64, "lifetime": 0.8, "one_shot": true, "explosiveness": 1.0 },
				"material": { "direction": Vector3(0, 0, 0), "spread": 180.0, "gravity": Vector3(0, 90, 0), "initial_velocity_min": 160.0, "initial_velocity_max": 340.0, "scale_min": 0.5, "scale_max": 1.4, "damping_min": 30.0, "damping_max": 80.0 },
				"gradient": [[0.0, Color(1.0, 0.98, 0.8, 1.0)], [0.25, Color(1.0, 0.65, 0.2, 1.0)], [0.7, Color(0.7, 0.25, 0.08, 0.7)], [1.0, Color(0.25, 0.22, 0.2, 0.0)]],
			}
		"magic":
			return {
				"node": { "amount": 40, "lifetime": 1.6, "one_shot": false, "explosiveness": 0.0 },
				"material": { "direction": Vector3(0, -1, 0), "spread": 45.0, "gravity": Vector3(0, -30, 0), "initial_velocity_min": 20.0, "initial_velocity_max": 60.0, "orbit_velocity_min": 0.25, "orbit_velocity_max": 0.6, "scale_min": 0.3, "scale_max": 0.8 },
				"gradient": [[0.0, Color(0.7, 0.5, 1.0, 0.0)], [0.3, Color(0.65, 0.45, 1.0, 1.0)], [0.7, Color(0.35, 0.8, 1.0, 0.9)], [1.0, Color(0.3, 0.9, 1.0, 0.0)]],
			}
		"trail":
			return {
				"node": { "amount": 24, "lifetime": 0.6, "one_shot": false, "explosiveness": 0.0 },
				"material": { "direction": Vector3(0, 0, 0), "spread": 6.0, "gravity": Vector3(0, 0, 0), "initial_velocity_min": 0.0, "initial_velocity_max": 6.0, "scale_min": 0.4, "scale_max": 0.9, "damping_min": 4.0, "damping_max": 10.0 },
				"gradient": [[0.0, Color(1.0, 1.0, 1.0, 0.9)], [1.0, Color(1.0, 1.0, 1.0, 0.0)]],
			}
	return {}


# --- local helpers ---

static func _is_gpu(node) -> bool:
	return node is GPUParticles2D or node is GPUParticles3D


static func _is_cpu(node) -> bool:
	return node is CPUParticles2D or node is CPUParticles3D


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
