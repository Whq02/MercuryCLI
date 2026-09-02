@tool
class_name MercuryVulcanNode
extends RefCounted
# VULCAN category: node — reads, structural edits (add/delete/duplicate/move/
# rename), property sets, signals and groups on the EDITED scene. Every
# mutate op is one UndoRedo step; node_call_method is the exec-class op.

const MAX_CHILDREN_LISTED := 50
const MAX_PROPERTIES := 300

static func ops() -> Array:
	return [
		"node_get", "node_get_properties", "node_add", "node_delete",
		"node_duplicate", "node_move", "node_rename", "node_set_property",
		"node_call_method", "node_signal_list", "node_signal_connect",
		"node_signal_disconnect", "node_group_add", "node_group_remove",
	]

static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"node_get": return _get_info(args, ctx)
		"node_get_properties": return _get_properties(args, ctx)
		"node_add": return _add(args, ctx)
		"node_delete": return _delete(args, ctx)
		"node_duplicate": return _duplicate(args, ctx)
		"node_move": return _move(args, ctx)
		"node_rename": return _rename(args, ctx)
		"node_set_property": return _set_property(args, ctx)
		"node_call_method": return _call_method(args, ctx)
		"node_signal_list": return _signal_list(args, ctx)
		"node_signal_connect": return _signal_connect(args, ctx)
		"node_signal_disconnect": return _signal_disconnect(args, ctx)
		"node_group_add": return _group_add(args, ctx)
		"node_group_remove": return _group_remove(args, ctx)
	return ctx.err("UNKNOWN_OP", "node does not own \"%s\"" % op,
		"registry routing bug; report it")

static func _get_info(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var root := ctx.scene_root()
	var groups: Array = []
	for g in node.get_groups():
		var gs := String(g)
		if not gs.begins_with("_"):
			groups.append(gs)
	var kids: Array = []
	for c in node.get_children():
		kids.append({"name": String(c.name), "type": c.get_class()})
		if kids.size() >= MAX_CHILDREN_LISTED:
			break
	var script_path := ""
	var s = node.get_script()
	if s != null and s is Resource:
		script_path = s.resource_path
	return ctx.ok({
		"name": String(node.name),
		"type": node.get_class(),
		"path": "." if node == root else String(root.get_path_to(node)),
		"script": script_path,
		"groups": groups,
		"children": kids,
		"child_count": node.get_child_count(),
	})

static func _get_properties(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var filter := String(args.get("filter", "")).to_lower()
	var out := {}
	var total := 0
	for prop in node.get_property_list():
		var usage := int(prop.get("usage", 0))
		if usage & (PROPERTY_USAGE_CATEGORY | PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP):
			continue
		if not (usage & PROPERTY_USAGE_EDITOR):
			continue
		var prop_name := String(prop.get("name", ""))
		if prop_name.is_empty():
			continue
		if not filter.is_empty() and not prop_name.to_lower().contains(filter):
			continue
		total += 1
		if out.size() < MAX_PROPERTIES:
			out[prop_name] = ctx.types.to_jsonable(node.get(prop_name))
	return ctx.ok({"properties": out, "total": total, "truncated": total > out.size()})

static func _add(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var parent_path := String(args.get("parent", ""))
	if parent_path.is_empty():
		return ctx.err("MISSING_ARG", "parent is required",
			"pass parent: a NodePath in the edited scene (\".\" is the scene root)")
	var parent := ctx.find_node(parent_path)
	if parent == null:
		return ctx.node_not_found(parent_path)
	var type := String(args.get("type", "")).strip_edges()
	if type.is_empty():
		return ctx.err("MISSING_ARG", "type is required",
			"pass type: a Node class, e.g. Sprite2D or CharacterBody3D")
	if not ClassDB.class_exists(type) or not ClassDB.is_parent_class(type, "Node") \
			or not ClassDB.can_instantiate(type):
		return ctx.err("BAD_TYPE", "\"%s\" is not an instantiable Node class" % type,
			"e.g. Sprite2D, CharacterBody2D, MeshInstance3D; check the exact class name")
	var node: Node = ClassDB.instantiate(type)
	var node_name := String(args.get("name", "")).strip_edges()
	if not node_name.is_empty():
		node.name = node_name
	var props := {}
	if typeof(args.get("properties")) == TYPE_DICTIONARY:
		props = ctx.types.parse_dict(args.get("properties"))
	var root := ctx.scene_root()
	var do_add := func() -> void:
		parent.add_child(node, true)
		node.owner = root
		for k in props:
			node.set(String(k), props[k])
	var undo_add := func() -> void:
		parent.remove_child(node)
	ctx.undo.action("vulcan: node_add", do_add, undo_add, node, null)
	return ctx.ok({"node": String(root.get_path_to(node)), "type": type, "undoable": true})

static func _delete(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var root := ctx.scene_root()
	if node == root:
		return ctx.err("CANT_DELETE_ROOT", "the scene root cannot be deleted",
			"delete the scene file instead (scene_delete), or add a new root via scene_create")
	var parent := node.get_parent()
	var index := node.get_index()
	var owner_pairs: Array = []
	_collect_owners(node, owner_pairs)
	var deleted_path := String(root.get_path_to(node))
	var do_del := func() -> void:
		parent.remove_child(node)
	var undo_del := func() -> void:
		parent.add_child(node)
		parent.move_child(node, index)
		for pair in owner_pairs:
			pair[0].owner = pair[1]
	ctx.undo.action("vulcan: node_delete", do_del, undo_del, null, node)
	return ctx.ok({"deleted": deleted_path, "undoable": true})

static func _duplicate(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var root := ctx.scene_root()
	if node == root:
		return ctx.err("CANT_DUPLICATE_ROOT", "the scene root cannot be duplicated in place",
			"duplicate the scene file instead (resource_duplicate), or duplicate a child")
	var parent := node.get_parent()
	var dup := node.duplicate()
	var dup_name := String(args.get("name", "")).strip_edges()
	if not dup_name.is_empty():
		dup.name = dup_name
	var do_dup := func() -> void:
		parent.add_child(dup, true)
		_own_subtree(dup, root)
	var undo_dup := func() -> void:
		parent.remove_child(dup)
	ctx.undo.action("vulcan: node_duplicate", do_dup, undo_dup, dup, null)
	return ctx.ok({"node": String(root.get_path_to(dup)), "undoable": true})

static func _move(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var root := ctx.scene_root()
	if node == root:
		return ctx.err("CANT_MOVE_ROOT", "the scene root cannot be reparented",
			"move a child node instead")
	var new_parent_path := String(args.get("new_parent", ""))
	if new_parent_path.is_empty():
		return ctx.err("MISSING_ARG", "new_parent is required",
			"pass new_parent: the destination NodePath (\".\" is the scene root); use index alone via new_parent = the current parent")
	var new_parent := ctx.find_node(new_parent_path)
	if new_parent == null:
		return ctx.node_not_found(new_parent_path)
	if new_parent == node or node.is_ancestor_of(new_parent):
		return ctx.err("CYCLE", "cannot move a node into its own subtree",
			"pick a destination outside \"%s\"" % String(root.get_path_to(node)))
	var index := int(args.get("index", -1))
	var old_parent := node.get_parent()
	var old_index := node.get_index()
	var owner_pairs: Array = []
	_collect_owners(node, owner_pairs)
	var do_move := func() -> void:
		old_parent.remove_child(node)
		new_parent.add_child(node)
		if index >= 0 and index < new_parent.get_child_count():
			new_parent.move_child(node, index)
		for pair in owner_pairs:
			pair[0].owner = pair[1]
	var undo_move := func() -> void:
		new_parent.remove_child(node)
		old_parent.add_child(node)
		old_parent.move_child(node, old_index)
		for pair in owner_pairs:
			pair[0].owner = pair[1]
	ctx.undo.action("vulcan: node_move", do_move, undo_move)
	return ctx.ok({"node": String(root.get_path_to(node)), "undoable": true})

static func _rename(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var new_name := String(args.get("name", "")).strip_edges()
	if new_name.is_empty():
		return ctx.err("MISSING_ARG", "name is required",
			"pass name: the new node name")
	var old_name := String(node.name)
	var root := ctx.scene_root()
	var do_rename := func() -> void:
		node.name = new_name
	var undo_rename := func() -> void:
		node.name = old_name
	ctx.undo.action("vulcan: node_rename", do_rename, undo_rename)
	return ctx.ok({"node": "." if node == root else String(root.get_path_to(node)),
		"was": old_name, "undoable": true})

static func _set_property(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var prop := String(args.get("property", "")).strip_edges()
	if prop.is_empty():
		return ctx.err("MISSING_ARG", "property is required",
			"pass property: a property name (node_get_properties lists them)")
	if not args.has("value"):
		return ctx.err("MISSING_ARG", "value is required",
			"pass value: the new value (smart-parsed, e.g. \"Vector2(100, 200)\" or \"#ff0000\")")
	if not (prop in node):
		var names: Array = []
		for p in node.get_property_list():
			names.append(String(p.get("name", "")))
		return ctx.err("PROPERTY_NOT_FOUND",
			"%s has no property \"%s\"" % [node.get_class(), prop],
			"closest names: %s (node_get_properties lists all)" % [_closest(names, prop, 5)])
	var value = ctx.types.parse(args.get("value"))
	var old = node.get(prop)
	# The optional expect anchor: change-transaction discipline for editor
	# state — a stale read refuses instead of blind-writing over live truth.
	if args.has("expect"):
		var expected = ctx.types.parse(args.get("expect"))
		if not _anchored_equal(old, expected):
			return ctx.err("ANCHOR_MISMATCH",
				"%s.%s is %s, not the expected %s — nothing written" % [node_path, prop, str(ctx.types.to_jsonable(old)), str(ctx.types.to_jsonable(expected))],
				"re-read with node_get_properties and retry with the live value as expect (or drop expect to write unconditionally)")
	var do_set := func() -> void:
		node.set(prop, value)
	var undo_set := func() -> void:
		node.set(prop, old)
	ctx.undo.action("vulcan: node_set_property", do_set, undo_set)
	# Read BACK after the set: Node.set() silently ignores type-mismatched
	# values (an unparseable smart-parse string stays a String) — echoing the
	# intended value would report ok on a no-op.
	var now = node.get(prop)
	var result := {"node": node_path, "property": prop,
		"value": ctx.types.to_jsonable(now), "previous": ctx.types.to_jsonable(old),
		"undoable": true,
		"changed": ctx.types.to_jsonable(now) != ctx.types.to_jsonable(old)}
	if not result["changed"]:
		result["note"] = "the property kept its previous value — if a change was intended, the value may not have parsed to the property's type (node_get_properties shows it)"
	return ctx.ok(result)

static func _call_method(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var method := String(args.get("method", "")).strip_edges()
	if method.is_empty():
		return ctx.err("MISSING_ARG", "method is required",
			"pass method: the method name to call")
	if not node.has_method(method):
		var names: Array = []
		for m in node.get_method_list():
			names.append(String(m.get("name", "")))
		return ctx.err("METHOD_NOT_FOUND",
			"%s has no method \"%s\"" % [node.get_class(), method],
			"closest names: %s" % [_closest(names, method, 5)])
	var call_args: Array = []
	if typeof(args.get("args")) == TYPE_ARRAY:
		for a in args.get("args"):
			call_args.append(ctx.types.parse(a))
	var returned = node.callv(method, call_args)
	return ctx.ok({"node": node_path, "method": method,
		"returned": ctx.types.to_jsonable(returned)})

static func _signal_list(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var root := ctx.scene_root()
	var out: Array = []
	for sig in node.get_signal_list():
		var sig_name := String(sig.get("name", ""))
		var arg_names: Array = []
		for a in sig.get("args", []):
			arg_names.append(String(a.get("name", "")))
		var conns: Array = []
		for c in node.get_signal_connection_list(sig_name):
			var callable: Callable = c.get("callable")
			var target = callable.get_object()
			var target_path := ""
			if target is Node and target.is_inside_tree():
				target_path = String(root.get_path_to(target))
			conns.append({"target": target_path, "method": String(callable.get_method())})
		var entry := {"name": sig_name, "args": arg_names}
		if not conns.is_empty():
			entry["connections"] = conns
		out.append(entry)
	return ctx.ok({"signals": out})

static func _signal_connect(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var sig := String(args.get("signal", "")).strip_edges()
	if sig.is_empty():
		return ctx.err("MISSING_ARG", "signal is required",
			"pass signal: a signal name (node_signal_list shows them)")
	if not node.has_signal(sig):
		var names: Array = []
		for s in node.get_signal_list():
			names.append(String(s.get("name", "")))
		return ctx.err("SIGNAL_NOT_FOUND",
			"%s has no signal \"%s\"" % [node.get_class(), sig],
			"closest names: %s" % [_closest(names, sig, 5)])
	var target_path := String(args.get("target", "")).strip_edges()
	if target_path.is_empty():
		return ctx.err("MISSING_ARG", "target is required",
			"pass target: the NodePath whose method the signal should call (\".\" is the scene root)")
	var target := ctx.find_node(target_path)
	if target == null:
		return ctx.node_not_found(target_path)
	var method := String(args.get("method", "")).strip_edges()
	if method.is_empty():
		return ctx.err("MISSING_ARG", "method is required",
			"pass method: the method on the target to call")
	if not target.has_method(method):
		return ctx.err("METHOD_NOT_FOUND",
			"target %s has no method \"%s\"" % [target_path, method],
			"define it on the target's script first (script_edit), then connect")
	var callable := Callable(target, method)
	if node.is_connected(sig, callable):
		return ctx.err("ALREADY_CONNECTED",
			"\"%s\" is already connected to %s.%s" % [sig, target_path, method],
			"node_signal_list shows current connections")
	var do_conn := func() -> void:
		node.connect(sig, callable, Object.CONNECT_PERSIST)
	var undo_conn := func() -> void:
		if node.is_connected(sig, callable):
			node.disconnect(sig, callable)
	ctx.undo.action("vulcan: node_signal_connect", do_conn, undo_conn)
	return ctx.ok({"signal": sig, "target": target_path, "method": method,
		"persistent": true, "undoable": true})

static func _signal_disconnect(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var sig := String(args.get("signal", "")).strip_edges()
	var target_path := String(args.get("target", "")).strip_edges()
	if target_path.is_empty():
		return ctx.err("MISSING_ARG", "target is required",
			"pass target: the NodePath whose method the signal should call (\".\" is the scene root)")
	var target := ctx.find_node(target_path)
	if target == null:
		return ctx.node_not_found(target_path)
	var method := String(args.get("method", "")).strip_edges()
	var callable := Callable(target, method)
	if sig.is_empty() or method.is_empty() or not node.is_connected(sig, callable):
		return ctx.err("NOT_CONNECTED",
			"\"%s\" is not connected to %s.%s" % [sig, target_path, method],
			"node_signal_list shows current connections")
	var do_disc := func() -> void:
		node.disconnect(sig, callable)
	var undo_disc := func() -> void:
		if not node.is_connected(sig, callable):
			node.connect(sig, callable, Object.CONNECT_PERSIST)
	ctx.undo.action("vulcan: node_signal_disconnect", do_disc, undo_disc)
	return ctx.ok({"signal": sig, "target": target_path, "method": method, "undoable": true})

static func _group_add(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var group := String(args.get("group", "")).strip_edges()
	if group.is_empty():
		return ctx.err("MISSING_ARG", "group is required",
			"pass group: the group name")
	if node.is_in_group(group):
		return ctx.err("ALREADY_IN_GROUP",
			"\"%s\" is already in group \"%s\"" % [node_path, group],
			"node_get lists the node's groups")
	var do_grp := func() -> void:
		node.add_to_group(group, true)
	var undo_grp := func() -> void:
		node.remove_from_group(group)
	ctx.undo.action("vulcan: node_group_add", do_grp, undo_grp)
	return ctx.ok({"node": node_path, "group": group, "persistent": true, "undoable": true})

static func _group_remove(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return _missing_node(ctx)
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var group := String(args.get("group", "")).strip_edges()
	if group.is_empty() or not node.is_in_group(group):
		var groups: Array = []
		for g in node.get_groups():
			var gs := String(g)
			if not gs.begins_with("_"):
				groups.append(gs)
		return ctx.err("NOT_IN_GROUP",
			"\"%s\" is not in group \"%s\"" % [node_path, group],
			"its groups: %s" % [groups])
	var do_grp := func() -> void:
		node.remove_from_group(group)
	var undo_grp := func() -> void:
		node.add_to_group(group, true)
	ctx.undo.action("vulcan: node_group_remove", do_grp, undo_grp)
	return ctx.ok({"node": node_path, "group": group, "undoable": true})

# -- helpers -----------------------------------------------------------------

# Anchor equality: exact for same-typed values, approx across int/float (the
# smart parser yields ints for "250"), never across unrelated types.
static func _anchored_equal(current, expected) -> bool:
	if typeof(current) == typeof(expected):
		if typeof(current) == TYPE_FLOAT:
			return is_equal_approx(current, expected)
		return current == expected
	if typeof(current) in [TYPE_INT, TYPE_FLOAT] and typeof(expected) in [TYPE_INT, TYPE_FLOAT]:
		return is_equal_approx(float(current), float(expected))
	return false


static func _missing_node(ctx: MercuryVulcanContext) -> Dictionary:
	return ctx.err("MISSING_ARG", "node is required",
		"pass node: a NodePath in the edited scene (scene_tree shows paths; \".\" is the root)")

static func _collect_owners(n: Node, out: Array) -> void:
	if n.owner != null:
		out.append([n, n.owner])
	for c in n.get_children():
		_collect_owners(c, out)

static func _own_subtree(n: Node, new_owner: Node) -> void:
	n.owner = new_owner
	if not n.scene_file_path.is_empty():
		return
	for c in n.get_children():
		_own_subtree(c, new_owner)

static func _closest(candidates: Array, to: String, n: int) -> Array:
	var scored: Array = []
	for c in candidates:
		var cs := String(c)
		if cs.is_empty():
			continue
		scored.append([cs.similarity(to), cs])
	scored.sort_custom(func(a, b): return a[0] > b[0])
	var out: Array = []
	for i in range(mini(n, scored.size())):
		out.append(scored[i][1])
	return out
