@tool
extends EditorPlugin

const ServerScript := preload("core/server.gd")
const LogScript := preload("core/log.gd")

const PORT_SETTING := "mercury_vulcan/port"
const ALLOW_EXECUTE_SETTING := "mercury_vulcan/allow_execute_script"
const DEFAULT_PORT := 6010
const RUNTIME_AUTOLOAD := "MercuryVulcanRuntimeBridge"
const RUNTIME_BRIDGE_PATH := "res://addons/mercury_vulcan/core/runtime_bridge.gd"

var _server: Node = null

func _enter_tree() -> void:
	_ensure_setting(PORT_SETTING, DEFAULT_PORT)
	_ensure_setting(ALLOW_EXECUTE_SETTING, true)
	LogScript.install()
	add_autoload_singleton(RUNTIME_AUTOLOAD, RUNTIME_BRIDGE_PATH)
	ProjectSettings.save()
	_server = ServerScript.new()
	_server.name = "MercuryVulcanServer"
	_server.setup(get_undo_redo())
	add_child(_server)
	_server.start()

func _exit_tree() -> void:
	remove_autoload_singleton(RUNTIME_AUTOLOAD)
	if _server != null:
		_server.stop()
		_server.queue_free()
		_server = null
	LogScript.teardown()

func _ensure_setting(key: String, default_value) -> void:
	if not ProjectSettings.has_setting(key):
		ProjectSettings.set_setting(key, default_value)
	ProjectSettings.set_initial_value(key, default_value)
