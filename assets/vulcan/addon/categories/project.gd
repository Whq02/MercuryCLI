@tool
class_name MercuryVulcanProject
extends RefCounted
# VULCAN category: project — engine/project info, file search, ProjectSettings,
# uid resolution. project_settings_set is the one mutate op (UndoRedo-wrapped).

const MAX_SEARCH_RESULTS := 500
const MAX_SETTINGS := 2000

static func ops() -> Array:
	return [
		"project_info", "project_file_search", "project_settings_get",
		"project_settings_set", "project_settings_list",
		"project_uid_to_path", "project_path_to_uid",
	]

static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"project_info": return _info(ctx)
		"project_file_search": return _file_search(args, ctx)
		"project_settings_get": return _settings_get(args, ctx)
		"project_settings_set": return _settings_set(args, ctx)
		"project_settings_list": return _settings_list(args, ctx)
		"project_uid_to_path": return _uid_to_path(args, ctx)
		"project_path_to_uid": return _path_to_uid(args, ctx)
	return ctx.err("UNKNOWN_OP", "project does not own \"%s\"" % op,
		"registry routing bug; report it")

static func _info(ctx: MercuryVulcanContext) -> Dictionary:
	var v := Engine.get_version_info()
	return ctx.ok({
		"godot": String(v.get("string", "")),
		"project_name": String(ProjectSettings.get_setting("application/config/name", "")),
		"main_scene": String(ProjectSettings.get_setting("application/run/main_scene", "")),
		"features": ctx.types.to_jsonable(ProjectSettings.get_setting("application/config/features", [])),
	})

static func _file_search(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var pattern := String(args.get("pattern", "")).strip_edges()
	if pattern.is_empty():
		return ctx.err("MISSING_ARG", "pattern is required",
			"pass a glob like *.tscn or a name substring")
	var kind := String(args.get("type", "all")).strip_edges()
	if kind.is_empty():
		kind = "all"
	var exts = _kind_exts(kind)
	if exts == null:
		return ctx.err("BAD_ARG", "unknown type \"%s\"" % kind,
			"use scenes, scripts, resources or all")
	var hits: Array = []
	_walk("res://", pattern, exts, hits)
	var truncated := hits.size() > MAX_SEARCH_RESULTS
	if truncated:
		hits = hits.slice(0, MAX_SEARCH_RESULTS)
	return ctx.ok({"files": hits, "count": hits.size(), "truncated": truncated})

static func _settings_get(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var setting := String(args.get("setting", "")).strip_edges()
	if setting.is_empty():
		return ctx.err("MISSING_ARG", "setting is required",
			"pass a settings path like application/config/name")
	if not ProjectSettings.has_setting(setting):
		return ctx.err("SETTING_NOT_FOUND", "no ProjectSettings entry \"%s\"" % setting,
			"list candidates with project_settings_list (prefix filter)")
	return ctx.ok(ctx.types.to_jsonable(ProjectSettings.get_setting(setting)))

static func _settings_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var setting := String(args.get("setting", "")).strip_edges()
	if setting.is_empty():
		return ctx.err("MISSING_ARG", "setting is required",
			"pass a settings path like display/window/size/viewport_width")
	if not args.has("value"):
		return ctx.err("MISSING_ARG", "value is required",
			"pass value: the new setting value (smart-parsed, e.g. \"Vector2(640, 480)\")")
	var value = ctx.types.parse(args.get("value"))
	var had := ProjectSettings.has_setting(setting)
	var old = ProjectSettings.get_setting(setting) if had else null
	var do_set := func() -> void:
		ProjectSettings.set_setting(setting, value)
		ProjectSettings.save()
	var undo_set := func() -> void:
		if had:
			ProjectSettings.set_setting(setting, old)
		else:
			ProjectSettings.set_setting(setting, null)
		ProjectSettings.save()
	ctx.undo.action("vulcan: project_settings_set", do_set, undo_set)
	return ctx.ok({"setting": setting,
		"value": ctx.types.to_jsonable(ProjectSettings.get_setting(setting)),
		"created": not had, "undoable": true})

static func _settings_list(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var prefix := String(args.get("prefix", "")).strip_edges()
	var out := {}
	var total := 0
	for prop in ProjectSettings.get_property_list():
		var setting_name := String(prop.get("name", ""))
		if setting_name.is_empty() or not setting_name.contains("/"):
			continue
		if not prefix.is_empty() and not setting_name.begins_with(prefix):
			continue
		total += 1
		if out.size() < MAX_SETTINGS:
			out[setting_name] = ctx.types.to_jsonable(ProjectSettings.get_setting(setting_name))
	return ctx.ok({"settings": out, "total": total, "truncated": total > out.size()})

static func _uid_to_path(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var uid := String(args.get("uid", "")).strip_edges()
	if not uid.begins_with("uid://"):
		return ctx.err("BAD_ARG", "uid must look like uid://…",
			"pass the uid:// reference to resolve; project_path_to_uid goes the other way")
	var id := ResourceUID.text_to_id(uid)
	if id == ResourceUID.INVALID_ID or not ResourceUID.has_id(id):
		return ctx.err("UID_NOT_FOUND", "no resource with uid \"%s\"" % uid,
			"find the file with project_file_search, then project_path_to_uid it")
	return ctx.ok(ResourceUID.get_id_path(id))

static func _path_to_uid(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var p: String = ctx.paths.require_res(args.get("path", ""))
	if p.is_empty():
		return ctx.paths.last_error
	if not ResourceLoader.exists(p):
		return ctx.err("FILE_NOT_FOUND", "no resource at %s" % p,
			"check the path with project_file_search")
	if not ResourceLoader.has_method("get_resource_uid"):
		return ctx.err("UNSUPPORTED", "this Godot build lacks ResourceLoader.get_resource_uid (4.4+)",
			"resolve via the .import/.uid sidecar files instead, or upgrade Godot")
	var id: int = ResourceLoader.get_resource_uid(p)
	if id == ResourceUID.INVALID_ID:
		return ctx.err("NO_UID", "\"%s\" has no uid" % p,
			"only saved/imported resources get uids; scripts gain one on save in 4.4+")
	return ctx.ok(ResourceUID.id_to_text(id))

static func _kind_exts(kind: String):
	match kind:
		"scenes": return ["tscn", "scn"]
		"scripts": return ["gd", "cs"]
		"resources": return ["tres", "res"]
		"all": return []
	return null

static func _walk(dir_path: String, pattern: String, exts: Array, hits: Array) -> void:
	if hits.size() > MAX_SEARCH_RESULTS:
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
			_walk(full, pattern, exts, hits)
		elif exts.is_empty() or exts.has(entry.get_extension().to_lower()):
			if entry.match(pattern) or full.match(pattern) \
					or entry.to_lower().contains(pattern.to_lower()):
				hits.append(full)
		entry = dir.get_next()
	dir.list_dir_end()
