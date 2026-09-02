@tool
extends EditorPlugin
# Mercury VULCAN — Godot editor-control surface (loopback NDJSON bridge).
# Starts/stops the core server on _enter_tree/_exit_tree; settings live under
# mercury_vulcan/* (port default 6010; allow_execute_script is the
# defense-in-depth off-switch for editor_execute_script).
#
# The play-mode bridge (core/runtime_bridge.gd) is registered as the autoload
# "MercuryVulcanRuntimeBridge" for as long as the plugin is ENABLED — the game
# process reads project.godot's [autoload] table at launch, so registering it
# around individual play sessions would always be one session too late. The
# bridge idles (no token file ⇒ no connection) and has no @tool, so it never
# runs inside the editor process itself.

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
	# Persist NOW: add_autoload_singleton only stages the [autoload] row, and
	# the editor's deferred settings save can land minutes later — a play
	# session spawned before it reads a project.godot without the bridge and
	# runs silently unbridged (no error anywhere; the game just never
	# back-connects).
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
