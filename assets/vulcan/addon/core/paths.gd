@tool
class_name MercuryVulcanPaths
extends RefCounted
# res:// path guard. EVERY file-path argument goes through require_res().
# Refuses absolute paths, .. escapes and non-res schemes. On refusal it
# returns "" and stores the full error result in last_error, so handlers do:
#   var p: String = ctx.paths.require_res(args.get("path", ""))
#   if p.is_empty():
#       return ctx.paths.last_error
# The server hands each request its own instance, so last_error never leaks
# across concurrent requests.

var last_error: Dictionary = {}

func require_res(raw) -> String:
	var p := String(raw).strip_edges().replace("\\", "/")
	if p.is_empty():
		return _refuse(p, "an empty path",
			"pass a res://-relative project path, e.g. res://scenes/main.tscn")
	if p.begins_with("uid://"):
		return _refuse(p, "a uid:// reference",
			"resolve it first with project_uid_to_path")
	if p.begins_with("user://"):
		return _refuse(p, "a user:// path",
			"VULCAN only touches files inside the project (res://)")
	if p.contains("://") and not p.begins_with("res://"):
		return _refuse(p, "a non-res scheme",
			"use res://-relative project paths only")
	if p.begins_with("/") or _looks_windows_absolute(p):
		return _refuse(p, "an absolute filesystem path",
			"use res://-relative project paths only")
	var body := p.trim_prefix("res://")
	var segs: Array = []
	for seg in body.split("/"):
		if seg.is_empty() or seg == ".":
			continue
		if seg == "..":
			return _refuse(p, "a .. escape",
				"res:// paths cannot leave the project")
		segs.append(seg)
	if segs.is_empty():
		return _refuse(p, "the project root itself",
			"name a file or directory inside res://")
	last_error = {}
	return "res://" + "/".join(segs)

func _looks_windows_absolute(p: String) -> bool:
	return p.length() >= 2 and p[1] == ":"

func _refuse(p: String, what: String, hint: String) -> String:
	last_error = {"ok": false, "error": {
		"code": "BAD_PATH",
		"message": "refused %s: \"%s\"" % [what, p],
		"hint": hint,
	}}
	return ""
