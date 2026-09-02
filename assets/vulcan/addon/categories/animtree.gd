@tool
class_name MercuryVulcanAnimtree
# categories/animtree.gd -- the animtree_* ops (Mercury VULCAN).
# AnimationTree authoring: state machines and blend trees. Every mutate op is
# one ctx.undo action.

const SWITCH_MODES := {
	"immediate": AnimationNodeStateMachineTransition.SWITCH_MODE_IMMEDIATE,
	"sync": AnimationNodeStateMachineTransition.SWITCH_MODE_SYNC,
	"at_end": AnimationNodeStateMachineTransition.SWITCH_MODE_AT_END,
}

const ADVANCE_MODES := {
	"disabled": AnimationNodeStateMachineTransition.ADVANCE_MODE_DISABLED,
	"enabled": AnimationNodeStateMachineTransition.ADVANCE_MODE_ENABLED,
	"auto": AnimationNodeStateMachineTransition.ADVANCE_MODE_AUTO,
}

const BLEND_TYPES := {
	"blend2": "AnimationNodeBlend2",
	"blend3": "AnimationNodeBlend3",
	"add2": "AnimationNodeAdd2",
	"oneshot": "AnimationNodeOneShot",
	"timescale": "AnimationNodeTimeScale",
}


static func ops() -> Array:
	return [
		"animtree_create", "animtree_state_add", "animtree_state_remove",
		"animtree_transition_add", "animtree_transition_set", "animtree_blend_add",
		"animtree_param_set", "animtree_travel",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if op == "animtree_create":
		return _create(args, ctx)
	var found := _tree_of(args, ctx)
	if found.has("err"):
		return found["err"]
	var tree: AnimationTree = found["node"]
	match op:
		"animtree_state_add":
			return _state_add(tree, args, ctx)
		"animtree_state_remove":
			return _state_remove(tree, args, ctx)
		"animtree_transition_add":
			return _transition_add(tree, args, ctx)
		"animtree_transition_set":
			return _transition_set(tree, args, ctx)
		"animtree_blend_add":
			return _blend_add(tree, args, ctx)
		"animtree_param_set":
			return _param_set(tree, args, ctx)
		"animtree_travel":
			return _travel(tree, args, ctx)
	return ctx.err("UNKNOWN_OP", "the animtree category does not own '%s'" % op, "see MercuryVulcanAnimtree.ops() for the animtree op list")


static func _create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var parent_found := _node(args.get("parent", ""), ctx)
	if parent_found.has("err"):
		return parent_found["err"]
	var parent: Node = parent_found["node"]
	var player_found := _node(args.get("player", ""), ctx)
	if player_found.has("err"):
		return player_found["err"]
	if not (player_found["node"] is AnimationPlayer):
		return ctx.err("NOT_A_PLAYER", "'%s' is not an AnimationPlayer" % str(args.get("player")), "point player at the scene's AnimationPlayer")
	var player: AnimationPlayer = player_found["node"]
	var kind := str(args.get("type", "statemachine"))
	if kind != "statemachine" and kind != "blendtree":
		return ctx.err("BAD_ARG", "type must be statemachine|blendtree", "omit type for a state machine")
	var root: Node = ctx.editor.get_edited_scene_root()
	var tree := AnimationTree.new()
	tree.name = str(args.get("name", "AnimationTree"))
	tree.tree_root = AnimationNodeStateMachine.new() if kind == "statemachine" else AnimationNodeBlendTree.new()
	var do_add := func():
		parent.add_child(tree)
		tree.owner = root
		tree.anim_player = tree.get_path_to(player)
	var undo_add := func():
		if tree.get_parent() == parent:
			parent.remove_child(tree)
	ctx.undo.action("vulcan: animtree_create", do_add, undo_add)
	return { "ok": true, "result": { "created": str(root.get_path_to(tree)), "type": kind, "player": str(args.get("player")) } }


static func _state_add(tree: AnimationTree, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var sm := _sm_of(tree, ctx)
	if sm.has("err"):
		return sm["err"]
	var machine: AnimationNodeStateMachine = sm["sm"]
	var state := str(args.get("state", ""))
	if state == "":
		return ctx.err("BAD_ARG", "state is required", "e.g. {\"tree\": \"AnimationTree\", \"state\": \"walk\", \"animation\": \"walk\"}")
	if machine.has_node(state):
		return ctx.err("ALREADY_EXISTS", "state '%s' already exists" % state, "animtree_state_remove it first, or pick another name")
	var anim_node := AnimationNodeAnimation.new()
	anim_node.animation = StringName(str(args.get("animation", state)))
	var do_add := func():
		machine.add_node(state, anim_node)
	var undo_add := func():
		if machine.has_node(state):
			machine.remove_node(state)
	ctx.undo.action("vulcan: animtree_state_add", do_add, undo_add)
	return { "ok": true, "result": { "state": state, "animation": str(anim_node.animation) } }


static func _state_remove(tree: AnimationTree, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var sm := _sm_of(tree, ctx)
	if sm.has("err"):
		return sm["err"]
	var machine: AnimationNodeStateMachine = sm["sm"]
	var state := str(args.get("state", ""))
	if not machine.has_node(state):
		return _state_not_found(machine, state, ctx)
	var saved_node: AnimationNode = machine.get_node(state)
	var saved_pos: Vector2 = machine.get_node_position(state)
	var saved_transitions := []
	for i in machine.get_transition_count():
		var from := str(machine.get_transition_from(i))
		var to := str(machine.get_transition_to(i))
		if from == state or to == state:
			saved_transitions.append({ "from": from, "to": to, "t": machine.get_transition(i) })
	var do_remove := func():
		machine.remove_node(state)
	var undo_remove := func():
		machine.add_node(state, saved_node, saved_pos)
		for st in saved_transitions:
			machine.add_transition(st["from"], st["to"], st["t"])
	ctx.undo.action("vulcan: animtree_state_remove", do_remove, undo_remove)
	return { "ok": true, "result": { "removed": state, "transitions_removed": saved_transitions.size() } }


static func _transition_add(tree: AnimationTree, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var sm := _sm_of(tree, ctx)
	if sm.has("err"):
		return sm["err"]
	var machine: AnimationNodeStateMachine = sm["sm"]
	var from := str(args.get("from", ""))
	var to := str(args.get("to", ""))
	for state in [from, to]:
		if not machine.has_node(state):
			return _state_not_found(machine, state, ctx)
	if machine.has_transition(from, to):
		return ctx.err("ALREADY_EXISTS", "a transition %s -> %s already exists" % [from, to], "animtree_transition_set tunes it")
	var t := AnimationNodeStateMachineTransition.new()
	var do_add := func():
		machine.add_transition(from, to, t)
	var undo_add := func():
		if machine.has_transition(from, to):
			machine.remove_transition(from, to)
	ctx.undo.action("vulcan: animtree_transition_add", do_add, undo_add)
	return { "ok": true, "result": { "from": from, "to": to } }


static func _transition_set(tree: AnimationTree, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var sm := _sm_of(tree, ctx)
	if sm.has("err"):
		return sm["err"]
	var machine: AnimationNodeStateMachine = sm["sm"]
	var from := str(args.get("from", ""))
	var to := str(args.get("to", ""))
	var t: AnimationNodeStateMachineTransition = null
	for i in machine.get_transition_count():
		if str(machine.get_transition_from(i)) == from and str(machine.get_transition_to(i)) == to:
			t = machine.get_transition(i)
			break
	if t == null:
		return ctx.err("TRANSITION_NOT_FOUND", "no transition %s -> %s" % [from, to], "animtree_transition_add creates it first")
	var prop := str(args.get("property", ""))
	var raw = args.get("value")
	var value = null
	match prop:
		"xfade_time":
			value = float(ctx.types.parse(raw))
		"switch_mode":
			if not SWITCH_MODES.has(str(raw)):
				return ctx.err("BAD_ARG", "switch_mode must be immediate|sync|at_end", "e.g. {\"property\": \"switch_mode\", \"value\": \"sync\"}")
			value = SWITCH_MODES[str(raw)]
		"advance_condition":
			value = StringName(str(raw))
		"advance_mode":
			if not ADVANCE_MODES.has(str(raw)):
				return ctx.err("BAD_ARG", "advance_mode must be disabled|enabled|auto", "e.g. {\"property\": \"advance_mode\", \"value\": \"auto\"}")
			value = ADVANCE_MODES[str(raw)]
		_:
			return ctx.err("BAD_ARG", "property must be xfade_time|switch_mode|advance_condition|advance_mode", "pick one of the four tunables")
	var prev = t.get(prop)
	var do_set := func():
		t.set(prop, value)
	var undo_set := func():
		t.set(prop, prev)
	ctx.undo.action("vulcan: animtree_transition_set", do_set, undo_set)
	return { "ok": true, "result": { "from": from, "to": to, "property": prop, "value": str(value) } }


static func _blend_add(tree: AnimationTree, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if not (tree.tree_root is AnimationNodeBlendTree):
		return ctx.err("NOT_A_BLENDTREE", "this AnimationTree's root is %s, not a blend tree" % (tree.tree_root.get_class() if tree.tree_root != null else "(unset)"), "animtree_create with type:'blendtree', or use the state machine ops")
	var bt: AnimationNodeBlendTree = tree.tree_root
	var node_name := str(args.get("name", ""))
	if node_name == "":
		return ctx.err("BAD_ARG", "name is required", "the blend node's name inside the tree, e.g. \"walk_run_blend\"")
	if bt.has_node(node_name):
		return ctx.err("ALREADY_EXISTS", "blend-tree node '%s' already exists" % node_name, "pick another name")
	var kind := str(args.get("type", ""))
	if not BLEND_TYPES.has(kind):
		return ctx.err("BAD_ARG", "type must be one of %s" % ", ".join(PackedStringArray(BLEND_TYPES.keys())), "e.g. {\"type\": \"blend2\"}")
	var blend_node: AnimationNode = ClassDB.instantiate(BLEND_TYPES[kind])
	var inputs = args.get("inputs", [])
	if typeof(inputs) != TYPE_ARRAY:
		inputs = []
	var input_names := []
	for i in inputs.size():
		input_names.append("%s_in_%d" % [node_name, i])
	var do_add := func():
		bt.add_node(node_name, blend_node, Vector2(400, 200))
		for i in inputs.size():
			var an := AnimationNodeAnimation.new()
			an.animation = StringName(str(inputs[i]))
			bt.add_node(input_names[i], an, Vector2(100, 200 + i * 120))
			bt.connect_node(node_name, i, input_names[i])
	var undo_add := func():
		for i in inputs.size():
			if bt.has_node(input_names[i]):
				bt.remove_node(input_names[i])
		if bt.has_node(node_name):
			bt.remove_node(node_name)
	ctx.undo.action("vulcan: animtree_blend_add", do_add, undo_add)
	return { "ok": true, "result": { "added": node_name, "type": kind, "inputs": input_names } }


static func _param_set(tree: AnimationTree, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var parameter := str(args.get("parameter", ""))
	if not parameter.begins_with("parameters/"):
		return ctx.err("BAD_ARG", "parameter must be a parameters/... path", "e.g. {\"parameter\": \"parameters/blend_amount\", \"value\": 0.5}")
	var exists := false
	for pd in tree.get_property_list():
		if str(pd["name"]) == parameter:
			exists = true
			break
	if not exists:
		var params := []
		for pd in tree.get_property_list():
			if str(pd["name"]).begins_with("parameters/") and not str(pd["name"]).ends_with("/playback"):
				params.append(str(pd["name"]))
		return ctx.err("PARAM_NOT_FOUND", "no parameter '%s' on this AnimationTree" % parameter,
			"parameters: %s" % (", ".join(PackedStringArray(params)) if params.size() > 0 else "(none exposed yet -- is tree_root set up?)"))
	var value = ctx.types.parse(args.get("value"))
	var prev = tree.get(parameter)
	var do_set := func():
		tree.set(parameter, value)
	var undo_set := func():
		tree.set(parameter, prev)
	ctx.undo.action("vulcan: animtree_param_set", do_set, undo_set)
	return { "ok": true, "result": { "parameter": parameter, "value": str(tree.get(parameter)) } }


static func _travel(tree: AnimationTree, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var to_state := str(args.get("to_state", ""))
	var playback = tree.get("parameters/playback")
	if playback == null or not (playback is AnimationNodeStateMachinePlayback):
		return ctx.err("NOT_A_STATE_MACHINE", "this AnimationTree has no state-machine playback", "animtree_travel needs a statemachine root (animtree_create type:'statemachine')")
	var sm := _sm_of(tree, ctx)
	if not sm.has("err"):
		var machine: AnimationNodeStateMachine = sm["sm"]
		if not machine.has_node(to_state):
			return _state_not_found(machine, to_state, ctx)
	playback.travel(to_state)
	var note := ""
	if not tree.active:
		note = "tree.active is false -- enable it (animtree_param_set cannot; use node_set_property active=true) for the travel to process"
	return { "ok": true, "result": { "traveled_to": to_state, "active": tree.active, "note": note } }


# -- helpers --

static func _tree_of(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var tv := str(args.get("tree", ""))
	if tv == "":
		return { "err": ctx.err("BAD_ARG", "tree is required", "pass the AnimationTree's NodePath") }
	var found := _node(tv, ctx)
	if found.has("err"):
		return found
	if not (found["node"] is AnimationTree):
		return { "err": ctx.err("NOT_AN_ANIMTREE", "'%s' is a %s, not an AnimationTree" % [tv, found["node"].get_class()], "animtree_create adds one") }
	return found


static func _sm_of(tree: AnimationTree, ctx: MercuryVulcanContext) -> Dictionary:
	if tree.tree_root == null or not (tree.tree_root is AnimationNodeStateMachine):
		return { "err": ctx.err("NOT_A_STATE_MACHINE", "this AnimationTree's root is %s" % (tree.tree_root.get_class() if tree.tree_root != null else "(unset)"), "state ops need a statemachine root (animtree_create type:'statemachine')") }
	return { "sm": tree.tree_root }


static func _state_not_found(machine: AnimationNodeStateMachine, state: String, ctx: MercuryVulcanContext) -> Dictionary:
	# AnimationNodeStateMachine has no public node-list API; report via transitions.
	var names := []
	var seen := {}
	for i in machine.get_transition_count():
		seen[str(machine.get_transition_from(i))] = true
		seen[str(machine.get_transition_to(i))] = true
	names = seen.keys()
	return ctx.err("STATE_NOT_FOUND", "no state '%s' in the state machine" % state,
		"states seen in transitions: %s (animtree_state_add creates states)" % (", ".join(PackedStringArray(names)) if names.size() > 0 else "(none known)"))


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
