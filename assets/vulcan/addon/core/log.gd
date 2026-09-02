@tool
class_name MercuryVulcanLog
extends RefCounted
# Editor-side log/error capture ring for editor_errors (categories/editor.gd
# preloads this file; the class_name is a debugging convenience). Godot 4.5+
# exposes OS.add_logger(Logger); the Logger subclass is compiled at runtime so
# this file still parses on older 4.x, where mode() reports capture as
# unavailable and recent() returns whatever was captured (nothing).
# plugin.gd calls install() on _enter_tree and teardown() on _exit_tree.
# The ring is static: category handlers are static modules and reach it as
# MercuryVulcanLog.recent(limit) without holding an instance.

const RING_MAX := 400

static var _ring: Array = []
static var _mode := "uninstalled"
static var _logger = null

static func install() -> void:
	if _logger != null:
		return
	if not ClassDB.class_exists("Logger") or not OS.has_method("add_logger"):
		_mode = "unavailable (Godot < 4.5: no OS.add_logger; editor log capture is off)"
		return
	# Compiled at runtime so the file parses on < 4.5 (same pattern as the
	# play-mode bridge). rows is assigned the static ring BY REFERENCE, and
	# appends go through call_deferred — Logger callbacks can fire from any
	# thread, and the ring must only mutate on the main thread.
	var src := "extends Logger\n\nvar rows: Array = []\n\n"
	src += "func _log_error(function: String, file: String, line: int, code: String, rationale: String, editor_notify: bool, error_type: int, script_backtraces: Array) -> void:\n"
	src += "\tcall_deferred(\"_append\", { \"kind\": \"error\", \"function\": function, \"file\": file, \"line\": line, \"code\": code, \"rationale\": rationale, \"type\": error_type, \"at\": Time.get_ticks_msec() })\n\n"
	src += "func _log_message(message: String, error: bool) -> void:\n"
	src += "\tif not error:\n\t\treturn\n"
	src += "\tcall_deferred(\"_append\", { \"kind\": \"message\", \"message\": message, \"at\": Time.get_ticks_msec() })\n\n"
	src += "func _append(row: Dictionary) -> void:\n"
	src += "\trows.append(row)\n"
	src += "\twhile rows.size() > %d:\n\t\trows.pop_front()\n" % RING_MAX
	var script := GDScript.new()
	script.source_code = src
	if script.reload() != OK:
		_mode = "unavailable (the Logger subclass failed to compile on this Godot build)"
		return
	_logger = script.new()
	_logger.rows = _ring
	OS.add_logger(_logger)
	_mode = "logger"

static func teardown() -> void:
	if _logger != null and OS.has_method("remove_logger"):
		OS.remove_logger(_logger)
	_logger = null
	_mode = "uninstalled"

static func mode() -> String:
	return _mode

static func recent(limit: int) -> Array:
	var n := clampi(limit, 1, RING_MAX)
	return _ring.slice(maxi(0, _ring.size() - n))
