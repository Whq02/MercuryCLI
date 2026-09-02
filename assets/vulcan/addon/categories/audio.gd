@tool
class_name MercuryVulcanAudio
# categories/audio.gd -- the audio_* ops (Mercury VULCAN).
# Bus ops act on the live AudioServer and are PERSISTED to the project's bus
# layout resource (audio/buses/default_bus_layout): the layout file is written
# after every bus mutation -- and created if the project has none yet, since an
# unsaved bus edit would otherwise evaporate on editor restart (the result
# reports created:true when that happens). Every mutate op is one ctx.undo
# action whose do AND undo re-save the layout.

const PLAYER_TYPES := ["AudioStreamPlayer", "AudioStreamPlayer2D", "AudioStreamPlayer3D"]

const EFFECTS := {
	"reverb": "AudioEffectReverb",
	"delay": "AudioEffectDelay",
	"chorus": "AudioEffectChorus",
	"compressor": "AudioEffectCompressor",
	"distortion": "AudioEffectDistortion",
	"eq": "AudioEffectEQ10",
	"limiter": "AudioEffectLimiter",
	"pitch_shift": "AudioEffectPitchShift",
}


static func ops() -> Array:
	return [
		"audio_bus_list", "audio_player_create", "audio_bus_add",
		"audio_bus_set", "audio_effect_add", "audio_play",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"audio_bus_list":
			return _bus_list()
		"audio_player_create":
			return _player_create(args, ctx)
		"audio_bus_add":
			return _bus_add(args, ctx)
		"audio_bus_set":
			return _bus_set(args, ctx)
		"audio_effect_add":
			return _effect_add(args, ctx)
		"audio_play":
			return _play(args, ctx)
	return ctx.err("UNKNOWN_OP", "the audio category does not own '%s'" % op, "see MercuryVulcanAudio.ops() for the audio op list")


static func _bus_list() -> Dictionary:
	var buses := []
	for i in AudioServer.bus_count:
		var effects := []
		for j in AudioServer.get_bus_effect_count(i):
			effects.append({
				"type": AudioServer.get_bus_effect(i, j).get_class(),
				"enabled": AudioServer.is_bus_effect_enabled(i, j),
			})
		buses.append({
			"index": i,
			"name": AudioServer.get_bus_name(i),
			"volume_db": AudioServer.get_bus_volume_db(i),
			"mute": AudioServer.is_bus_mute(i),
			"solo": AudioServer.is_bus_solo(i),
			"send": str(AudioServer.get_bus_send(i)),
			"effects": effects,
		})
	return { "ok": true, "result": { "buses": buses, "layout_file": _layout_path() } }


static func _player_create(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var parent_found := _node(args.get("parent", ""), ctx)
	if parent_found.has("err"):
		return parent_found["err"]
	var parent: Node = parent_found["node"]
	var type := str(args.get("type", "AudioStreamPlayer"))
	if not PLAYER_TYPES.has(type):
		return ctx.err("BAD_ARG", "type must be one of %s" % ", ".join(PackedStringArray(PLAYER_TYPES)), "omit type for a plain AudioStreamPlayer")
	var stream_raw := str(args.get("stream", ""))
	if stream_raw == "":
		return ctx.err("BAD_ARG", "stream is required", "pass a res:// audio file (.ogg/.wav/.mp3)")
	var stream_path: String = ctx.paths.require_res(stream_raw)
	if stream_path == "":
		return ctx.err("BAD_PATH", "stream must be a res://-relative path", "e.g. res://audio/jump.ogg")
	var stream = load(stream_path)
	if stream == null or not (stream is AudioStream):
		return ctx.err("BAD_STREAM", "%s did not load as an AudioStream" % stream_path, "is the file imported? try editor_reload what:'filesystem'")
	var bus := str(args.get("bus", ""))
	if bus != "" and _bus_index(bus) == -1:
		return _bus_not_found(bus, ctx)
	var root: Node = ctx.editor.get_edited_scene_root()
	var player: Node = ClassDB.instantiate(type)
	if args.has("name") and str(args["name"]) != "":
		player.name = str(args["name"])
	player.set("stream", stream)
	if bus != "":
		player.set("bus", bus)
	player.set("autoplay", bool(args.get("autoplay", false)))
	var do_add := func():
		parent.add_child(player)
		player.owner = root
	var undo_add := func():
		if player.get_parent() == parent:
			parent.remove_child(player)
	ctx.undo.action("vulcan: audio_player_create", do_add, undo_add)
	return { "ok": true, "result": { "created": str(root.get_path_to(player)), "type": type, "stream": stream_path, "bus": (bus if bus != "" else "Master") } }


static func _bus_add(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var bus_name := str(args.get("name", ""))
	if bus_name == "":
		return ctx.err("BAD_ARG", "name is required", "e.g. {\"name\": \"SFX\", \"send\": \"Master\"}")
	if _bus_index(bus_name) != -1:
		return ctx.err("ALREADY_EXISTS", "bus '%s' already exists" % bus_name, "audio_bus_set tunes it")
	var send := str(args.get("send", "Master"))
	if _bus_index(send) == -1:
		return _bus_not_found(send, ctx)
	var existed_before := FileAccess.file_exists(_layout_path())
	var do_add := func():
		var idx := AudioServer.bus_count
		AudioServer.add_bus(idx)
		AudioServer.set_bus_name(idx, bus_name)
		AudioServer.set_bus_send(idx, send)
		_save_layout()
	var undo_add := func():
		var i := _bus_index(bus_name)
		if i > 0:
			AudioServer.remove_bus(i)
		_save_layout()
	ctx.undo.action("vulcan: audio_bus_add", do_add, undo_add)
	var saved := _layout_state()
	return { "ok": true, "result": { "bus": bus_name, "send": send, "layout_saved": saved["saved"], "layout_created": saved["saved"] and not existed_before, "layout_file": saved["path"] } }


static func _bus_set(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var bus_name := str(args.get("bus", ""))
	var idx := _bus_index(bus_name)
	if idx == -1:
		return _bus_not_found(bus_name, ctx)
	var prop := str(args.get("property", ""))
	var raw = ctx.types.parse(args.get("value"))
	var prev = null
	var do_set: Callable
	var undo_set: Callable
	match prop:
		"volume_db":
			prev = AudioServer.get_bus_volume_db(idx)
			var v := float(raw)
			do_set = func():
				AudioServer.set_bus_volume_db(idx, v)
				_save_layout()
			undo_set = func():
				AudioServer.set_bus_volume_db(idx, prev)
				_save_layout()
		"mute":
			prev = AudioServer.is_bus_mute(idx)
			var v := bool(raw)
			do_set = func():
				AudioServer.set_bus_mute(idx, v)
				_save_layout()
			undo_set = func():
				AudioServer.set_bus_mute(idx, prev)
				_save_layout()
		"solo":
			prev = AudioServer.is_bus_solo(idx)
			var v := bool(raw)
			do_set = func():
				AudioServer.set_bus_solo(idx, v)
				_save_layout()
			undo_set = func():
				AudioServer.set_bus_solo(idx, prev)
				_save_layout()
		"send":
			prev = str(AudioServer.get_bus_send(idx))
			var v := str(raw)
			if _bus_index(v) == -1:
				return _bus_not_found(v, ctx)
			do_set = func():
				AudioServer.set_bus_send(idx, v)
				_save_layout()
			undo_set = func():
				AudioServer.set_bus_send(idx, prev)
				_save_layout()
		_:
			return ctx.err("BAD_ARG", "property must be volume_db|mute|solo|send", "e.g. {\"bus\": \"SFX\", \"property\": \"volume_db\", \"value\": -6}")
	ctx.undo.action("vulcan: audio_bus_set", do_set, undo_set)
	var saved := _layout_state()
	return { "ok": true, "result": { "bus": bus_name, "property": prop, "value": str(raw), "was": str(prev), "layout_saved": saved["saved"] } }


static func _effect_add(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var bus_name := str(args.get("bus", ""))
	var idx := _bus_index(bus_name)
	if idx == -1:
		return _bus_not_found(bus_name, ctx)
	var effect_key := str(args.get("effect", ""))
	if not EFFECTS.has(effect_key):
		return ctx.err("BAD_ARG", "effect must be one of %s" % ", ".join(PackedStringArray(EFFECTS.keys())), "e.g. {\"bus\": \"SFX\", \"effect\": \"reverb\"}")
	var fx: AudioEffect = ClassDB.instantiate(EFFECTS[effect_key])
	var props = args.get("properties", {})
	if typeof(props) == TYPE_DICTIONARY and not props.is_empty():
		var parsed: Dictionary = ctx.types.parse_dict(props) if ctx.types.has_method("parse_dict") else props
		for k in parsed:
			fx.set(str(k), parsed[k])
	var pos := [-1]
	var do_add := func():
		pos[0] = AudioServer.get_bus_effect_count(idx)
		AudioServer.add_bus_effect(idx, fx)
		_save_layout()
	var undo_add := func():
		if pos[0] >= 0 and pos[0] < AudioServer.get_bus_effect_count(idx):
			AudioServer.remove_bus_effect(idx, pos[0])
		_save_layout()
	ctx.undo.action("vulcan: audio_effect_add", do_add, undo_add)
	var saved := _layout_state()
	return { "ok": true, "result": { "bus": bus_name, "effect": EFFECTS[effect_key], "slot": pos[0], "layout_saved": saved["saved"] } }


static func _play(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var found := _node(args.get("player", ""), ctx)
	if found.has("err"):
		return found["err"]
	var player: Node = found["node"]
	if not PLAYER_TYPES.has(player.get_class()):
		return ctx.err("NOT_A_PLAYER", "'%s' is a %s, not an AudioStreamPlayer" % [str(args.get("player")), player.get_class()], "audio_player_create adds one")
	if player.get("stream") == null:
		return ctx.err("NO_STREAM", "the player has no stream assigned", "audio_player_create sets one, or node_set_property stream")
	player.call("play", float(args.get("from", 0.0)))
	return { "ok": true, "result": {
		"playing": bool(player.get("playing")),
		"note": "editor preview: 3D/2D players are positional -- if inaudible in the editor, verify in a play session",
	} }


# -- helpers --

static func _bus_index(bus_name: String) -> int:
	for i in AudioServer.bus_count:
		if AudioServer.get_bus_name(i) == bus_name:
			return i
	return -1


static func _bus_not_found(bus_name: String, ctx: MercuryVulcanContext) -> Dictionary:
	var names := []
	for i in AudioServer.bus_count:
		names.append(AudioServer.get_bus_name(i))
	return ctx.err("BUS_NOT_FOUND", "no audio bus named '%s'" % bus_name, "buses: %s (audio_bus_add creates one)" % ", ".join(PackedStringArray(names)))


static func _layout_path() -> String:
	return str(ProjectSettings.get_setting("audio/buses/default_bus_layout", "res://default_bus_layout.tres"))


static func _save_layout() -> void:
	var layout := AudioServer.generate_bus_layout()
	ResourceSaver.save(layout, _layout_path())


static func _layout_state() -> Dictionary:
	var path := _layout_path()
	return { "saved": FileAccess.file_exists(path), "path": path }


static func _node(path_v, ctx: MercuryVulcanContext) -> Dictionary:
	var path := str(path_v)
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return { "err": ctx.err("NO_SCENE", "no scene is being edited", "open or create a scene first (scene_open / scene_create)") }
	if path == "" or path == "." or path == str(root.name):
		return { "node": root }
	var n: Node = root.get_node_or_null(NodePath(path))
	if n == null:
		var near := []
		for c in root.get_children():
			near.append(str(c.name))
		var hint := "paths are relative to the scene root '%s'; top-level children: %s" % [root.name, (", ".join(PackedStringArray(near)) if near.size() > 0 else "(none)")]
		return { "err": ctx.err("NODE_NOT_FOUND", "no node at '%s' in the edited scene" % path, hint) }
	return { "node": n }
