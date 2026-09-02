@tool
class_name MercuryVulcanScene
extends RefCounted
# VULCAN category: scene — tree reads, create/open/save/delete/instance
# (UndoRedo-wrapped; file-level undo restores the previous bytes on disk),
# and the exec-class play controls (scene_play / scene_stop).

const MAX_TREE_DEPTH := 100

static func ops() -> Array:
	return [
		"scene_tree", "scene_current", "scene_create", "scene_open",
		"scene_save", "scene_delete", "scene_instance", "scene_play",
		"scene_stop",
	]

static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"scene_tree": return _tree(args, ctx)
		"scene_current": return _current(ctx)
		"scene_create": return _create(args, ctx)
		"scene_open": return _open(args, ctx)
		"scene_save": return _save(args, ctx)
		"scene_delete": return _delete(args, ctx)
		"scene_instance": return _instance(args, ctx)
		"scene_play": return _play(args, ctx)
		"scene_stop": return _stop(ctx)
	return ctx.err("UNKNOWN_OP", "scene does not own \"%s\"" % op,
		"registry routing bug; report it")

static func _tree(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var depth := int(args.get("depth", 0))
	if depth <= 0:
		depth = MAX_TREE_DEPTH
	var raw_path := String(args.get("path", "")).strip_edges()
	var root: Node = null
	var temp := false
	if raw_path.is_empty():
		root = ctx.scene_root()
		if root == null:
			return ctx.err("NO_SCENE", "no scene is open in the editor",
				"open one with scene_open, create one with scene_create, or pass path: res://…tscn")
	else:
		var p: String = ctx.paths.require_res(raw_path)
		if p.is_empty():
			return ctx.paths.last_error
		if not ResourceLoader.exists(p):
			return ctx.err("FILE_NOT_FOUND", "no scene file at %s" % p,
				"search with project_file_search pattern *.tscn")
		var packed = load(p)
		if packed == null or not (packed is PackedScene):
			return ctx.err("NOT_A_SCENE", "%s did not load as a PackedScene" % p,
				"pass a .tscn/.scn path")
		root = packed.instantiate(PackedScene.GEN_EDIT_STATE_DISABLED)
		temp = true
	var tree := _describe(root, depth)
	if temp:
		root.free()
	return ctx.ok(tree)

static func _current(ctx: MercuryVulcanContext) -> Dictionary:
	var open: Array = []
	for s in ctx.editor.get_open_scenes():
		open.append(String(s))
	var root := ctx.scene_root()
	var edited = null
	if root != null:
		edited = {
			"root": String(root.name),
			"type": root.get_class(),
			"path": root.scene_file_path,
			"saved_to_disk": root.scene_file_path != "",
		}
	return ctx.ok({"edited": edited, "open_scenes": open,
		"playing": ctx.editor.is_playing_scene()})

static func _create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var p: String = ctx.paths.require_res(args.get("path", ""))
	if p.is_empty():
		return ctx.paths.last_error
	if not (p.ends_with(".tscn") or p.ends_with(".scn")):
		return ctx.err("BAD_ARG", "scene path must end in .tscn or .scn",
			"e.g. res://scenes/level_1.tscn")
	if FileAccess.file_exists(p):
		return ctx.err("FILE_EXISTS", "%s already exists" % p,
			"scene_open it, or pick a new path")
	var root_type := String(args.get("root_type", "Node")).strip_edges()
	if root_type.is_empty():
		root_type = "Node"
	if not ClassDB.class_exists(root_type) or not ClassDB.is_parent_class(root_type, "Node") \
			or not ClassDB.can_instantiate(root_type):
		return ctx.err("BAD_TYPE", "\"%s\" is not an instantiable Node class" % root_type,
			"use a class like Node2D, Node3D or Control")
	var root_name := String(args.get("root_name", "")).strip_edges()
	if root_name.is_empty():
		root_name = p.get_file().get_basename().to_pascal_case()
	var editor = ctx.editor
	var do_create := func() -> void:
		var root: Node = ClassDB.instantiate(root_type)
		root.name = root_name
		var packed := PackedScene.new()
		packed.pack(root)
		var dir := p.get_base_dir()
		if not DirAccess.dir_exists_absolute(dir):
			DirAccess.make_dir_recursive_absolute(dir)
		ResourceSaver.save(packed, p)
		root.free()
		editor.get_resource_filesystem().scan()
		editor.open_scene_from_path(p)
	var undo_create := func() -> void:
		if FileAccess.file_exists(p):
			DirAccess.remove_absolute(p)
		editor.get_resource_filesystem().scan()
	ctx.undo.action("vulcan: scene_create", do_create, undo_create)
	return ctx.ok({"path": p, "root_type": root_type, "root_name": root_name,
		"opened": true, "undoable": true})

static func _open(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var p: String = ctx.paths.require_res(args.get("path", ""))
	if p.is_empty():
		return ctx.paths.last_error
	if not ResourceLoader.exists(p):
		return ctx.err("FILE_NOT_FOUND", "no scene file at %s" % p,
			"search with project_file_search pattern *.tscn, or scene_create it")
	var prev := ""
	var prev_root := ctx.scene_root()
	if prev_root != null:
		prev = prev_root.scene_file_path
	var editor = ctx.editor
	var do_open := func() -> void:
		editor.open_scene_from_path(p)
	var undo_open := func() -> void:
		if prev != "":
			editor.open_scene_from_path(prev)
	ctx.undo.action("vulcan: scene_open", do_open, undo_open)
	return ctx.ok({"path": p, "undoable": true})

static func _save(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var root := ctx.scene_root()
	if root == null:
		return ctx.err("NO_SCENE", "no scene is open in the editor",
			"open one with scene_open or create one with scene_create")
	var target := ""
	if String(args.get("path", "")).strip_edges() != "":
		target = ctx.paths.require_res(args.get("path"))
		if target.is_empty():
			return ctx.paths.last_error
		if not (target.ends_with(".tscn") or target.ends_with(".scn")):
			return ctx.err("BAD_ARG", "save-as path must end in .tscn or .scn",
				"e.g. res://scenes/level_1.tscn")
	var effective := target if target != "" else root.scene_file_path
	if effective.is_empty():
		return ctx.err("NO_PATH", "the edited scene was never saved and no path was given",
			"pass path: res://…tscn to save-as")
	var existed := FileAccess.file_exists(effective)
	var old_bytes := PackedByteArray()
	if existed:
		var f := FileAccess.open(effective, FileAccess.READ)
		if f != null:
			old_bytes = f.get_buffer(f.get_length())
	var save_as := target != "" and target != root.scene_file_path
	var editor = ctx.editor
	var do_save := func() -> void:
		if save_as:
			editor.save_scene_as(target)
		else:
			editor.save_scene()
	var undo_save := func() -> void:
		if existed:
			var w := FileAccess.open(effective, FileAccess.WRITE)
			if w != null:
				w.store_buffer(old_bytes)
		elif FileAccess.file_exists(effective):
			DirAccess.remove_absolute(effective)
		editor.get_resource_filesystem().scan()
	ctx.undo.action("vulcan: scene_save", do_save, undo_save)
	return ctx.ok({"path": effective, "save_as": save_as, "undoable": true,
		"note": "undo restores the previous file bytes on disk; the editor scene keeps its in-memory state"})

static func _delete(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var p: String = ctx.paths.require_res(args.get("path", ""))
	if p.is_empty():
		return ctx.paths.last_error
	if not FileAccess.file_exists(p):
		return ctx.err("FILE_NOT_FOUND", "no scene file at %s" % p,
			"search with project_file_search pattern *.tscn")
	for open_path in ctx.editor.get_open_scenes():
		if String(open_path) == p:
			return ctx.err("SCENE_OPEN", "%s is open in the editor" % p,
				"switch to another scene first (scene_open), then delete")
	var f := FileAccess.open(p, FileAccess.READ)
	if f == null:
		return ctx.err("IO_ERROR", "cannot read %s before deleting it" % p,
			"check file permissions")
	var old_bytes := f.get_buffer(f.get_length())
	f = null
	var editor = ctx.editor
	var do_delete := func() -> void:
		DirAccess.remove_absolute(p)
		editor.get_resource_filesystem().scan()
	var undo_delete := func() -> void:
		var w := FileAccess.open(p, FileAccess.WRITE)
		if w != null:
			w.store_buffer(old_bytes)
		editor.get_resource_filesystem().scan()
	ctx.undo.action("vulcan: scene_delete", do_delete, undo_delete)
	return ctx.ok({"path": p, "deleted": true, "undoable": true,
		"note": "undo rewrites the file bytes"})

static func _instance(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var sp: String = ctx.paths.require_res(args.get("scene", ""))
	if sp.is_empty():
		return ctx.paths.last_error
	if not ResourceLoader.exists(sp):
		return ctx.err("FILE_NOT_FOUND", "no scene file at %s" % sp,
			"search with project_file_search pattern *.tscn")
	var packed = load(sp)
	if packed == null or not (packed is PackedScene):
		return ctx.err("NOT_A_SCENE", "%s did not load as a PackedScene" % sp,
			"pass a .tscn/.scn path")
	var parent_path := String(args.get("parent", "")).strip_edges()
	if parent_path.is_empty():
		return ctx.err("MISSING_ARG", "parent is required",
			"pass parent: the NodePath to instance under (\".\" is the scene root)")
	var parent := ctx.find_node(parent_path)
	if parent == null:
		return ctx.node_not_found(parent_path)
	var root := ctx.scene_root()
	if root != null and root.scene_file_path == sp:
		return ctx.err("CYCLE", "cannot instance a scene into itself",
			"instance %s into a different scene" % sp)
	var inst: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	var inst_name := String(args.get("name", "")).strip_edges()
	if not inst_name.is_empty():
		inst.name = inst_name
	var do_add := func() -> void:
		parent.add_child(inst, true)
		inst.owner = root
	var undo_add := func() -> void:
		parent.remove_child(inst)
	ctx.undo.action("vulcan: scene_instance", do_add, undo_add, inst, null)
	return ctx.ok({"node": String(root.get_path_to(inst)), "scene": sp, "undoable": true})

static func _play(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var scene := String(args.get("scene", "main")).strip_edges()
	if scene.is_empty():
		scene = "main"
	var editor = ctx.editor
	if editor.is_playing_scene():
		return ctx.err("ALREADY_PLAYING", "a play session is already running",
			"scene_stop it first, or drive it with the runtime_* ops")
	match scene:
		"main":
			var main := String(ProjectSettings.get_setting("application/run/main_scene", ""))
			if main.is_empty():
				return ctx.err("NO_MAIN_SCENE", "the project has no main scene",
					"pass scene: \"current\" or a res://…tscn path, or set application/run/main_scene")
			editor.play_main_scene()
		"current":
			if ctx.scene_root() == null:
				return ctx.err("NO_SCENE", "no scene is open to play",
					"scene_open one first, or pass scene: \"main\" / a res://…tscn path")
			editor.play_current_scene()
		_:
			var p: String = ctx.paths.require_res(scene)
			if p.is_empty():
				return ctx.paths.last_error
			if not ResourceLoader.exists(p):
				return ctx.err("FILE_NOT_FOUND", "no scene file at %s" % p,
					"search with project_file_search pattern *.tscn")
			editor.play_custom_scene(p)
	return ctx.ok({"playing": true, "scene": scene,
		"note": "runtime_* ops attach once the play-mode bridge connects; breakpoint debugging lives in the Debug tool's godot adapter"})

static func _stop(ctx: MercuryVulcanContext) -> Dictionary:
	if not ctx.editor.is_playing_scene():
		return ctx.err("NOT_PLAYING", "no play session is running",
			"scene_play starts one")
	ctx.editor.stop_playing_scene()
	return ctx.ok({"playing": false})

static func _describe(n: Node, depth: int, top := true) -> Dictionary:
	var d := {"name": String(n.name), "type": n.get_class()}
	var s = n.get_script()
	if s != null and s is Resource and s.resource_path != "":
		d["script"] = s.resource_path
	if not top and not n.scene_file_path.is_empty():
		d["instance_of"] = n.scene_file_path
	if n.get_child_count() > 0:
		if depth > 1:
			var kids := []
			for c in n.get_children():
				kids.append(_describe(c, depth - 1, false))
			d["children"] = kids
		else:
			d["children_count"] = n.get_child_count()
	return d
