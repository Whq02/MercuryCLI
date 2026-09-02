@tool
class_name MercuryVulcanAnalysis
# mercury_vulcan — Analysis category handlers (static module, read-only).
# unused_resources = files under res:// that the dependency CLOSURE seeded from all
# scenes + autoloads (+ literal res:// mentions in scripts) never reaches. Treat the
# list as candidates, not verdicts — paths built at runtime are invisible to it.


static func ops() -> Array:
	return [
		"analysis_complexity", "analysis_signal_flow",
		"analysis_unused_resources", "analysis_orphans",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"analysis_complexity":
			return _complexity(args, ctx)
		"analysis_signal_flow":
			return _signal_flow(args, ctx)
		"analysis_unused_resources":
			return _unused_resources(args, ctx)
		"analysis_orphans":
			return _orphans(args, ctx)
	return ctx.err("UNKNOWN_OP", "analysis does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _complexity(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _scene_root(args, "scene", ctx)
	if got.has("err"):
		return got.err
	var root: Node = got.root
	var by_class := {}
	var total := 0
	var max_depth := 0
	var instanced: Array = []
	var scripted := 0
	var stack: Array = [[root, 0]]
	while not stack.is_empty():
		var row: Array = stack.pop_back()
		var n: Node = row[0]
		var depth: int = row[1]
		total += 1
		max_depth = maxi(max_depth, depth)
		by_class[n.get_class()] = int(by_class.get(n.get_class(), 0)) + 1
		if n != root and n.scene_file_path != "":
			instanced.append({ "node": String(root.get_path_to(n)), "scene": n.scene_file_path })
		if n.get_script() != null:
			scripted += 1
		for c in n.get_children():
			stack.append([c, depth + 1])
	if got.temp:
		root.free()
	return { "ok": true, "result": {
		"scene": got.describe,
		"total_nodes": total,
		"max_depth": max_depth,
		"by_class": by_class,
		"instanced_scenes": instanced,
		"scripted_nodes": scripted,
	} }


static func _signal_flow(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _scene_root(args, "scene", ctx)
	if got.has("err"):
		return got.err
	var root: Node = got.root
	var edges: Array = []
	var stack: Array = [root]
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		for sig in n.get_signal_list():
			var sig_name := String(sig.get("name", ""))
			for conn in n.get_signal_connection_list(sig_name):
				var callable: Callable = conn.get("callable")
				var target = callable.get_object()
				var target_path := "<outside scene>"
				if target is Node and root.is_ancestor_of(target):
					target_path = String(root.get_path_to(target))
				elif target == root:
					target_path = "."
				edges.append({
					"from": String(root.get_path_to(n)) if n != root else ".",
					"signal": sig_name,
					"to": target_path,
					"method": String(callable.get_method()),
					"persistent": (int(conn.get("flags", 0)) & CONNECT_PERSIST) != 0,
				})
				if edges.size() >= 500:
					break
		for c in n.get_children():
			stack.append(c)
	if got.temp:
		root.free()
	return { "ok": true, "result": { "scene": got.describe, "connections": edges, "count": edges.size(), "truncated": edges.size() >= 500 } }


static func _unused_resources(_args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	# Seeds: every scene + every autoload + literal res:// strings in scripts.
	var referenced := {}
	var queue: Array = []
	for p in _files([".tscn"]):
		queue.append(p)
		referenced[p] = true
	for prop in ProjectSettings.get_property_list():
		var pname := String(prop.get("name", ""))
		if pname.begins_with("autoload/"):
			var v := String(ProjectSettings.get_setting(pname)).trim_prefix("*")
			if v.begins_with("res://"):
				queue.append(v)
				referenced[v] = true
	for p in _files([".gd"]):
		referenced[p] = referenced.get(p, false)
		var f := FileAccess.open(p, FileAccess.READ)
		if f == null:
			continue
		var text := f.get_as_text()
		var idx := text.find("res://")
		while idx >= 0:
			var end := idx
			while end < text.length() and not ["\"", "'", ")", "\n", " "].has(text[end]):
				end += 1
			var mention := text.substr(idx, end - idx)
			if mention.length() > 6 and not referenced.get(mention, false):
				referenced[mention] = true
				queue.append(mention)
			idx = text.find("res://", end)
	# Dependency closure.
	var seen := {}
	while not queue.is_empty():
		var p: String = queue.pop_back()
		if seen.get(p, false):
			continue
		seen[p] = true
		if not ResourceLoader.exists(p):
			continue
		for d in ResourceLoader.get_dependencies(p):
			var dep := _dep_path(String(d))
			if not referenced.get(dep, false):
				referenced[dep] = true
				queue.append(dep)
	# Walk the tree for candidate files.
	var unused: Array = []
	var checked := 0
	for p in _files([".tres", ".res", ".tscn", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".ogg", ".wav", ".mp3", ".gdshader", ".material", ".theme", ".ttf", ".otf"]):
		checked += 1
		if p.begins_with("res://addons/"):
			continue
		if not referenced.get(p, false):
			unused.append(p)
			if unused.size() >= 300:
				break
	return { "ok": true, "result": {
		"checked": checked,
		"unused": unused,
		"truncated": unused.size() >= 300,
		"note": "closure-based candidates — paths assembled at runtime (string concat, load(var)) are not detectable; scripts (.gd) and addons/ are excluded from the candidate list",
	} }


static func _orphans(_args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return ctx.err("NO_SCENE", "no scene is being edited", "open or create a scene first (scene_open / scene_create)")
	# Nodes in the edited tree that no owner claims — they will NOT be saved.
	var unsaved: Array = []
	var stack: Array = []
	for c in root.get_children():
		stack.append(c)
	while not stack.is_empty():
		var n: Node = stack.pop_back()
		if n.owner == null:
			unsaved.append({ "node": String(root.get_path_to(n)), "class": n.get_class(), "why": "no owner — will not be saved with the scene" })
		for c in n.get_children():
			stack.append(c)
		if unsaved.size() >= 200:
			break
	var orphan_count := int(Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT))
	return { "ok": true, "result": {
		"unsaved_nodes": unsaved,
		"editor_orphan_node_count": orphan_count,
		"note": "unsaved_nodes = editor-tree nodes missing an owner (a classic silent-loss bug); editor_orphan_node_count is the engine-wide monitor (includes editor internals)",
	} }


# --- local helpers ---

static func _scene_root(args: Dictionary, key: String, ctx: MercuryVulcanContext) -> Dictionary:
	var raw := String(args.get(key, ""))
	if raw == "":
		var root: Node = ctx.editor.get_edited_scene_root()
		if root == null:
			return { "err": ctx.err("NO_SCENE", "no scene is being edited and no scene path was given", "open one, or pass {\"%s\": \"res://…tscn\"}" % key) }
		return { "root": root, "temp": false, "describe": root.scene_file_path if root.scene_file_path != "" else "(unsaved edited scene)" }
	var path: String = ctx.paths.require_res(raw)
	if path == "":
		return { "err": ctx.err("BAD_PATH", "scene must be a res://-relative .tscn path", "e.g. res://scenes/level_1.tscn") }
	var current: Node = ctx.editor.get_edited_scene_root()
	if current != null and current.scene_file_path == path:
		return { "root": current, "temp": false, "describe": path }
	if not ResourceLoader.exists(path):
		return { "err": ctx.err("NOT_FOUND", "no scene at %s" % path, "check with project_file_search pattern *.tscn") }
	var ps = load(path)
	if ps == null or not (ps is PackedScene):
		return { "err": ctx.err("LOAD_FAILED", "%s is not a PackedScene" % path, "is it a valid .tscn?") }
	return { "root": ps.instantiate(PackedScene.GEN_EDIT_STATE_MAIN), "temp": true, "describe": path + " (from disk)" }


static func _files(exts: Array) -> Array:
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
	if dep.contains("::"):
		return dep.get_slice("::", dep.get_slice_count("::") - 1)
	return dep
