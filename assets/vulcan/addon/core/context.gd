@tool
class_name MercuryVulcanContext
extends RefCounted

var editor: Object = null
var undo = null
var types = null
var paths = null
var runtime = null
var server: Object = null

func err(code: String, message: String, hint: String) -> Dictionary:
	return {"ok": false, "error": {"code": code, "message": message, "hint": hint}}

func ok(result) -> Dictionary:
	return {"ok": true, "result": result}

func dispatch(op: String, args: Dictionary) -> Dictionary:
	if server == null:
		return err("NO_DISPATCH", "this context has no dispatch seam",
			"addon bug (core/server.gd did not wire ctx.server); report it")
	return await server.dispatch_op(op, args)

func op_class(op: String) -> String:
	if server == null:
		return ""
	return server.op_class_of(op)

func scene_root() -> Node:
	if editor == null:
		return null
	return editor.get_edited_scene_root()

func find_node(path_str: String) -> Node:
	var root := scene_root()
	if root == null:
		return null
	var p := path_str.strip_edges()
	if p.is_empty() or p == "." or p == "/":
		return root
	if p.begins_with("/root/"):
		p = p.trim_prefix("/root/")
	var root_name := String(root.name)
	if p == root_name:
		return root
	var n := root.get_node_or_null(NodePath(p))
	if n != null:
		return n
	if p.begins_with(root_name + "/"):
		return root.get_node_or_null(NodePath(p.substr(root_name.length() + 1)))
	return null

func node_not_found(path_str: String) -> Dictionary:
	var root := scene_root()
	if root == null:
		return err("NO_SCENE", "no scene is open in the editor",
			"open one with scene_open or create one with scene_create")
	var p := path_str.strip_edges().trim_prefix("/root/")
	var segs := p.split("/", false)
	var cur := root
	var resolved := String(root.name)
	var start := 0
	if segs.size() > 0 and segs[0] == String(root.name):
		start = 1
	for i in range(start, segs.size()):
		var nxt := cur.get_node_or_null(NodePath(segs[i]))
		if nxt == null:
			break
		cur = nxt
		resolved += "/" + segs[i]
	var names: Array = []
	for c in cur.get_children():
		names.append(String(c.name))
		if names.size() >= 12:
			break
	return err("NODE_NOT_FOUND", "no node at \"%s\" in the edited scene" % path_str,
		"nearest existing node is \"%s\" with children %s; the scene root is \"%s\" (scene_tree shows the full tree)" % [resolved, names, String(root.name)])
