@tool
extends RefCounted

const ENV := "MERCURY_VULCAN_INSTANCE"
const BASE := "res://.godot/mercury-vulcan"
const ROLES := ["operator-editor", "agent-editor", "headless-worker", "native-worker"]

var identity: Dictionary = {}
var token := ""
var parent: Dictionary = {}
var listener: TCPServer = null
var directory := ""
var _inherited := ""
var _published := ""

func start(editor: bool) -> bool:
	_inherited = OS.get_environment(ENV)
	var supplied = JSON.parse_string(_inherited) if not _inherited.is_empty() and _inherited.length() <= 16384 else null
	var config: Dictionary = supplied if supplied is Dictionary else {}
	var root := ProjectSettings.globalize_path("res://").trim_suffix("/").trim_suffix("\\")
	var same_root := str(config.get("projectRoot", "")).replace("\\", "/") == root.replace("\\", "/")
	var is_launch := not config.has("pid") and same_root
	if not editor and config.has("pid") and same_root and str(config.get("role", "")).ends_with("-editor"):
		parent = config.duplicate()
	var role := str(config.get("role", "")) if is_launch else ("operator-editor" if editor else ("headless-worker" if DisplayServer.get_name() == "headless" else "native-worker"))
	if not ROLES.has(role):
		return false
	var crypto := Crypto.new()
	var id := str(config.get("id", "")) if is_launch else crypto.generate_random_bytes(16).hex_encode()
	token = str(config.get("token", "")) if is_launch else crypto.generate_random_bytes(32).hex_encode()
	if not _hex(id, 32) or not _hex(token, 64):
		return false
	var port := int(config.get("port", 0)) if is_launch else 0
	if port < 0 or port > 65535:
		return false
	listener = TCPServer.new()
	if listener.listen(port, "127.0.0.1") != OK:
		listener = null
		return false
	identity = {"version": 1, "id": id, "role": role, "port": listener.get_local_port(), "pid": OS.get_process_id(), "projectRoot": root, "ownerPid": int(config.get("ownerPid", 0)) if is_launch else 0}
	var project_dir := DirAccess.open("res://")
	var godot_dir := DirAccess.open("res://.godot")
	if project_dir == null or project_dir.is_link(".godot") or (godot_dir != null and godot_dir.is_link("mercury-vulcan")):
		stop()
		return false
	var target := "%s/%s" % [BASE, id]
	if DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(BASE)) != OK or DirAccess.make_dir_absolute(ProjectSettings.globalize_path(target)) != OK:
		stop()
		return false
	directory = target
	if not _private(directory, 448):
		stop()
		return false
	if not _write(directory + "/token", token) or not _write(directory + "/instance.json", JSON.stringify(identity)):
		stop()
		return false
	var inherited := identity.duplicate()
	inherited["token"] = token
	_published = JSON.stringify(inherited)
	OS.set_environment(ENV, _published)
	return true

func stop() -> void:
	if listener != null:
		listener.stop()
		listener = null
	if not directory.is_empty():
		for file in ["instance.json", "token"]:
			DirAccess.remove_absolute(ProjectSettings.globalize_path(directory + "/" + file))
		DirAccess.remove_absolute(ProjectSettings.globalize_path(directory))
		directory = ""
	if not _published.is_empty() and OS.get_environment(ENV) == _published:
		if _inherited.is_empty():
			OS.unset_environment(ENV)
		else:
			OS.set_environment(ENV, _inherited)

static func public_identity(value: Dictionary) -> Dictionary:
	var out := {}
	for key in ["version", "id", "role", "port", "pid", "projectRoot", "ownerPid"]:
		if value.has(key):
			out[key] = value[key]
	return out

static func matches(a: Dictionary, b: Dictionary) -> bool:
	return public_identity(a) == public_identity(b)

static func equal_token(a: String, b: String) -> bool:
	var aa := a.to_utf8_buffer()
	var bb := b.to_utf8_buffer()
	var diff := aa.size() ^ bb.size()
	for i in maxi(aa.size(), bb.size()):
		diff |= (aa[i] if i < aa.size() else 0) ^ (bb[i] if i < bb.size() else 0)
	return diff == 0

static func _hex(value: String, size: int) -> bool:
	if value.length() != size:
		return false
	for c in value:
		if not "0123456789abcdef".contains(c):
			return false
	return true

static func _private(file: String, mode: int) -> bool:
	return OS.get_name() == "Windows" or FileAccess.set_unix_permissions(ProjectSettings.globalize_path(file), mode) == OK

static func _write(file: String, content: String) -> bool:
	var f := FileAccess.open(file, FileAccess.WRITE)
	if f == null:
		return false
	f.store_string(content)
	f.close()
	return _private(file, 384)
