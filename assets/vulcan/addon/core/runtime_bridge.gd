# core/runtime_bridge.gd -- the PLAY-MODE side of Mercury VULCAN.
#
# Runs inside editor-launched play sessions ONLY: plugin.gd registers this file
# as the autoload "MercuryVulcanRuntimeBridge" for as long as the plugin is
# ENABLED (add_autoload_singleton on _enter_tree / remove_autoload_singleton on
# _exit_tree — the game process reads project.godot's [autoload] table at
# launch, so per-play-session registration would always be one session late).
# With no token file it stays idle. NOTE the name: it must NOT be
# "MercuryVulcanRuntime" -- that global class_name belongs to
# categories/runtime.gd, and an autoload may not shadow a global class. For the
# same reason this file deliberately declares NO class_name.
#
# No @tool: this script never runs in the editor process.
#
# It back-connects to the addon server on 127.0.0.1:<port>, authenticates with
# the shared project-private token as role:"runtime", then serves rop requests:
#   server -> bridge : {"id": n, "rop": "runtime_tree", "args": {...}}
#   bridge -> server : {"id": n, "ok": true, "result": ...} |
#                      {"id": n, "ok": false, "error": {code, message, hint}}
#   bridge -> server : {"event": "runtime_error", "data": ...}   (unsolicited)
extends Node

const TOKEN_FILE := "res://.godot/mercury-vulcan-token"
const PORT_FILE := "res://.godot/mercury-vulcan-port"
const REC_DIR := "res://.godot/mercury-vulcan-recordings"
const SHOT_DIR := "res://.godot/mercury-vulcan-shots"
const RING_MAX := 400
const MAX_BUF := 8 * 1024 * 1024

# ONE name set with categories/profiling.gd (the editor-side table) — a name
# the editor path serves must never silently vanish when a play session is live.
const MONITORS := {
	"fps": Performance.TIME_FPS,
	"process_time": Performance.TIME_PROCESS,
	"physics_time": Performance.TIME_PHYSICS_PROCESS,
	"static_memory": Performance.MEMORY_STATIC,
	"static_memory_max": Performance.MEMORY_STATIC_MAX,
	"objects": Performance.OBJECT_COUNT,
	"resources": Performance.OBJECT_RESOURCE_COUNT,
	"nodes": Performance.OBJECT_NODE_COUNT,
	"orphan_nodes": Performance.OBJECT_ORPHAN_NODE_COUNT,
	"draw_calls": Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME,
	"video_memory": Performance.RENDER_VIDEO_MEM_USED,
	"texture_memory": Performance.RENDER_TEXTURE_MEM_USED,
	"physics_2d_active_objects": Performance.PHYSICS_2D_ACTIVE_OBJECTS,
	"physics_3d_active_objects": Performance.PHYSICS_3D_ACTIVE_OBJECTS,
	"audio_output_latency": Performance.AUDIO_OUTPUT_LATENCY,
}

var _peer: StreamPeerTCP = null
var _bytes := PackedByteArray()
var _hello_sent := false
var _started_ms := 0
var _log_ring: Array = []
var _error_ring: Array = []
var _capture_mode := "unavailable"
var _logger = null
var _recording: Array = []
var _recording_name := ""
var _recording_t0 := 0
var _is_recording := false


func _ready() -> void:
	# EXPORTED builds carry the autoload too (it lives in project.godot while
	# the plugin is enabled) — the bridge is editor tooling and must stay dead
	# in production: no logger, no socket, no player-visible warnings.
	if not OS.has_feature("editor"):
		set_process(false)
		return
	process_mode = Node.PROCESS_MODE_ALWAYS
	_started_ms = Time.get_ticks_msec()
	_install_logger()
	var tok := _token()
	if tok == "":
		push_warning("mercury_vulcan: no token file at %s; runtime bridge staying idle" % TOKEN_FILE)
		set_process(false)
		return
	_peer = StreamPeerTCP.new()
	if _peer.connect_to_host("127.0.0.1", _port()) != OK:
		push_warning("mercury_vulcan: runtime bridge could not start connecting")
		set_process(false)


func _exit_tree() -> void:
	if _logger != null and OS.has_method("remove_logger"):
		OS.remove_logger(_logger)
		_logger = null
	if _peer != null:
		_peer.disconnect_from_host()
		_peer = null


func _process(_delta: float) -> void:
	if _peer == null:
		return
	_peer.poll()
	var st := _peer.get_status()
	if st == StreamPeerTCP.STATUS_CONNECTED:
		if not _hello_sent:
			_send({ "op": "hello", "token": _token(), "role": "runtime", "version": 1 })
			_hello_sent = true
		var n := _peer.get_available_bytes()
		if n > 0:
			var res := _peer.get_data(n)
			if res[0] == OK:
				_bytes.append_array(res[1])
			while true:
				var nl := _bytes.find(10)
				if nl == -1:
					break
				var line := _bytes.slice(0, nl).get_string_from_utf8()
				_bytes = _bytes.slice(nl + 1)
				if line.strip_edges() != "":
					_on_line(line)
			# Only AFTER draining complete lines: a single partial line past the
			# cap is dropped LOUDLY (silently clearing mid-line would desync the
			# NDJSON stream and strand every in-flight rop in a timeout).
			if _bytes.size() > MAX_BUF:
				_bytes = PackedByteArray()
				_send({ "event": "runtime_error", "data": { "code": "LINE_TOO_LONG",
					"message": "runtime bridge dropped an oversized partial frame (>8MB)" } })
	elif st == StreamPeerTCP.STATUS_ERROR:
		set_process(false)


func _input(event: InputEvent) -> void:
	if _is_recording:
		var d := _event_desc(event)
		if not d.is_empty():
			_recording.append({ "t": Time.get_ticks_msec() - _recording_t0, "event": d })


func _on_line(line: String) -> void:
	var msg = JSON.parse_string(line)
	if typeof(msg) != TYPE_DICTIONARY or not msg.has("rop"):
		return
	var args = msg.get("args", {})
	if typeof(args) != TYPE_DICTIONARY:
		args = {}
	_handle_request(int(msg.get("id", 0)), str(msg["rop"]), args)


func _handle_request(id: int, rop: String, args: Dictionary) -> void:
	var resp: Dictionary = await _dispatch(rop, args)
	resp["id"] = id
	_send(resp)


func _dispatch(rop: String, args: Dictionary) -> Dictionary:
	match rop:
		"runtime_status":
			return _rop_status(args)
		"runtime_tree":
			return _rop_tree(args)
		"runtime_node_get":
			return _rop_node_get(args)
		"runtime_log":
			return _rop_ring(args, _log_ring)
		"runtime_errors":
			return _rop_ring(args, _error_ring)
		"runtime_ui_list":
			return _rop_ui_list(args)
		"runtime_ui_text":
			return _rop_ui_text(args)
		"runtime_watch":
			return await _rop_watch(args)
		"runtime_frames":
			return await _rop_frames(args)
		"runtime_record_list":
			return _rop_record_list(args)
		"runtime_screenshot":
			return await _rop_screenshot(args)
		"runtime_node_set":
			return _rop_node_set(args)
		"runtime_call":
			return _rop_call(args)
		"runtime_eval":
			return _rop_eval(args)
		"runtime_click":
			return _rop_click(args)
		"runtime_navigate":
			return _rop_navigate(args)
		"runtime_scene_change":
			return _rop_scene_change(args)
		"runtime_record_start":
			return _rop_record_start(args)
		"runtime_record_stop":
			return _rop_record_stop(args)
		"runtime_replay":
			return await _rop_replay(args)
		"runtime_wait_signal":
			return await _rop_wait_signal(args)
		"profile_monitors":
			return _rop_profile_monitors(args)
		"profile_snapshot":
			return await _rop_profile_snapshot(args)
		"test_assert":
			return _rop_test_assert(args)
		"input_key":
			return _rop_input_key(args)
		"input_mouse_button":
			return _rop_input_mouse_button(args)
		"input_mouse_move":
			return _rop_input_mouse_move(args)
		"input_action":
			return _rop_input_action(args)
		"input_sequence":
			return await _rop_input_sequence(args)
	return _err("UNKNOWN_ROP", "the runtime bridge does not serve '%s'" % rop, "runtime_status reports bridge health; see categories/runtime.gd for the rop contract")


# -- rop implementations ------------------------------------------------------

func _rop_status(_args: Dictionary) -> Dictionary:
	var cur := get_tree().current_scene
	return _ok({
		"playing": true,
		"scene": cur.scene_file_path if cur != null else "",
		"scene_root": str(cur.name) if cur != null else "",
		"uptime_ms": Time.get_ticks_msec() - _started_ms,
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"paused": get_tree().paused,
		"log_capture": _capture_mode,
		"recording": _is_recording,
	})


func _rop_tree(args: Dictionary) -> Dictionary:
	var root: Node = get_tree().current_scene
	var rp := str(args.get("root", ""))
	if rp != "":
		root = _find(rp)
		if root == null:
			return _node_err(rp)
	if root == null:
		return _err("NO_SCENE", "the running game has no current scene", "runtime_scene_change to a scene, or restart the play session")
	var depth := clampi(int(args.get("depth", 6)), 1, 32)
	return _ok(_tree_dict(root, depth))


func _tree_dict(n: Node, depth: int) -> Dictionary:
	var d := { "name": str(n.name), "type": n.get_class() }
	if n.get_script() != null:
		d["script"] = str(n.get_script().resource_path)
	if depth > 0 and n.get_child_count() > 0:
		var kids := []
		for c in n.get_children():
			kids.append(_tree_dict(c, depth - 1))
		d["children"] = kids
	elif n.get_child_count() > 0:
		d["children_count"] = n.get_child_count()
	return d


func _rop_node_get(args: Dictionary) -> Dictionary:
	var np := str(args.get("node", ""))
	var n := _find(np)
	if n == null:
		return _node_err(np)
	var props = args.get("properties", null)
	var out := {}
	if typeof(props) == TYPE_ARRAY:
		for p in props:
			out[str(p)] = _jsonable(n.get(str(p)))
	else:
		for common in ["position", "global_position", "rotation", "scale", "visible", "text", "modulate", "velocity"]:
			if common in n:
				out[common] = _jsonable(n.get(common))
		var script = n.get_script()
		if script != null:
			for pd in script.get_script_property_list():
				if pd["usage"] & PROPERTY_USAGE_SCRIPT_VARIABLE:
					out[str(pd["name"])] = _jsonable(n.get(pd["name"]))
	return _ok({ "node": str(n.get_path()), "type": n.get_class(), "properties": out })


func _rop_ring(args: Dictionary, ring: Array) -> Dictionary:
	var limit := clampi(int(args.get("limit", 100)), 1, RING_MAX)
	var rows := ring.slice(maxi(0, ring.size() - limit))
	return _ok({ "entries": rows, "count": rows.size(), "capture": _capture_mode })


func _rop_ui_list(args: Dictionary) -> Dictionary:
	var only := bool(args.get("interactable_only", false))
	var out := []
	_walk_controls(get_tree().root, only, out)
	return _ok({ "controls": out, "count": out.size() })


func _walk_controls(n: Node, only_interactable: bool, out: Array) -> void:
	if n is Control:
		var c := n as Control
		if c.is_visible_in_tree():
			var disabled := ("disabled" in c) and bool(c.get("disabled"))
			var interactable := c.mouse_filter != Control.MOUSE_FILTER_IGNORE and not disabled
			if interactable or not only_interactable:
				var r := c.get_global_rect()
				var row := {
					"path": str(c.get_path()),
					"type": c.get_class(),
					"rect": { "x": r.position.x, "y": r.position.y, "w": r.size.x, "h": r.size.y },
					"interactable": interactable,
				}
				if "text" in c:
					row["text"] = str(c.get("text"))
				out.append(row)
	for ch in n.get_children():
		_walk_controls(ch, only_interactable, out)


func _rop_ui_text(args: Dictionary) -> Dictionary:
	var np := str(args.get("node", ""))
	if np != "":
		var n := _find(np)
		if n == null:
			return _node_err(np)
		var d := {}
		for p in ["text", "placeholder_text", "tooltip_text"]:
			if p in n:
				d[p] = str(n.get(p))
		return _ok({ "node": str(n.get_path()), "text": d })
	var ctrls := []
	_walk_controls(get_tree().root, false, ctrls)
	var rows := []
	for c in ctrls:
		if c.has("text") and str(c["text"]) != "":
			rows.append({ "path": c["path"], "text": c["text"] })
	return _ok({ "texts": rows, "count": rows.size() })


func _rop_watch(args: Dictionary) -> Dictionary:
	var np := str(args.get("node", ""))
	var n := _find(np)
	if n == null:
		return _node_err(np)
	var prop := str(args.get("property", ""))
	if not (prop in n):
		return _err("PROPERTY_NOT_FOUND", "'%s' has no property '%s'" % [n.name, prop], "runtime_node_get lists the live properties")
	var duration := clampi(int(args.get("duration_ms", 1000)), 16, 30000)
	var interval := maxi(16, int(duration / 120.0))
	var series := []
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < duration:
		if not is_instance_valid(n):
			break
		series.append({ "t": Time.get_ticks_msec() - t0, "value": _jsonable(n.get(prop)) })
		await get_tree().create_timer(interval / 1000.0).timeout
	return _ok({ "node": np, "property": prop, "duration_ms": duration, "samples": series })


# Frame-time evidence: wall-clock deltas between process frames over a window,
# plus the RenderingServer's per-viewport CPU/GPU render times (enabled only
# for the window — the bridge leaves no standing measurement overhead).
# Headless/dummy renderers report render times as 0; the frame deltas stay real.
func _rop_frames(args: Dictionary) -> Dictionary:
	var duration := clampi(int(args.get("duration_ms", 4000)), 250, 30000)
	var hitch_ms := clampf(float(args.get("hitch_ms", 50.0)), 17.0, 1000.0)
	var rid := get_viewport().get_viewport_rid()
	RenderingServer.viewport_set_measure_render_time(rid, true)
	var deltas: Array = []
	var hitches: Array = []
	var cpu_sum := 0.0
	var cpu_max := 0.0
	var gpu_sum := 0.0
	var gpu_max := 0.0
	var t0 := Time.get_ticks_msec()
	var prev := t0
	while Time.get_ticks_msec() - t0 < duration:
		await get_tree().process_frame
		var now := Time.get_ticks_msec()
		var frame_ms := float(now - prev)
		prev = now
		deltas.append(frame_ms)
		if frame_ms >= hitch_ms and hitches.size() < 40:
			hitches.append({ "at_ms": now - t0, "frame_ms": frame_ms })
		var cpu := RenderingServer.viewport_get_measured_render_time_cpu(rid)
		var gpu := RenderingServer.viewport_get_measured_render_time_gpu(rid)
		cpu_sum += cpu
		cpu_max = maxf(cpu_max, cpu)
		gpu_sum += gpu
		gpu_max = maxf(gpu_max, gpu)
	RenderingServer.viewport_set_measure_render_time(rid, false)
	var actual := Time.get_ticks_msec() - t0
	if deltas.is_empty():
		return _err("NO_FRAMES", "no frames elapsed in the window", "is the game paused? runtime_status shows paused state")
	var sorted := deltas.duplicate()
	sorted.sort()
	var total := 0.0
	for d in sorted:
		total += float(d)
	var p95_idx := clampi(int(floor(sorted.size() * 0.95)), 0, sorted.size() - 1)
	return _ok({
		"duration_ms": actual,
		"frames": deltas.size(),
		"fps_avg": snappedf(deltas.size() * 1000.0 / maxf(1.0, float(actual)), 0.1),
		"frame_ms": {
			"min": snappedf(float(sorted[0]), 0.1),
			"avg": snappedf(total / sorted.size(), 0.1),
			"p95": snappedf(float(sorted[p95_idx]), 0.1),
			"max": snappedf(float(sorted[sorted.size() - 1]), 0.1),
		},
		"hitch_ms": hitch_ms,
		"hitch_count": hitches.size(),
		"hitches": hitches,
		"render_cpu_ms": { "avg": snappedf(cpu_sum / sorted.size(), 0.01), "max": snappedf(cpu_max, 0.01) },
		"render_gpu_ms": { "avg": snappedf(gpu_sum / sorted.size(), 0.01), "max": snappedf(gpu_max, 0.01) },
	})


func _rop_screenshot(args: Dictionary) -> Dictionary:
	await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	if img == null or img.is_empty():
		return _err("CAPTURE_FAILED", "the game viewport returned no image", "is the game window rendering (not minimized)?")
	var out := str(args.get("out", ""))
	if out == "":
		out = "%s/run-%d.png" % [SHOT_DIR, Time.get_ticks_msec()]
	if not out.begins_with("res://") or out.find("..") != -1:
		return _err("BAD_PATH", "out must be a res://-relative path", "e.g. res://.godot/mercury-vulcan-shots/menu.png")
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(out.get_base_dir()))
	var werr := img.save_png(ProjectSettings.globalize_path(out))
	if werr != OK:
		return _err("SAVE_FAILED", "could not save the screenshot (error %d)" % werr, "check that .godot/ is writable")
	return _ok({ "path": out, "width": img.get_width(), "height": img.get_height() })


func _rop_node_set(args: Dictionary) -> Dictionary:
	var np := str(args.get("node", ""))
	var n := _find(np)
	if n == null:
		return _node_err(np)
	var prop := str(args.get("property", ""))
	if not (prop in n):
		return _err("PROPERTY_NOT_FOUND", "'%s' has no property '%s'" % [n.name, prop], "runtime_node_get lists the live properties")
	n.set(prop, _parse(args.get("value")))
	return _ok({ "node": np, "property": prop, "value": _jsonable(n.get(prop)) })


func _rop_call(args: Dictionary) -> Dictionary:
	var np := str(args.get("node", ""))
	var n := _find(np)
	if n == null:
		return _node_err(np)
	var method := str(args.get("method", ""))
	if not n.has_method(method):
		return _err("METHOD_NOT_FOUND", "'%s' has no method '%s'" % [n.name, method], "check the node's script; runtime_node_get shows its type and script path")
	var raw = args.get("args", [])
	var cargs := []
	if typeof(raw) == TYPE_ARRAY:
		for a in raw:
			cargs.append(_parse(a))
	var ret = n.callv(method, cargs)
	return _ok({ "node": np, "method": method, "returned": _jsonable(ret) })


func _rop_eval(args: Dictionary) -> Dictionary:
	var expr_s := str(args.get("expression", ""))
	var base: Object = get_tree().current_scene
	var np := str(args.get("node", ""))
	if np != "":
		base = _find(np)
		if base == null:
			return _node_err(np)
	var ex := Expression.new()
	if ex.parse(expr_s) != OK:
		return _err("EXPR_PARSE", ex.get_error_text(), "Expression syntax only (no statements); e.g. get_node(\"Player\").position.x + 10")
	var ret = ex.execute([], base)
	if ex.has_execute_failed():
		return _err("EXPR_FAILED", ex.get_error_text(), "check that the context node has the referenced members; pass node: to change the context")
	return _ok({ "value": _jsonable(ret) })


func _rop_click(args: Dictionary) -> Dictionary:
	var target = args.get("target")
	var pos := Vector2.ZERO
	var parsed = _parse(target)
	if parsed is Vector2:
		pos = parsed
	elif typeof(parsed) == TYPE_ARRAY and parsed.size() == 2:
		pos = Vector2(float(parsed[0]), float(parsed[1]))
	else:
		var n := _find(str(target))
		if n == null:
			return _node_err(str(target))
		if not (n is Control):
			return _err("NOT_A_CONTROL", "'%s' is not a Control; give a Vector2 position instead" % str(target), "runtime_ui_list shows clickable controls with their rects")
		var ctrl := n as Control
		# Input.parse_input_event expects WINDOW coordinates; the canvas-space
		# rect center misses under content-scale stretch (canvas_items/viewport).
		if ctrl.has_method("get_screen_transform"):
			pos = (ctrl.get_screen_transform() as Transform2D) * (ctrl.size / 2.0)
		else:
			pos = ctrl.get_global_rect().get_center()
	var mv := InputEventMouseMotion.new()
	mv.position = pos
	mv.global_position = pos
	Input.parse_input_event(mv)
	for pressed in [true, false]:
		var ev := InputEventMouseButton.new()
		ev.button_index = MOUSE_BUTTON_LEFT
		ev.pressed = pressed
		ev.position = pos
		ev.global_position = pos
		Input.parse_input_event(ev)
	return _ok({ "clicked": { "x": pos.x, "y": pos.y } })


func _rop_navigate(args: Dictionary) -> Dictionary:
	var np := str(args.get("to", ""))
	var n := _find(np)
	if n == null:
		return _node_err(np)
	if not (n is Control):
		return _err("NOT_A_CONTROL", "'%s' is not a Control" % np, "navigate targets buttons/fields; runtime_ui_list shows them")
	(n as Control).grab_focus()
	for pressed in [true, false]:
		var ev := InputEventAction.new()
		ev.action = "ui_accept"
		ev.pressed = pressed
		Input.parse_input_event(ev)
	return _ok({ "activated": np })


func _rop_scene_change(args: Dictionary) -> Dictionary:
	var scene := str(args.get("scene", ""))
	if not scene.begins_with("res://") or scene.find("..") != -1:
		return _err("BAD_PATH", "scene must be a res://-relative path", "e.g. res://levels/level_2.tscn")
	if not ResourceLoader.exists(scene):
		return _err("NOT_FOUND", "no scene at %s" % scene, "project_file_search lists the project's scenes")
	var cerr := get_tree().change_scene_to_file(scene)
	if cerr != OK:
		return _err("SCENE_CHANGE_FAILED", "change_scene_to_file returned %d" % cerr, "is the file a PackedScene (.tscn/.scn)?")
	return _ok({ "changed_to": scene })


func _rop_record_start(args: Dictionary) -> Dictionary:
	if _is_recording:
		return _err("ALREADY_RECORDING", "a recording ('%s') is already active" % _recording_name, "runtime_record_stop first")
	_recording = []
	_recording_name = str(args.get("name", "recording-%d" % int(Time.get_unix_time_from_system())))
	_recording_t0 = Time.get_ticks_msec()
	_is_recording = true
	return _ok({ "recording": _recording_name })


func _rop_record_stop(_args: Dictionary) -> Dictionary:
	if not _is_recording:
		return _err("NOT_RECORDING", "no recording is active", "runtime_record_start first")
	_is_recording = false
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(REC_DIR))
	var path := "%s/%s.json" % [REC_DIR, _recording_name.validate_filename()]
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return _err("SAVE_FAILED", "could not open %s for writing" % path, "check that .godot/ is writable")
	f.store_string(JSON.stringify({
		"version": 1,
		"name": _recording_name,
		"duration_ms": Time.get_ticks_msec() - _recording_t0,
		"events": _recording,
	}))
	f.close()
	return _ok({ "saved": path, "events": _recording.size() })


func _rop_record_list(_args: Dictionary) -> Dictionary:
	var rows := []
	var dir := DirAccess.open(REC_DIR)
	if dir != null:
		for f in dir.get_files():
			if f.ends_with(".json"):
				rows.append(f.trim_suffix(".json"))
	return _ok({ "recordings": rows, "dir": REC_DIR })


func _rop_replay(args: Dictionary) -> Dictionary:
	var rec_name := str(args.get("name", ""))
	var fname := rec_name.validate_filename()
	if not fname.ends_with(".json"):
		fname += ".json"
	var path := "%s/%s" % [REC_DIR, fname]
	if not FileAccess.file_exists(path):
		return _err("NOT_FOUND", "no recording '%s'" % rec_name, "runtime_record_list shows the saved recordings")
	var data = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(data) != TYPE_DICTIONARY or typeof(data.get("events")) != TYPE_ARRAY:
		return _err("BAD_RECORDING", "the recording file is not parseable", "re-record it (runtime_record_start / runtime_record_stop)")
	var speed := maxf(0.05, float(args.get("speed", 1.0)))
	var t := 0.0
	var fed := 0
	for row in data["events"]:
		if typeof(row) != TYPE_DICTIONARY:
			continue
		var rt := float(row.get("t", 0))
		var wait_ms := (rt - t) / speed
		t = rt
		if wait_ms > 1.0:
			await get_tree().create_timer(wait_ms / 1000.0).timeout
		var ev := _desc_to_event(row.get("event", {}))
		if ev != null:
			Input.parse_input_event(ev)
			fed += 1
	return _ok({ "replayed": rec_name, "events": fed, "speed": speed })


# Supports signals with up to 6 arguments (the variadic-default lambda trick).
func _rop_wait_signal(args: Dictionary) -> Dictionary:
	var np := str(args.get("node", ""))
	var n := _find(np)
	if n == null:
		return _node_err(np)
	var sig := str(args.get("signal", ""))
	if not n.has_signal(sig):
		var sigs := []
		for s in n.get_signal_list():
			sigs.append(str(s["name"]))
		return _err("SIGNAL_NOT_FOUND", "'%s' has no signal '%s'" % [n.name, sig], "signals on this node: %s" % ", ".join(PackedStringArray(sigs)))
	var timeout := clampi(int(args.get("timeout_ms", 5000)), 1, 120000)
	var hit := []
	var cb := func(_a = null, _b = null, _c = null, _d = null, _e = null, _f = null):
		hit.append([_a, _b, _c, _d, _e, _f])
	n.connect(sig, cb)
	var t0 := Time.get_ticks_msec()
	while hit.is_empty() and Time.get_ticks_msec() - t0 < timeout:
		await get_tree().process_frame
		if not is_instance_valid(n):
			break
	if is_instance_valid(n) and n.is_connected(sig, cb):
		n.disconnect(sig, cb)
	if hit.is_empty():
		return _err("TIMEOUT", "signal '%s' did not fire within %d ms" % [sig, timeout], "raise timeout_ms, or check the emitting path with runtime_watch")
	return _ok({ "fired": sig, "waited_ms": Time.get_ticks_msec() - t0 })


func _rop_profile_monitors(args: Dictionary) -> Dictionary:
	var names = args.get("monitors", MONITORS.keys())
	if typeof(names) != TYPE_ARRAY or names.is_empty():
		names = MONITORS.keys()
	var out := {}
	for nm in names:
		if not MONITORS.has(str(nm)):
			return _err("BAD_ARGS", "unknown monitor '%s'" % str(nm), "known: %s" % ", ".join(MONITORS.keys()))
		out[str(nm)] = Performance.get_monitor(MONITORS[str(nm)])
	return _ok({ "monitors": out, "available": MONITORS.keys() })


func _rop_profile_snapshot(args: Dictionary) -> Dictionary:
	var duration := clampi(int(args.get("duration_ms", 2000)), 100, 30000)
	var acc := {}
	for k in MONITORS:
		acc[k] = []
	var t0 := Time.get_ticks_msec()
	while Time.get_ticks_msec() - t0 < duration:
		for k in MONITORS:
			acc[k].append(Performance.get_monitor(MONITORS[k]))
		await get_tree().create_timer(0.05).timeout
	var out := {}
	for k in MONITORS:
		var arr: Array = acc[k]
		if arr.is_empty():
			continue
		var mn = arr[0]
		var mx = arr[0]
		var total := 0.0
		for v in arr:
			mn = min(mn, v)
			mx = max(mx, v)
			total += v
		out[k] = { "min": mn, "avg": total / arr.size(), "max": mx, "samples": arr.size() }
	return _ok({ "duration_ms": duration, "monitors": out })


func _rop_test_assert(args: Dictionary) -> Dictionary:
	var expr_s := str(args.get("expression", ""))
	var ex := Expression.new()
	if ex.parse(expr_s) != OK:
		return _err("EXPR_PARSE", ex.get_error_text(), "Expression syntax only; e.g. get_node(\"Player\").health > 0")
	var v = ex.execute([], get_tree().current_scene)
	if ex.has_execute_failed():
		return _err("EXPR_FAILED", ex.get_error_text(), "check the node paths/members used in the expression")
	return _ok({ "passed": v == true, "value": _jsonable(v), "message": str(args.get("message", "")) })


# -- input simulation rops ----------------------------------------------------

func _rop_input_key(args: Dictionary) -> Dictionary:
	var keyname := str(args.get("key", ""))
	var code := OS.find_keycode_from_string(keyname)
	if code == KEY_NONE:
		return _err("BAD_KEY", "unknown key '%s'" % keyname, "use Godot key names: Space, Enter, Escape, A, F1, Up, ...")
	var modes := _press_modes(args)
	for pressed in modes:
		var ev := InputEventKey.new()
		ev.physical_keycode = code
		ev.keycode = code
		ev.pressed = pressed
		ev.shift_pressed = bool(args.get("shift", false))
		ev.ctrl_pressed = bool(args.get("ctrl", false))
		ev.alt_pressed = bool(args.get("alt", false))
		ev.meta_pressed = bool(args.get("meta", false))
		Input.parse_input_event(ev)
	return _ok({ "key": keyname, "sent": modes })


func _rop_input_mouse_button(args: Dictionary) -> Dictionary:
	var btn := _button_index(str(args.get("button", "left")))
	if btn == 0:
		return _err("BAD_BUTTON", "unknown mouse button '%s'" % str(args.get("button")), "use left|right|middle|wheel_up|wheel_down")
	var pos := _to_vec2(args.get("position"))
	var modes := _press_modes(args)
	var mv := InputEventMouseMotion.new()
	mv.position = pos
	mv.global_position = pos
	Input.parse_input_event(mv)
	for pressed in modes:
		var ev := InputEventMouseButton.new()
		ev.button_index = btn
		ev.pressed = pressed
		ev.position = pos
		ev.global_position = pos
		Input.parse_input_event(ev)
	return _ok({ "button": str(args.get("button", "left")), "at": { "x": pos.x, "y": pos.y }, "sent": modes })


func _rop_input_mouse_move(args: Dictionary) -> Dictionary:
	var pos := _to_vec2(args.get("position"))
	var ev := InputEventMouseMotion.new()
	ev.position = pos
	ev.global_position = pos
	if args.has("relative"):
		ev.relative = _to_vec2(args.get("relative"))
	Input.parse_input_event(ev)
	return _ok({ "moved_to": { "x": pos.x, "y": pos.y } })


func _rop_input_action(args: Dictionary) -> Dictionary:
	var action := str(args.get("action", ""))
	if not InputMap.has_action(action):
		return _err("ACTION_NOT_FOUND", "no InputMap action '%s'" % action, "input_map_list shows the actions; add one with input_map_add")
	var strength := clampf(float(args.get("strength", 1.0)), 0.0, 1.0)
	var modes := _press_modes(args)
	for pressed in modes:
		if pressed:
			Input.action_press(action, strength)
		else:
			Input.action_release(action)
	return _ok({ "action": action, "sent": modes, "strength": strength })


func _rop_input_sequence(args: Dictionary) -> Dictionary:
	var steps = args.get("steps", [])
	if typeof(steps) != TYPE_ARRAY or steps.is_empty():
		return _err("BAD_ARG", "steps must be a non-empty array", "entries: {\"key\": ...} | {\"button\": ..., \"position\": ...} | {\"action\": ...} | {\"wait_ms\": 250}")
	var done := 0
	for step in steps:
		if typeof(step) != TYPE_DICTIONARY:
			return _err("BAD_ARG", "step %d is not a dict" % done, "each step is one of key|button|action|wait_ms")
		if step.has("wait_ms"):
			await get_tree().create_timer(maxf(0.001, float(step["wait_ms"]) / 1000.0)).timeout
		elif step.has("key"):
			var r := _rop_input_key(step)
			if not r["ok"]:
				return r
		elif step.has("button"):
			var r := _rop_input_mouse_button(step)
			if not r["ok"]:
				return r
		elif step.has("action"):
			var r := _rop_input_action(step)
			if not r["ok"]:
				return r
		else:
			return _err("BAD_ARG", "step %d needs key|button|action|wait_ms" % done, "e.g. {\"key\": \"Space\"}, then {\"wait_ms\": 250}")
		done += 1
	return _ok({ "steps": done })


# -- log/error capture --------------------------------------------------------

# Godot 4.5+ exposes OS.add_logger(Logger). The subclass is compiled at runtime
# so this file still parses on older 4.x (where capture reports "unavailable" --
# there is no safe in-process print/push_error hook before 4.5).
func _install_logger() -> void:
	if not ClassDB.class_exists("Logger") or not OS.has_method("add_logger"):
		_capture_mode = "unavailable (Godot < 4.5: no OS.add_logger; runtime print capture is off)"
		return
	# Logger callbacks can fire from ANY thread — defer into the bridge so the
	# ring appends and socket writes stay on the main thread.
	var src := "extends Logger\n\nvar sink: Node = null\n\n"
	src += "func _log_error(function: String, file: String, line: int, code: String, rationale: String, editor_notify: bool, error_type: int, script_backtraces: Array) -> void:\n"
	src += "\tif sink != null:\n\t\tsink.call_deferred(\"capture_error\", { \"function\": function, \"file\": file, \"line\": line, \"code\": code, \"rationale\": rationale, \"type\": error_type })\n\n"
	src += "func _log_message(message: String, error: bool) -> void:\n"
	src += "\tif sink != null:\n\t\tsink.call_deferred(\"capture_log\", message, error)\n"
	var script := GDScript.new()
	script.source_code = src
	if script.reload() != OK:
		_capture_mode = "unavailable (the Logger subclass failed to compile on this Godot build)"
		return
	_logger = script.new()
	_logger.sink = self
	OS.add_logger(_logger)
	_capture_mode = "logger"


func capture_log(message: String, is_error: bool) -> void:
	var ring := _error_ring if is_error else _log_ring
	ring.append({ "t": Time.get_ticks_msec() - _started_ms, "message": message })
	while ring.size() > RING_MAX:
		ring.pop_front()


func capture_error(row: Dictionary) -> void:
	row["t"] = Time.get_ticks_msec() - _started_ms
	_error_ring.append(row)
	while _error_ring.size() > RING_MAX:
		_error_ring.pop_front()
	_send({ "event": "runtime_error", "data": row })


# -- helpers ------------------------------------------------------------------

func _ok(result) -> Dictionary:
	return { "ok": true, "result": result }


func _err(code: String, message: String, hint: String) -> Dictionary:
	return { "ok": false, "error": { "code": code, "message": message, "hint": hint } }


func _send(obj: Dictionary) -> void:
	if _peer == null or _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return
	_peer.put_data((JSON.stringify(obj) + "\n").to_utf8_buffer())


func _find(path_s: String) -> Node:
	var root := get_tree().root
	var cur := get_tree().current_scene
	if path_s == "" or path_s == "/root":
		return cur
	if path_s.begins_with("/"):
		return root.get_node_or_null(NodePath(path_s))
	if cur == null:
		return null
	if path_s == "." or path_s == str(cur.name):
		return cur
	return cur.get_node_or_null(NodePath(path_s))


func _node_err(path_s: String) -> Dictionary:
	var cur := get_tree().current_scene
	var near := []
	if cur != null:
		for c in cur.get_children():
			near.append(str(c.name))
	var cur_name := str(cur.name) if cur != null else "(no current scene)"
	return _err("NODE_NOT_FOUND", "no live node at '%s'" % path_s,
		"paths resolve against the current scene '%s'; its children: %s" % [cur_name, (", ".join(PackedStringArray(near)) if near.size() > 0 else "(none)")])


func _press_modes(args: Dictionary) -> Array:
	if args.has("pressed") and args["pressed"] != null:
		return [bool(args["pressed"])]
	return [true, false]


func _button_index(name_s: String) -> int:
	match name_s:
		"left":
			return MOUSE_BUTTON_LEFT
		"right":
			return MOUSE_BUTTON_RIGHT
		"middle":
			return MOUSE_BUTTON_MIDDLE
		"wheel_up":
			return MOUSE_BUTTON_WHEEL_UP
		"wheel_down":
			return MOUSE_BUTTON_WHEEL_DOWN
	return 0


func _to_vec2(v) -> Vector2:
	var parsed = _parse(v)
	if parsed is Vector2:
		return parsed
	if parsed is Vector2i:
		return Vector2(parsed)
	if typeof(parsed) == TYPE_ARRAY and parsed.size() == 2:
		return Vector2(float(parsed[0]), float(parsed[1]))
	if typeof(parsed) == TYPE_DICTIONARY and parsed.has("x") and parsed.has("y"):
		return Vector2(float(parsed["x"]), float(parsed["y"]))
	return Vector2.ZERO


# Minimal smart-type parsing, self-contained on the game side (mirrors
# core/types.gd editor-side; only strings are transformed).
func _parse(v):
	if typeof(v) != TYPE_STRING:
		return v
	var s: String = v.strip_edges()
	if s.begins_with("#"):
		# Match editor-side types.gd exactly: valid hex → Color, anything else
		# passes through as the raw string (never a default-black Color).
		return Color.html(s) if Color.html_is_valid(s) else v
	for ctor in ["Vector2i", "Vector2", "Vector3i", "Vector3", "Vector4", "Rect2i", "Rect2", "Color", "Quaternion"]:
		if s.begins_with(ctor + "("):
			var parsed = str_to_var(s)
			if parsed != null:
				return parsed
	if s.begins_with("NodePath(") or s.begins_with("^\""):
		var np = str_to_var(s)
		if np != null:
			return np
	return v


func _desc_to_event(d: Dictionary) -> InputEvent:
	match str(d.get("kind", "")):
		"key":
			var e := InputEventKey.new()
			e.physical_keycode = int(d.get("keycode", 0))
			e.keycode = e.physical_keycode
			e.pressed = bool(d.get("pressed", true))
			return e
		"mouse_button":
			var e := InputEventMouseButton.new()
			e.button_index = int(d.get("button", 1))
			e.pressed = bool(d.get("pressed", true))
			e.position = Vector2(float(d.get("x", 0)), float(d.get("y", 0)))
			e.global_position = e.position
			return e
		"mouse_motion":
			var e := InputEventMouseMotion.new()
			e.position = Vector2(float(d.get("x", 0)), float(d.get("y", 0)))
			e.global_position = e.position
			e.relative = Vector2(float(d.get("rx", 0)), float(d.get("ry", 0)))
			return e
	return null


func _event_desc(event: InputEvent) -> Dictionary:
	if event is InputEventKey:
		var e := event as InputEventKey
		var code = e.physical_keycode if e.physical_keycode != KEY_NONE else e.keycode
		return { "kind": "key", "keycode": code, "pressed": e.pressed, "echo": e.echo }
	if event is InputEventMouseButton:
		var e := event as InputEventMouseButton
		return { "kind": "mouse_button", "button": e.button_index, "pressed": e.pressed, "x": e.position.x, "y": e.position.y }
	if event is InputEventMouseMotion:
		var e := event as InputEventMouseMotion
		return { "kind": "mouse_motion", "x": e.position.x, "y": e.position.y, "rx": e.relative.x, "ry": e.relative.y }
	return {}


func _jsonable(v):
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return v
		TYPE_ARRAY:
			var a := []
			for e in v:
				a.append(_jsonable(e))
			return a
		TYPE_DICTIONARY:
			var d := {}
			for k in v:
				d[str(k)] = _jsonable(v[k])
			return d
		TYPE_OBJECT:
			return str(v)
		_:
			return var_to_str(v)


static func _token() -> String:
	if not FileAccess.file_exists(TOKEN_FILE):
		return ""
	return FileAccess.get_file_as_string(TOKEN_FILE).strip_edges()


static func _port() -> int:
	var env := OS.get_environment("MERCURY_GODOT_TOOLS_PORT")
	if env != "" and env.is_valid_int():
		return int(env)
	if FileAccess.file_exists(PORT_FILE):
		var t := FileAccess.get_file_as_string(PORT_FILE).strip_edges()
		if t.is_valid_int():
			return int(t)
	return 6010
