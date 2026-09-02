@tool
class_name MercuryVulcanBatch
# mercury_vulcan — Batch/Refactor category handlers (static module, no instances).
#
# Scene-reach model (documented per the writer contract):
#   · the CURRENT edited scene → mutated LIVE, ONE ctx.undo action per op (Ctrl+Z works)
#   · scenes open in OTHER editor tabs → SKIPPED and reported ("open_skipped") —
#     EditorInterface only exposes the current tab's tree; rewriting their files under
#     the editor would clobber unsaved tab state
#   · CLOSED scenes → loaded (GEN_EDIT_STATE_MAIN), mutated, repacked + saved to disk
#     ("rewritten") — NOT undoable via Ctrl+Z; use git to revert
# Non-current scene READS reflect the file on disk, not unsaved tab edits.
# batch_replace_type does not migrate signal connections on replaced nodes (reported).
# batch_rename_resource rewrites textual references (.tscn/.tres/.gd) and moves
# .import/.uid sidecars; embedded uids stay valid; binary .res/.scn refs are reported
# for manual follow-up, not rewritten.


const _MAX_SCENES := 500
const _MAX_MATCHES := 500


static func ops() -> Array:
	return [
		"batch_find_by_type", "batch_find_by_property", "batch_dependencies",
		"batch_reverse_dependencies", "batch_set_property", "batch_replace_type",
		"batch_rename_resource", "batch_cross_scene_update",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"batch_find_by_type":
			return _find_by_type(args, ctx)
		"batch_find_by_property":
			return _find_by_property(args, ctx)
		"batch_dependencies":
			return _dependencies(args, ctx)
		"batch_reverse_dependencies":
			return _reverse_dependencies(args, ctx)
		"batch_set_property":
			return _set_property(args, ctx)
		"batch_replace_type":
			return _replace_type(args, ctx)
		"batch_rename_resource":
			return _rename_resource(args, ctx)
		"batch_cross_scene_update":
			return _cross_scene_update(args, ctx)
	return ctx.err("UNKNOWN_OP", "batch does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


# --- reads ---

static func _find_by_type(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var type := String(args.get("type", ""))
	if type == "":
		return ctx.err("BAD_ARGS", "type is required", "a node class, e.g. {\"type\": \"Sprite2D\"}")
	var pred := func(node: Node) -> bool:
		return node.is_class(type)
	return _find(args, ctx, pred)


static func _find_by_property(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var prop := String(args.get("property", ""))
	if prop == "":
		return ctx.err("BAD_ARGS", "property is required", "e.g. {\"property\": \"visible\", \"value\": false}")
	var want_value := args.has("value")
	var value = ctx.types.parse(args.get("value")) if want_value else null
	var pred := func(node: Node) -> bool:
		if not (prop in node):
			return false
		if not want_value:
			return true
		return node.get(prop) == value
	return _find(args, ctx, pred)


static func _find(args: Dictionary, ctx: MercuryVulcanContext, pred: Callable) -> Dictionary:
	var scenes := _scene_files(String(args.get("scenes", "*")))
	if scenes.size() > _MAX_SCENES:
		return ctx.err("TOO_LARGE", "%d scenes match (cap %d)" % [scenes.size(), _MAX_SCENES], "narrow the scenes glob")
	var current := _current_scene_path(ctx)
	var matches: Array = []
	var scanned := 0
	for path in scenes:
		scanned += 1
		var root: Node = null
		var temp := false
		if path == current:
			root = ctx.editor.get_edited_scene_root()
		else:
			root = _instantiate(path)
			temp = true
		if root == null:
			continue
		var stack: Array = [root]
		while not stack.is_empty():
			var n: Node = stack.pop_back()
			if pred.call(n):
				matches.append({ "scene": path, "node": String(root.get_path_to(n)) if n != root else ".", "class": n.get_class(), "name": String(n.name) })
				if matches.size() >= _MAX_MATCHES:
					break
			for c in n.get_children():
				stack.append(c)
		if temp:
			root.free()
		if matches.size() >= _MAX_MATCHES:
			break
	return { "ok": true, "result": { "scenes_scanned": scanned, "count": matches.size(), "matches": matches, "truncated": matches.size() >= _MAX_MATCHES, "note": "non-current scenes are read from disk — unsaved tab edits are not visible" } }


static func _dependencies(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var path: String = ctx.paths.require_res(String(args.get("path", "")))
	if path == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative scene/resource", "e.g. res://scenes/level_1.tscn")
	if not ResourceLoader.exists(path):
		return ctx.err("NOT_FOUND", "no resource at %s" % path, "check with project_file_search")
	var deps: Array = []
	for d in ResourceLoader.get_dependencies(path):
		deps.append(_dep_path(String(d)))
	return { "ok": true, "result": { "path": path, "count": deps.size(), "dependencies": deps } }


static func _reverse_dependencies(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var target: String = ctx.paths.require_res(String(args.get("path", "")))
	if target == "":
		return ctx.err("BAD_PATH", "path must be a res://-relative scene/resource", "e.g. res://sprites/player.png")
	var hits := _referencing_files(target)
	return { "ok": true, "result": { "path": target, "count": hits.resources.size() + hits.scripts.size(), "resources": hits.resources, "script_mentions": hits.scripts, "note": "resources found via get_dependencies; scripts via literal-path text scan (preload/load)" } }


# --- mutates ---

static func _set_property(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var type := String(args.get("type", ""))
	var prop := String(args.get("property", ""))
	if type == "" or prop == "" or not args.has("value"):
		return ctx.err("BAD_ARGS", "type, property, and value are required", "e.g. {\"type\": \"Label\", \"property\": \"visible\", \"value\": true}")
	var value = ctx.types.parse(args.get("value"))
	var planner := func(n: Node) -> Dictionary:
		if not (prop in n):
			return {}
		return { "property": prop, "old": n.get(prop), "new": value }
	return _apply_across(String(args.get("scenes", "*")), type, ctx, "vulcan: batch_set_property", planner)


static func _cross_scene_update(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var scenes := String(args.get("scenes", ""))
	if scenes == "":
		return ctx.err("BAD_ARGS", "scenes glob is required", "e.g. {\"scenes\": \"res://levels/*.tscn\", \"property\": \"modulate\", \"value\": \"#ffffff\"}")
	var prop := String(args.get("property", ""))
	if prop == "" or not args.has("value"):
		return ctx.err("BAD_ARGS", "property and value are required", "e.g. {\"property\": \"scale\", \"value\": \"Vector2(2, 2)\"}")
	var type := String(args.get("type", ""))
	var value = ctx.types.parse(args.get("value"))
	var planner := func(n: Node) -> Dictionary:
		if not (prop in n):
			return {}
		return { "property": prop, "old": n.get(prop), "new": value }
	return _apply_across(scenes, type, ctx, "vulcan: batch_cross_scene_update", planner)


# One engine for property updates across scenes. planner(node) returns
# {property, old, new} to change the node, or {} to skip it.
static func _apply_across(scenes_glob: String, type_filter: String, ctx: MercuryVulcanContext, action: String, planner: Callable) -> Dictionary:
	var scenes := _scene_files(scenes_glob)
	if scenes.is_empty():
		return ctx.err("NOT_FOUND", "no scenes match '%s'" % scenes_glob, "check with project_file_search pattern *.tscn")
	if scenes.size() > _MAX_SCENES:
		return ctx.err("TOO_LARGE", "%d scenes match (cap %d)" % [scenes.size(), _MAX_SCENES], "narrow the scenes glob")
	var current := _current_scene_path(ctx)
	var open := _open_scene_paths(ctx)
	var fs = ctx.editor.get_resource_filesystem()
	var live_changed := 0
	var rewritten: Array = []
	var open_skipped: Array = []
	var total_nodes := 0
	for path in scenes:
		if path == current:
			var root: Node = ctx.editor.get_edited_scene_root()
			if root == null:
				continue
			var plan: Array = []
			for n in _walk(root, type_filter):
				var change: Dictionary = planner.call(n)
				if not change.is_empty():
					plan.append([n, change.property, change.old, change.new])
			if plan.is_empty():
				continue
			var do := func():
				for row in plan:
					row[0].set(row[1], row[3])
			var undo := func():
				for row in plan:
					row[0].set(row[1], row[2])
			ctx.undo.action(action, do, undo)
			live_changed += plan.size()
			total_nodes += plan.size()
		elif open.has(path):
			open_skipped.append(path)
		else:
			var root2 := _instantiate(path)
			if root2 == null:
				continue
			var touched := 0
			for n in _walk(root2, type_filter):
				var change: Dictionary = planner.call(n)
				if not change.is_empty():
					n.set(change.property, change.new)
					touched += 1
			if touched > 0:
				var packed := PackedScene.new()
				if packed.pack(root2) == OK and ResourceSaver.save(packed, path) == OK:
					rewritten.append(path)
					total_nodes += touched
					if fs != null:
						fs.update_file(path)
			root2.free()
	return { "ok": true, "result": {
		"nodes_changed": total_nodes,
		"current_scene_changes": live_changed,
		"undoable": live_changed > 0,
		"rewritten": rewritten,
		"open_skipped": open_skipped,
		"note": "current scene changes are one Ctrl+Z step; rewritten files are DISK writes (revert via git); open tabs were skipped to protect unsaved state",
	} }


static func _replace_type(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var from_type := String(args.get("from_type", ""))
	var to_type := String(args.get("to_type", ""))
	if from_type == "" or to_type == "":
		return ctx.err("BAD_ARGS", "from_type and to_type are required", "e.g. {\"from_type\": \"Sprite2D\", \"to_type\": \"AnimatedSprite2D\"}")
	if not ClassDB.class_exists(to_type) or not ClassDB.can_instantiate(to_type):
		return ctx.err("BAD_ARGS", "cannot instantiate '%s'" % to_type, "check the exact class name; abstract classes cannot be targets")
	var scenes := _scene_files(String(args.get("scenes", "*")))
	if scenes.size() > _MAX_SCENES:
		return ctx.err("TOO_LARGE", "%d scenes match (cap %d)" % [scenes.size(), _MAX_SCENES], "narrow the scenes glob")
	var current := _current_scene_path(ctx)
	var open := _open_scene_paths(ctx)
	var fs = ctx.editor.get_resource_filesystem()
	var rewritten: Array = []
	var open_skipped: Array = []
	var replaced := 0
	for path in scenes:
		if path == current:
			var root: Node = ctx.editor.get_edited_scene_root()
			if root == null:
				continue
			var targets: Array = []
			for n in _walk(root, from_type):
				if n != root:
					targets.append(n)
			if targets.is_empty():
				continue
			var pairs: Array = []
			var new_nodes: Array = []
			var old_nodes: Array = []
			for old_node in targets:
				var fresh := _build_replacement(old_node, to_type)
				pairs.append([old_node, fresh])
				new_nodes.append(fresh)
				old_nodes.append(old_node)
			var do := func():
				for pair in pairs:
					_swap(pair[0], pair[1], root)
			var undo := func():
				var i := pairs.size() - 1
				while i >= 0:
					_swap(pairs[i][1], pairs[i][0], root)
					i -= 1
			# References keep the swapped-out side owned by the undo history
			# (purged history frees them) instead of leaking editor orphans.
			ctx.undo.action("vulcan: batch_replace_type", do, undo, new_nodes, old_nodes)
			replaced += pairs.size()
		elif open.has(path):
			open_skipped.append(path)
		else:
			var root2 := _instantiate(path)
			if root2 == null:
				continue
			var targets2: Array = []
			for n in _walk(root2, from_type):
				if n != root2:
					targets2.append(n)
			if targets2.is_empty():
				root2.free()
				continue
			for old_node in targets2:
				_swap(old_node, _build_replacement(old_node, to_type), root2)
				old_node.free()
			var packed := PackedScene.new()
			if packed.pack(root2) == OK and ResourceSaver.save(packed, path) == OK:
				rewritten.append(path)
				replaced += targets2.size()
				if fs != null:
					fs.update_file(path)
			root2.free()
	return { "ok": true, "result": {
		"replaced": replaced,
		"rewritten": rewritten,
		"open_skipped": open_skipped,
		"undoable": current != "" and not open.has(current),
		"note": "compatible stored properties + groups were copied; SIGNAL CONNECTIONS on replaced nodes are NOT migrated — reconnect with node_signal_connect; scene-root nodes are never replaced",
	} }


static func _rename_resource(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var from: String = ctx.paths.require_res(String(args.get("from", "")))
	var to: String = ctx.paths.require_res(String(args.get("to", "")))
	if from == "" or to == "":
		return ctx.err("BAD_PATH", "from and to must be res://-relative paths", "e.g. {\"from\": \"res://old/sprite.png\", \"to\": \"res://art/sprite.png\"}")
	if not FileAccess.file_exists(from):
		return ctx.err("NOT_FOUND", "no file at %s" % from, "check with project_file_search")
	if FileAccess.file_exists(to):
		return ctx.err("BAD_ARGS", "%s already exists" % to, "pick a free target path")
	var open := _open_scene_paths(ctx)
	if open.has(from) or from == _current_scene_path(ctx):
		return ctx.err("EDITOR_LIMIT", "%s is open in the editor" % from, "close its scene tab first, then retry")
	var refs := _referencing_files(from)
	# Capture pre-rewrite bytes of every text file we will touch (undo = exact restore).
	var text_files: Array = []
	for p in refs.resources + refs.scripts:
		if _is_text_ref(String(p)):
			var f := FileAccess.open(String(p), FileAccess.READ)
			if f != null:
				text_files.append([String(p), f.get_as_text()])
	var binary_refs: Array = []
	for p in refs.resources:
		if not _is_text_ref(String(p)):
			binary_refs.append(p)
	var g_from := ProjectSettings.globalize_path(from)
	var g_to := ProjectSettings.globalize_path(to)
	var sidecars: Array = []
	for ext in [".import", ".uid"]:
		if FileAccess.file_exists(from + ext):
			sidecars.append(ext)
	var fs = ctx.editor.get_resource_filesystem()
	var do := func():
		DirAccess.rename_absolute(g_from, g_to)
		for ext in sidecars:
			DirAccess.rename_absolute(g_from + ext, g_to + ext)
		for row in text_files:
			var w := FileAccess.open(row[0], FileAccess.WRITE)
			if w != null:
				w.store_string(String(row[1]).replace(from, to))
				w.close()
		if fs != null:
			fs.scan()
	var undo := func():
		DirAccess.rename_absolute(g_to, g_from)
		for ext in sidecars:
			DirAccess.rename_absolute(g_to + ext, g_from + ext)
		for row in text_files:
			var w := FileAccess.open(row[0], FileAccess.WRITE)
			if w != null:
				w.store_string(row[1])
				w.close()
		if fs != null:
			fs.scan()
	ctx.undo.action("vulcan: batch_rename_resource", do, undo)
	var updated: Array = []
	for row in text_files:
		updated.append(row[0])
	return { "ok": true, "result": {
		"from": from,
		"to": to,
		"references_updated": updated,
		"sidecars_moved": sidecars,
		"binary_refs_not_rewritten": binary_refs,
		"undoable": true,
		"note": "embedded uid:// references stay valid across the move; binary .res/.scn referencers (if any) need re-saving by hand",
	} }


# --- local helpers ---

static func _current_scene_path(ctx: MercuryVulcanContext) -> String:
	var root: Node = ctx.editor.get_edited_scene_root()
	return root.scene_file_path if root != null else ""


static func _open_scene_paths(ctx: MercuryVulcanContext) -> Array:
	var out: Array = []
	for p in ctx.editor.get_open_scenes():
		out.append(String(p))
	return out


static func _instantiate(path: String) -> Node:
	if not ResourceLoader.exists(path):
		return null
	var ps = load(path)
	if ps == null or not (ps is PackedScene):
		return null
	return ps.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)


static func _walk(root: Node, type_filter: String) -> Array:
	var out: Array = []
	var stack: Array = [root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if type_filter == "" or n.is_class(type_filter):
			out.append(n)
		for c in n.get_children():
			stack.append(c)
	return out


static func _scene_files(glob: String) -> Array:
	var out: Array = []
	var dirs: Array = ["res://"]
	while not dirs.is_empty():
		var dir_path: String = dirs.pop_back()
		var d := DirAccess.open(dir_path)
		if d == null:
			continue
		d.list_dir_begin()
		var entry := d.get_next()
		while entry != "":
			var full := dir_path.path_join(entry)
			if d.current_is_dir():
				if not entry.begins_with(".") and full != "res://.godot":
					dirs.append(full)
			elif entry.ends_with(".tscn"):
				if glob == "" or glob == "*" or full.match(glob) or full.matchn(glob) or entry.match(glob):
					out.append(full)
			entry = d.get_next()
		d.list_dir_end()
	out.sort()
	return out


static func _all_files_with_ext(exts: Array) -> Array:
	var out: Array = []
	var dirs: Array = ["res://"]
	while not dirs.is_empty():
		var dir_path: String = dirs.pop_back()
		var d := DirAccess.open(dir_path)
		if d == null:
			continue
		d.list_dir_begin()
		var entry := d.get_next()
		while entry != "":
			var full := dir_path.path_join(entry)
			if d.current_is_dir():
				if not entry.begins_with(".") and full != "res://.godot":
					dirs.append(full)
			else:
				for ext in exts:
					if entry.ends_with(ext):
						out.append(full)
						break
			entry = d.get_next()
		d.list_dir_end()
	out.sort()
	return out


static func _dep_path(dep: String) -> String:
	# get_dependencies entries can look like "uid://…::res://path" (uid::fallback)
	if dep.contains("::"):
		return dep.get_slice("::", dep.get_slice_count("::") - 1)
	return dep


static func _referencing_files(target: String) -> Dictionary:
	var resources: Array = []
	for p in _all_files_with_ext([".tscn", ".tres", ".res", ".material", ".theme"]):
		if p == target:
			continue
		for d in ResourceLoader.get_dependencies(p):
			if _dep_path(String(d)) == target:
				resources.append(p)
				break
	var scripts: Array = []
	for p in _all_files_with_ext([".gd"]):
		var f := FileAccess.open(p, FileAccess.READ)
		if f != null and f.get_as_text().contains(target):
			scripts.append(p)
	return { "resources": resources, "scripts": scripts }


static func _is_text_ref(path: String) -> bool:
	return path.ends_with(".tscn") or path.ends_with(".tres") or path.ends_with(".gd") or path.ends_with(".material") or path.ends_with(".theme")


static func _build_replacement(old_node: Node, to_type: String) -> Node:
	var fresh: Node = ClassDB.instantiate(to_type)
	fresh.name = old_node.name
	for p in old_node.get_property_list():
		if (int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE) == 0:
			continue
		var pname := String(p.get("name", ""))
		if pname == "" or pname == "script" or pname == "name" or pname == "owner":
			continue
		if pname in fresh:
			fresh.set(pname, old_node.get(pname))
	for g in old_node.get_groups():
		if not String(g).begins_with("_"):
			fresh.add_to_group(g, true)
	return fresh


static func _swap(old_node: Node, new_node: Node, scene_root: Node) -> void:
	var parent := old_node.get_parent()
	if parent == null:
		return
	var index := old_node.get_index()
	var children: Array = []
	for c in old_node.get_children():
		children.append(c)
	for c in children:
		old_node.remove_child(c)
	parent.remove_child(old_node)
	parent.add_child(new_node)
	parent.move_child(new_node, index)
	new_node.owner = scene_root
	for c in children:
		new_node.add_child(c)
		_reown(c, scene_root)


static func _reown(node: Node, scene_root: Node) -> void:
	node.owner = scene_root
	# An instanced sub-scene's INTERNAL children belong to its own packed scene —
	# only recurse into nodes authored in this scene.
	if node.scene_file_path == "":
		for c in node.get_children():
			_reown(c, scene_root)
