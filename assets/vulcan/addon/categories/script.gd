@tool
class_name MercuryVulcanScript
extends RefCounted
# VULCAN category: script — editor-authoritative script acts: read/list/search,
# create/edit (UndoRedo-wrapped via disk-bytes restore), attach/detach, and
# syntax validation. GDScript SYMBOL work (outline, definitions, rename)
# belongs to the LSP tool's mercury-godot lane, not here.

const MAX_FILES := 1000
const MAX_HITS := 200

static func ops() -> Array:
	return [
		"script_read", "script_list", "script_search", "script_create",
		"script_edit", "script_attach", "script_detach", "script_validate",
	]

static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"script_read": return _read(args, ctx)
		"script_list": return _list(ctx)
		"script_search": return _search(args, ctx)
		"script_create": return _create(args, ctx)
		"script_edit": return _edit(args, ctx)
		"script_attach": return _attach(args, ctx)
		"script_detach": return _detach(args, ctx)
		"script_validate": return _validate(args, ctx)
	return ctx.err("UNKNOWN_OP", "script does not own \"%s\"" % op,
		"registry routing bug; report it")

static func _read(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var raw := String(args.get("path", "")).strip_edges()
	if raw.is_empty():
		return ctx.err("MISSING_ARG", "path is required",
			"pass path: res://….gd, or a NodePath whose script to read")
	var p := ""
	if raw.begins_with("res://") or raw.get_extension() == "gd":
		p = ctx.paths.require_res(raw)
		if p.is_empty():
			return ctx.paths.last_error
	else:
		var node := ctx.find_node(raw)
		if node == null:
			return ctx.node_not_found(raw)
		var s = node.get_script()
		if s == null:
			return ctx.err("NO_SCRIPT", "node \"%s\" has no script" % raw,
				"attach one with script_attach, or create one with script_create {attach_to}")
		if s.resource_path.is_empty():
			return ctx.ok({"path": "", "builtin": true, "source": s.source_code})
		p = s.resource_path
	if not FileAccess.file_exists(p):
		return ctx.err("FILE_NOT_FOUND", "no script at %s" % p,
			"script_list shows the project's scripts")
	var f := FileAccess.open(p, FileAccess.READ)
	if f == null:
		return ctx.err("IO_ERROR", "cannot read %s" % p, "check file permissions")
	return ctx.ok({"path": p, "source": f.get_as_text()})

static func _list(ctx: MercuryVulcanContext) -> Dictionary:
	var files: Array = []
	_walk_gd("res://", files)
	var attached := {}
	var root := ctx.scene_root()
	if root != null:
		_collect_attachments(root, root, attached)
	var out: Array = []
	for p in files:
		var row := {"path": p}
		if attached.has(p):
			row["attached_in_edited_scene"] = attached[p]
		out.append(row)
	return ctx.ok({"scripts": out, "count": out.size(),
		"truncated": files.size() >= MAX_FILES,
		"note": "attachments are listed for the edited scene only"})

static func _search(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var query := String(args.get("query", ""))
	if query.strip_edges().is_empty():
		return ctx.err("MISSING_ARG", "query is required",
			"pass query: text or a regex to search script sources for")
	var scope := "res://"
	if String(args.get("path", "")).strip_edges() != "":
		scope = ctx.paths.require_res(args.get("path"))
		if scope.is_empty():
			return ctx.paths.last_error
	var files: Array = []
	if scope.get_extension() == "gd":
		if not FileAccess.file_exists(scope):
			return ctx.err("FILE_NOT_FOUND", "no script at %s" % scope,
				"script_list shows the project's scripts")
		files = [scope]
	else:
		_walk_gd(scope, files)
	var re := RegEx.new()
	var use_re := re.compile(query) == OK
	var hits: Array = []
	var truncated := false
	for path in files:
		var f := FileAccess.open(path, FileAccess.READ)
		if f == null:
			continue
		var lineno := 0
		while not f.eof_reached():
			var line := f.get_line()
			lineno += 1
			var hit := false
			if use_re:
				hit = re.search(line) != null
			else:
				hit = line.contains(query)
			if hit:
				hits.append({"path": path, "line": lineno, "text": line.substr(0, 300)})
				if hits.size() >= MAX_HITS:
					truncated = true
					break
		if truncated:
			break
	return ctx.ok({"matches": hits, "regex": use_re, "truncated": truncated})

static func _create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var p: String = ctx.paths.require_res(args.get("path", ""))
	if p.is_empty():
		return ctx.paths.last_error
	if p.get_extension() != "gd":
		return ctx.err("BAD_ARG", "script path must end in .gd",
			"e.g. res://scripts/player.gd")
	if FileAccess.file_exists(p):
		return ctx.err("FILE_EXISTS", "%s already exists" % p,
			"script_edit changes an existing script")
	var attach_path := String(args.get("attach_to", "")).strip_edges()
	var target: Node = null
	if not attach_path.is_empty():
		target = ctx.find_node(attach_path)
		if target == null:
			return ctx.node_not_found(attach_path)
	var base := String(args.get("extends", "")).strip_edges()
	if base.is_empty():
		base = target.get_class() if target != null else "Node"
	var content := String(args.get("content", ""))
	if content.is_empty():
		content = "extends %s\n\n\nfunc _ready() -> void:\n\tpass\n" % base
	var old_script = target.get_script() if target != null else null
	var editor = ctx.editor
	var do_create := func() -> void:
		var dir := p.get_base_dir()
		if not DirAccess.dir_exists_absolute(dir):
			DirAccess.make_dir_recursive_absolute(dir)
		var w := FileAccess.open(p, FileAccess.WRITE)
		if w != null:
			w.store_string(content)
		w = null
		editor.get_resource_filesystem().scan()
		if target != null:
			var s = load(p)
			if s != null:
				target.set_script(s)
	var undo_create := func() -> void:
		if target != null:
			target.set_script(old_script)
		if FileAccess.file_exists(p):
			DirAccess.remove_absolute(p)
		editor.get_resource_filesystem().scan()
	ctx.undo.action("vulcan: script_create", do_create, undo_create)
	return ctx.ok({"path": p, "attached_to": attach_path, "undoable": true})

static func _edit(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var p: String = ctx.paths.require_res(args.get("path", ""))
	if p.is_empty():
		return ctx.paths.last_error
	if not FileAccess.file_exists(p):
		return ctx.err("FILE_NOT_FOUND", "no script at %s" % p,
			"script_create makes a new one")
	var f := FileAccess.open(p, FileAccess.READ)
	if f == null:
		return ctx.err("IO_ERROR", "cannot read %s" % p, "check file permissions")
	var old_source := f.get_as_text()
	f = null
	var new_source := ""
	var replaced := 0
	if String(args.get("content", "")) != "":
		new_source = String(args.get("content"))
	elif args.has("find"):
		var find := String(args.get("find", ""))
		if find.is_empty():
			return ctx.err("MISSING_ARG", "find must not be empty",
				"pass find: exact text present in the script, plus replace")
		if not old_source.contains(find):
			return ctx.err("FIND_NOT_FOUND",
				"the find text does not occur in %s" % p,
				"script_read it and pass the exact text (whitespace matters)")
		replaced = old_source.count(find)
		new_source = old_source.replace(find, String(args.get("replace", "")))
	else:
		return ctx.err("MISSING_ARG", "pass content (full replacement) or find/replace",
			"content: the whole new source, or find: exact text + replace: new text")
	var editor = ctx.editor
	var do_edit := func() -> void:
		_write_and_refresh(p, new_source, editor)
	var undo_edit := func() -> void:
		_write_and_refresh(p, old_source, editor)
	ctx.undo.action("vulcan: script_edit", do_edit, undo_edit)
	var result := {"path": p, "undoable": true}
	if replaced > 0:
		result["replaced_occurrences"] = replaced
	return ctx.ok(result)

static func _attach(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return ctx.err("MISSING_ARG", "node is required",
			"pass node: a NodePath in the edited scene (scene_tree shows paths; \".\" is the root)")
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var p: String = ctx.paths.require_res(args.get("path", ""))
	if p.is_empty():
		return ctx.paths.last_error
	if not FileAccess.file_exists(p):
		return ctx.err("FILE_NOT_FOUND", "no script at %s" % p,
			"script_list shows the project's scripts; script_create makes one")
	var script = load(p)
	if script == null or not (script is Script):
		return ctx.err("NOT_A_SCRIPT", "%s did not load as a Script" % p,
			"pass a .gd script path")
	var base := String(script.get_instance_base_type())
	if not base.is_empty() and not ClassDB.is_parent_class(node.get_class(), base):
		return ctx.err("TYPE_MISMATCH",
			"%s extends %s, but the node is a %s" % [p, base, node.get_class()],
			"attach it to a %s, or change the script's extends line" % base)
	var old_script = node.get_script()
	var do_attach := func() -> void:
		node.set_script(script)
	var undo_attach := func() -> void:
		node.set_script(old_script)
	ctx.undo.action("vulcan: script_attach", do_attach, undo_attach)
	return ctx.ok({"node": node_path, "path": p, "undoable": true})

static func _detach(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var node_path := String(args.get("node", "")).strip_edges()
	if node_path.is_empty():
		return ctx.err("MISSING_ARG", "node is required",
			"pass node: a NodePath in the edited scene (scene_tree shows paths; \".\" is the root)")
	var node := ctx.find_node(node_path)
	if node == null:
		return ctx.node_not_found(node_path)
	var old_script = node.get_script()
	if old_script == null:
		return ctx.err("NO_SCRIPT", "node \"%s\" has no script to detach" % node_path,
			"node_get shows whether a script is attached")
	var do_detach := func() -> void:
		node.set_script(null)
	var undo_detach := func() -> void:
		node.set_script(old_script)
	ctx.undo.action("vulcan: script_detach", do_detach, undo_detach)
	var detached := ""
	if old_script is Resource:
		detached = old_script.resource_path
	return ctx.ok({"node": node_path, "detached": detached, "undoable": true})

static func _validate(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var content := String(args.get("content", ""))
	var src_path := ""
	if content.is_empty():
		var raw := String(args.get("path", "")).strip_edges()
		if raw.is_empty():
			return ctx.err("MISSING_ARG", "pass path or content",
				"path: res://….gd to validate a file, or content: raw GDScript source")
		src_path = ctx.paths.require_res(raw)
		if src_path.is_empty():
			return ctx.paths.last_error
		if not FileAccess.file_exists(src_path):
			return ctx.err("FILE_NOT_FOUND", "no script at %s" % src_path,
				"script_list shows the project's scripts")
		var f := FileAccess.open(src_path, FileAccess.READ)
		if f == null:
			return ctx.err("IO_ERROR", "cannot read %s" % src_path, "check file permissions")
		content = f.get_as_text()
	var s := GDScript.new()
	s.source_code = content
	var parse_err := s.reload(false)
	var result := {"valid": parse_err == OK}
	if not src_path.is_empty():
		result["path"] = src_path
	if parse_err != OK:
		result["error"] = error_string(parse_err)
		result["note"] = "Godot's public API exposes no line/column detail; the parser prints specifics to the editor Output panel (editor_errors reads recent ones). For precise diagnostics use the LSP tool's mercury-godot lane."
	return ctx.ok(result)

# -- helpers -----------------------------------------------------------------

static func _write_and_refresh(p: String, text: String, editor) -> void:
	var w := FileAccess.open(p, FileAccess.WRITE)
	if w != null:
		w.store_string(text)
	w = null
	if ResourceLoader.has_cached(p):
		var s = ResourceLoader.load(p)
		if s is Script:
			s.source_code = text
			s.reload(true)
	editor.get_resource_filesystem().scan()

static func _walk_gd(dir_path: String, out: Array) -> void:
	if out.size() >= MAX_FILES:
		return
	if dir_path == "res://addons/mercury_vulcan":
		return
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return
	dir.list_dir_begin()
	var entry := dir.get_next()
	while not entry.is_empty():
		if entry.begins_with("."):
			entry = dir.get_next()
			continue
		var full := dir_path.path_join(entry)
		if dir.current_is_dir():
			_walk_gd(full, out)
		elif entry.get_extension() == "gd":
			out.append(full)
		entry = dir.get_next()
	dir.list_dir_end()

static func _collect_attachments(n: Node, root: Node, out: Dictionary) -> void:
	var s = n.get_script()
	if s != null and s is Resource and s.resource_path != "":
		if not out.has(s.resource_path):
			out[s.resource_path] = []
		out[s.resource_path].append("." if n == root else String(root.get_path_to(n)))
	for c in n.get_children():
		_collect_attachments(c, root, out)
