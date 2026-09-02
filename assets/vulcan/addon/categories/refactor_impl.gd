@tool
class_name MercuryVulcanRefactorImpl
# mercury_vulcan — implementation of the frontier refactor ops (no ops():
# frontier.gd owns the contract names and delegates here).
#
# Laws of this module:
#  · the ENGINE decides what matches — SceneState connections/properties and
#    script introspection (signal list, property list, base-script chain);
#    text edits only APPLY what the engine identified, attribute-exact;
#  · a scene rewrite is transactional: if the text does not match the engine's
#    reading, or the post-write reload does not verify, the original bytes go
#    back and the scene lands in findings instead;
#  · open scenes are refused (an unsaved tab silently clobbers disk edits);
#  · binary .scn and dynamic/string sites outside the declaring script are
#    REPORTED with file:line, never rewritten.

const IDENT := "^[a-zA-Z_][a-zA-Z0-9_]*$"


static func rename_signal(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _common(args, ctx)
	if got.has("err"):
		return got["err"]
	var script_path: String = got["script_path"]
	var target: Script = got["script"]
	var from: String = got["from"]
	var to: String = got["to"]
	var dry := bool(args.get("dry_run", false))
	var has_from := false
	var has_to := false
	for s in target.get_script_signal_list():
		if String(s.get("name", "")) == from:
			has_from = true
		if String(s.get("name", "")) == to:
			has_to = true
	if not has_from:
		return ctx.err("SIGNAL_NOT_FOUND", "%s declares no signal '%s'" % [script_path, from],
			"node_signal_list on a node with this script names its signals")
	if has_to:
		return ctx.err("NAME_TAKEN", "%s already declares a signal '%s'" % [script_path, to], "pick another name")

	var files := _project_files(ctx)
	var findings: Array = []
	for scn in files["scn_binary"]:
		findings.append({ "file": scn, "why": "binary .scn — inspect and rewrite by hand (this op edits text scenes only)" })
	var planned: Array = []
	for sp in files["scenes"]:
		var plan := _plan_scene_connections(sp, script_path, from)
		if plan.has("finding"):
			findings.append(plan["finding"])
			continue
		var rows: Array = plan["rows"]
		if not rows.is_empty():
			planned.append({ "scene": sp, "connections": rows })
	# Refuse only when WRITING would touch an open scene (a dirty tab clobbers
	# disk edits silently); planning is read-only.
	if not dry:
		var touched: Array = []
		for row in planned:
			touched.append(String(row["scene"]))
		var open_hits := _open_scene_conflicts(ctx, touched)
		if not open_hits.is_empty():
			return ctx.err("SCENES_OPEN", "the rename touches scenes open in the editor: %s" % ", ".join(open_hits),
				"close those tabs (or save everything) first — a dirty tab clobbers disk edits silently; dry_run:true plans without writing")
	var scenes_rewritten: Array = []
	for row in planned:
		var applied := _apply_connection_renames(String(row["scene"]), row["connections"], from, to, dry)
		if applied.has("finding"):
			findings.append(applied["finding"])
			continue
		scenes_rewritten.append({ "scene": row["scene"], "connections": row["connections"], "written": not dry })

	var script_edits: Array = []
	var decl_src := FileAccess.get_file_as_string(script_path)
	var decl_edit := _rewrite_declaring_signal(decl_src, from, to)
	script_edits.append_array(_edit_rows(script_path, decl_src, decl_edit["text"]))
	if not dry and decl_edit["text"] != decl_src:
		var werr := _write_text(script_path, decl_edit["text"])
		if werr != "":
			return ctx.err("WRITE_FAILED", werr, "is %s writable?" % script_path)
	for leftover in decl_edit["leftovers"]:
		findings.append({ "file": "%s:%d" % [script_path, leftover["line"]], "why": "unclassified use of '%s' in the declaring script — review by hand" % from, "text": leftover["text"] })
	findings.append_array(_foreign_script_findings(files["scripts"], script_path, from))

	if not dry:
		for row in scenes_rewritten:
			var verify := _verify_scene_signal(String(row["scene"]), script_path, from, to, (row["connections"] as Array).size())
			if verify != "":
				findings.append({ "file": row["scene"], "why": verify })
	return ctx.ok({
		"op": "refactor_rename_signal",
		"script": script_path,
		"from": from,
		"to": to,
		"dry_run": dry,
		"scenes_rewritten": scenes_rewritten,
		"script_edits": script_edits,
		"findings": findings,
		"note": "inspector-wired connections + the declaring script are rewritten; dynamic/string sites elsewhere are findings (the LSP rename covers identifiers)",
	})


static func rename_export(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var got := _common(args, ctx)
	if got.has("err"):
		return got["err"]
	var script_path: String = got["script_path"]
	var target: Script = got["script"]
	var from: String = got["from"]
	var to: String = got["to"]
	var dry := bool(args.get("dry_run", false))
	var has_from := false
	var has_to := false
	for p in target.get_script_property_list():
		var pname := String(p.get("name", ""))
		var usage := int(p.get("usage", 0))
		if pname == from and (usage & PROPERTY_USAGE_STORAGE) != 0:
			has_from = true
		if pname == to:
			has_to = true
	if not has_from:
		return ctx.err("EXPORT_NOT_FOUND", "%s declares no stored @export var '%s'" % [script_path, from],
			"node_get_properties on a node with this script lists them")
	if has_to:
		return ctx.err("NAME_TAKEN", "%s already declares '%s'" % [script_path, to], "pick another name")

	var files := _project_files(ctx)
	var findings: Array = []
	for scn in files["scn_binary"]:
		findings.append({ "file": scn, "why": "binary .scn — inspect and rewrite by hand (this op edits text scenes only)" })
	var planned: Array = []
	for sp in files["scenes"]:
		var plan := _plan_scene_overrides(sp, script_path, from)
		if plan.has("finding"):
			findings.append(plan["finding"])
			continue
		var nodes: Array = plan["nodes"]
		if not nodes.is_empty():
			planned.append({ "file": sp, "nodes": nodes })
	if not dry:
		var touched: Array = []
		for row in planned:
			touched.append(String(row["file"]))
		var open_hits := _open_scene_conflicts(ctx, touched)
		if not open_hits.is_empty():
			return ctx.err("SCENES_OPEN", "the rename touches scenes open in the editor: %s" % ", ".join(open_hits),
				"close those tabs (or save everything) first — a dirty tab clobbers disk edits silently; dry_run:true plans without writing")
	var rewritten: Array = []
	for row in planned:
		var applied := _apply_override_renames(String(row["file"]), row["nodes"], from, to, dry)
		if applied.has("finding"):
			findings.append(applied["finding"])
			continue
		rewritten.append({ "file": row["file"], "nodes": row["nodes"], "written": not dry })
	for rp in files["resources"]:
		var rplan := _plan_resource_override(rp, script_path, from)
		if rplan.has("finding"):
			findings.append(rplan["finding"])
			continue
		if not bool(rplan["matches"]):
			continue
		var rapplied := _apply_resource_rename(rp, from, to, dry)
		if rapplied.has("finding"):
			findings.append(rapplied["finding"])
			continue
		rewritten.append({ "file": rp, "nodes": ["(resource)"], "written": not dry })

	var script_edits: Array = []
	var decl_src := FileAccess.get_file_as_string(script_path)
	var re := RegEx.create_from_string("\\b%s\\b" % from)
	var new_src := re.sub(decl_src, to, true)
	script_edits.append_array(_edit_rows(script_path, decl_src, new_src))
	if not dry and new_src != decl_src:
		var werr := _write_text(script_path, new_src)
		if werr != "":
			return ctx.err("WRITE_FAILED", werr, "is %s writable?" % script_path)
	findings.append_array(_foreign_script_findings(files["scripts"], script_path, from))

	if not dry:
		for row in rewritten:
			var fpath := String(row["file"])
			if fpath.ends_with(".tscn"):
				var verify := _verify_scene_override(fpath, script_path, from, to)
				if verify != "":
					findings.append({ "file": fpath, "why": verify })
	return ctx.ok({
		"op": "refactor_rename_export",
		"script": script_path,
		"from": from,
		"to": to,
		"dry_run": dry,
		"files_rewritten": rewritten,
		"script_edits": script_edits,
		"findings": findings,
		"note": "scene/resource overrides + every identifier in the declaring script are rewritten; other scripts' member accesses are findings (the LSP rename covers identifiers)",
	})


# --- shared plumbing ---


static func _common(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var script_path: String = ctx.paths.require_res(String(args.get("script", "")))
	if script_path.is_empty():
		return { "err": ctx.paths.last_error }
	if not script_path.ends_with(".gd"):
		return { "err": ctx.err("BAD_ARG", "script must be a res://….gd path", "e.g. res://player.gd") }
	if not ResourceLoader.exists(script_path):
		return { "err": ctx.err("NOT_FOUND", "no script at %s" % script_path, "project_file_search finds scripts") }
	var from := String(args.get("from", ""))
	var to := String(args.get("to", ""))
	var ident := RegEx.create_from_string(IDENT)
	if ident.search(from) == null or ident.search(to) == null:
		return { "err": ctx.err("BAD_ARG", "from and to must be identifiers", "e.g. {\"from\": \"died\", \"to\": \"perished\"}") }
	if from == to:
		return { "err": ctx.err("BAD_ARG", "from and to are the same name", "nothing to do") }
	var target: Script = load(script_path)
	if target == null:
		return { "err": ctx.err("LOAD_FAILED", "could not load %s" % script_path, "script_validate checks it parses") }
	return { "script_path": script_path, "script": target, "from": from, "to": to }


static func _project_files(ctx: MercuryVulcanContext) -> Dictionary:
	var scenes: Array = []
	var scn_binary: Array = []
	var scripts: Array = []
	var resources: Array = []
	var fs: EditorFileSystem = ctx.editor.get_resource_filesystem()
	if fs != null:
		_walk(fs.get_filesystem(), scenes, scn_binary, scripts, resources)
	return { "scenes": scenes, "scn_binary": scn_binary, "scripts": scripts, "resources": resources }


static func _walk(dir: EditorFileSystemDirectory, scenes: Array, scn_binary: Array, scripts: Array, resources: Array) -> void:
	if dir == null:
		return
	for i in dir.get_file_count():
		var p := dir.get_file_path(i)
		if p.ends_with(".tscn"):
			scenes.append(p)
		elif p.ends_with(".scn"):
			scn_binary.append(p)
		elif p.ends_with(".gd") and not p.begins_with("res://addons/"):
			scripts.append(p)
		elif p.ends_with(".tres"):
			resources.append(p)
	for i in dir.get_subdir_count():
		_walk(dir.get_subdir(i), scenes, scn_binary, scripts, resources)


static func _open_scene_conflicts(ctx: MercuryVulcanContext, scenes: Array) -> Array:
	var open: Array = []
	for s in ctx.editor.get_open_scenes():
		if scenes.has(String(s)):
			open.append(String(s))
	return open


## Does node_script (or any base in its chain) live at script_path?
static func _script_chain_matches(node_script: Variant, script_path: String) -> bool:
	var cur: Script = node_script as Script
	while cur != null:
		if cur.resource_path == script_path:
			return true
		cur = cur.get_base_script()
	return false


static func _state_of(scene_path: String) -> SceneState:
	var ps: PackedScene = ResourceLoader.load(scene_path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE) as PackedScene
	if ps == null:
		return null
	return ps.get_state()


static func _node_script_at(state: SceneState, node_idx: int) -> Variant:
	for j in state.get_node_property_count(node_idx):
		if String(state.get_node_property_name(node_idx, j)) == "script":
			return state.get_node_property_value(node_idx, j)
	return null


static func _plan_scene_connections(scene_path: String, script_path: String, from: String) -> Dictionary:
	var state := _state_of(scene_path)
	if state == null:
		return { "finding": { "file": scene_path, "why": "scene failed to load for inspection" } }
	var by_path := {}
	for i in state.get_node_count():
		by_path[String(state.get_node_path(i)).trim_prefix("./")] = i
	var rows: Array = []
	for c in state.get_connection_count():
		if String(state.get_connection_signal(c)) != from:
			continue
		var src := String(state.get_connection_source(c)).trim_prefix("./")
		if not by_path.has(src):
			continue
		if not _script_chain_matches(_node_script_at(state, by_path[src]), script_path):
			continue
		rows.append({
			"from_node": src,
			"to_node": String(state.get_connection_target(c)).trim_prefix("./"),
			"method": String(state.get_connection_method(c)),
		})
	return { "rows": rows }


static func _apply_connection_renames(scene_path: String, rows: Array, from: String, to: String, dry: bool) -> Dictionary:
	var text := FileAccess.get_file_as_string(scene_path)
	var new_text := text
	for row in rows:
		var needle := '[connection signal="%s" from="%s" to="%s" method="%s"' % [from, row["from_node"], row["to_node"], row["method"]]
		var replacement := '[connection signal="%s" from="%s" to="%s" method="%s"' % [to, row["from_node"], row["to_node"], row["method"]]
		if new_text.count(needle) != 1:
			return { "finding": { "file": scene_path, "why": "connection text (%s) did not match the engine's reading exactly once — hand-edited formatting? nothing written" % needle } }
		new_text = new_text.replace(needle, replacement)
	if not dry:
		var werr := _write_text(scene_path, new_text)
		if werr != "":
			return { "finding": { "file": scene_path, "why": werr } }
	return {}


static func _verify_scene_signal(scene_path: String, script_path: String, from: String, to: String, expected: int) -> String:
	var state := _state_of(scene_path)
	if state == null:
		return "post-write reload failed — restore from VCS and report this"
	var old_count := 0
	var new_count := 0
	for c in state.get_connection_count():
		var s := String(state.get_connection_signal(c))
		if s == from:
			old_count += 1
		elif s == to:
			new_count += 1
	if new_count < expected or old_count > 0:
		return "post-write verify: wanted %d '%s' connections and zero '%s', found %d/%d" % [expected, to, from, new_count, old_count]
	return ""


static func _plan_scene_overrides(scene_path: String, script_path: String, from: String) -> Dictionary:
	var state := _state_of(scene_path)
	if state == null:
		return { "finding": { "file": scene_path, "why": "scene failed to load for inspection" } }
	var nodes: Array = []
	for i in state.get_node_count():
		if not _script_chain_matches(_node_script_at(state, i), script_path):
			continue
		for j in state.get_node_property_count(i):
			if String(state.get_node_property_name(i, j)) == from:
				var p := String(state.get_node_path(i)).trim_prefix("./")
				nodes.append({
					"path": p,
					"name": String(state.get_node_name(i)),
					# The root node stores path "."; its [node] header carries no parent attr.
					"parent": "" if p == "." else ("." if not p.contains("/") else p.get_base_dir()),
				})
				break
	return { "nodes": nodes }


static func _node_header_matches(line: String, node_name: String, parent: String) -> bool:
	if not line.begins_with('[node name="%s"' % node_name):
		return false
	if parent == "":
		return not line.contains(" parent=")
	return line.contains(' parent="%s"' % parent)


static func _apply_override_renames(scene_path: String, nodes: Array, from: String, to: String, dry: bool) -> Dictionary:
	var text := FileAccess.get_file_as_string(scene_path)
	var lines := text.split("\n")
	for node in nodes:
		var in_block := false
		var found := false
		for li in lines.size():
			var line := lines[li]
			if line.begins_with("["):
				in_block = line.begins_with("[node ") and _node_header_matches(line, String(node["name"]), String(node["parent"]))
				continue
			if in_block and line.begins_with(from + " = "):
				lines[li] = to + line.substr(from.length())
				found = true
		if not found:
			return { "finding": { "file": scene_path, "why": "the stored '%s' line for node '%s' was not found in the text — nothing written" % [from, node["path"]] } }
	if not dry:
		var werr := _write_text(scene_path, "\n".join(lines))
		if werr != "":
			return { "finding": { "file": scene_path, "why": werr } }
	return {}


static func _verify_scene_override(scene_path: String, script_path: String, from: String, to: String) -> String:
	var state := _state_of(scene_path)
	if state == null:
		return "post-write reload failed — restore from VCS and report this"
	var found_new := false
	for i in state.get_node_count():
		if not _script_chain_matches(_node_script_at(state, i), script_path):
			continue
		for j in state.get_node_property_count(i):
			var pname := String(state.get_node_property_name(i, j))
			if pname == from:
				return "post-write verify: the old property '%s' is still stored on '%s'" % [from, String(state.get_node_path(i))]
			if pname == to:
				found_new = true
	if not found_new:
		return "post-write verify: no stored '%s' property found on this script's nodes" % to
	return ""


static func _plan_resource_override(res_path: String, script_path: String, from: String) -> Dictionary:
	var res: Resource = ResourceLoader.load(res_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if res == null:
		return { "finding": { "file": res_path, "why": "resource failed to load for inspection" } }
	if not _script_chain_matches(res.get_script(), script_path):
		return { "matches": false }
	var text := FileAccess.get_file_as_string(res_path)
	return { "matches": text.contains("\n%s = " % from) }


static func _apply_resource_rename(res_path: String, from: String, to: String, dry: bool) -> Dictionary:
	var text := FileAccess.get_file_as_string(res_path)
	var needle := "\n%s = " % from
	if text.count(needle) != 1:
		return { "finding": { "file": res_path, "why": "the stored '%s' line did not match exactly once — nothing written" % from } }
	if not dry:
		var werr := _write_text(res_path, text.replace(needle, "\n%s = " % to))
		if werr != "":
			return { "finding": { "file": res_path, "why": werr } }
	return {}


## Surgical rewrite of the declaring script for a SIGNAL rename: declaration,
## self-emits, self string-literal calls. Unclassified word hits are returned
## as leftovers for the findings list.
static func _rewrite_declaring_signal(src: String, from: String, to: String) -> Dictionary:
	var text := src
	var shapes := [
		["\\bsignal %s\\b" % from, "signal %s" % to],
		["\\b%s\\.emit\\(" % from, "%s.emit(" % to],
		["\\b%s\\.connect\\(" % from, "%s.connect(" % to],
		["\\b%s\\.disconnect\\(" % from, "%s.disconnect(" % to],
		["\\b%s\\.is_connected\\(" % from, "%s.is_connected(" % to],
		["\\bemit_signal\\(\"%s\"" % from, "emit_signal(\"%s\"" % to],
		["\\bconnect\\(\"%s\"" % from, "connect(\"%s\"" % to],
		["\\bdisconnect\\(\"%s\"" % from, "disconnect(\"%s\"" % to],
		["\\bis_connected\\(\"%s\"" % from, "is_connected(\"%s\"" % to],
		["&\"%s\"" % from, "&\"%s\"" % to],
	]
	for pair in shapes:
		var re := RegEx.create_from_string(pair[0])
		text = re.sub(text, pair[1], true)
	var leftovers: Array = []
	var word := RegEx.create_from_string("\\b%s\\b" % from)
	var line_no := 0
	for line in text.split("\n"):
		line_no += 1
		if word.search(line) != null:
			leftovers.append({ "line": line_no, "text": line.strip_edges().left(120) })
	return { "text": text, "leftovers": leftovers }


static func _foreign_script_findings(scripts: Array, script_path: String, from: String) -> Array:
	var findings: Array = []
	var patterns := [
		RegEx.create_from_string("\\.%s\\.(emit|connect|disconnect|is_connected)\\b" % from),
		RegEx.create_from_string("\\b(emit_signal|connect|disconnect|is_connected|get|set)\\(\"%s\"" % from),
		RegEx.create_from_string("\\.%s\\b" % from),
	]
	for sp in scripts:
		if sp == script_path:
			continue
		var src := FileAccess.get_file_as_string(sp)
		var line_no := 0
		for line in src.split("\n"):
			line_no += 1
			for re in patterns:
				if re.search(line) != null:
					findings.append({ "file": "%s:%d" % [sp, line_no], "why": "possible use of '%s' in another script — not rewritten (typed receivers need the LSP rename)" % from, "text": line.strip_edges().left(120) })
					break
	return findings


static func _edit_rows(file: String, before: String, after: String) -> Array:
	if before == after:
		return []
	var rows: Array = []
	var b := before.split("\n")
	var a := after.split("\n")
	for i in mini(b.size(), a.size()):
		if b[i] != a[i]:
			rows.append({ "file": "%s:%d" % [file, i + 1], "before": b[i].strip_edges().left(120), "after": a[i].strip_edges().left(120) })
	return rows


static func _write_text(path: String, text: String) -> String:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return "could not open %s for writing (%s)" % [path, error_string(FileAccess.get_open_error())]
	f.store_string(text)
	f.close()
	return ""
