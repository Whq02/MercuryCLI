@tool
class_name MercuryVulcanAnimation
# categories/animation.gd -- the animation_* ops (Mercury VULCAN).
# AnimationPlayer authoring via AnimationLibrary; every mutate op is one
# ctx.undo action. Animation names accept "name" (searched across the player's
# libraries) or "library/name".

const TRACK_TYPES := {
	"value": Animation.TYPE_VALUE,
	"method": Animation.TYPE_METHOD,
	"bezier": Animation.TYPE_BEZIER,
}

const EASINGS := {
	"linear": 1.0,
	"ease_in": 2.0,
	"ease_out": 0.5,
	"smooth": 1.0,
}


static func ops() -> Array:
	return [
		"animation_list", "animation_create", "animation_remove",
		"animation_track_add", "animation_key_add", "animation_play",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var found := _player_of(args, ctx)
	if found.has("err"):
		return found["err"]
	var player: AnimationPlayer = found["node"]
	match op:
		"animation_list":
			return _list(player)
		"animation_create":
			return _create(player, args, ctx)
		"animation_remove":
			return _remove(player, args, ctx)
		"animation_track_add":
			return _track_add(player, args, ctx)
		"animation_key_add":
			return _key_add(player, args, ctx)
		"animation_play":
			return _play(player, args, ctx)
	return ctx.err("UNKNOWN_OP", "the animation category does not own '%s'" % op, "see MercuryVulcanAnimation.ops() for the animation op list")


static func _list(player: AnimationPlayer) -> Dictionary:
	var anims := {}
	for lib_name in player.get_animation_library_list():
		var lib := player.get_animation_library(lib_name)
		for a in lib.get_animation_list():
			var anim := lib.get_animation(a)
			var key := (str(lib_name) + "/" + str(a)) if str(lib_name) != "" else str(a)
			var tracks := []
			for i in anim.get_track_count():
				tracks.append(str(anim.track_get_path(i)))
			anims[key] = {
				"length": anim.length,
				"loop": anim.loop_mode != Animation.LOOP_NONE,
				"tracks": tracks,
			}
	return { "ok": true, "result": { "player": str(player.name), "animations": anims, "count": anims.size() } }


static func _create(player: AnimationPlayer, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var anim_name := str(args.get("name", ""))
	if anim_name == "":
		return ctx.err("BAD_ARG", "name is required", "e.g. {\"player\": \"AnimationPlayer\", \"name\": \"walk\", \"length\": 0.8}")
	if _find_anim(player, anim_name) != null:
		return ctx.err("ALREADY_EXISTS", "animation '%s' already exists on '%s'" % [anim_name, player.name], "animation_remove it first, or pick another name")
	var lib: AnimationLibrary = null
	var lib_created := false
	if player.has_animation_library(""):
		lib = player.get_animation_library("")
	else:
		lib = AnimationLibrary.new()
		lib_created = true
	var anim := Animation.new()
	anim.length = maxf(0.001, float(args.get("length", 1.0)))
	var do_add := func():
		if lib_created and not player.has_animation_library(""):
			player.add_animation_library("", lib)
		lib.add_animation(anim_name, anim)
	var undo_add := func():
		lib.remove_animation(anim_name)
		if lib_created and player.has_animation_library(""):
			player.remove_animation_library("")
	ctx.undo.action("vulcan: animation_create", do_add, undo_add)
	return { "ok": true, "result": { "animation": anim_name, "length": anim.length, "library": "" } }


static func _remove(player: AnimationPlayer, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var anim_name := str(args.get("name", ""))
	var hit := _find_anim(player, anim_name)
	if hit == null:
		return _anim_not_found(player, anim_name, ctx)
	var lib: AnimationLibrary = hit["lib"]
	var bare: String = hit["bare"]
	var saved: Animation = lib.get_animation(bare)
	var do_remove := func():
		lib.remove_animation(bare)
	var undo_remove := func():
		lib.add_animation(bare, saved)
	ctx.undo.action("vulcan: animation_remove", do_remove, undo_remove)
	return { "ok": true, "result": { "removed": anim_name } }


static func _track_add(player: AnimationPlayer, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var hit := _find_anim(player, str(args.get("animation", "")))
	if hit == null:
		return _anim_not_found(player, str(args.get("animation", "")), ctx)
	var anim: Animation = hit["anim"]
	var target_found := _node(args.get("node", ""), ctx)
	if target_found.has("err"):
		return target_found["err"]
	var target: Node = target_found["node"]
	var ttype_name := str(args.get("type", "value"))
	if not TRACK_TYPES.has(ttype_name):
		return ctx.err("BAD_ARG", "type must be value|method|bezier", "omit type for a plain value track")
	var ttype: int = TRACK_TYPES[ttype_name]
	var prop := str(args.get("property", ""))
	if prop == "" and ttype != Animation.TYPE_METHOD:
		return ctx.err("BAD_ARG", "property is required for value/bezier tracks", "e.g. {\"property\": \"position\"}")
	var anim_root: Node = player.get_node_or_null(player.root_node)
	if anim_root == null:
		anim_root = player.get_parent()
	if anim_root == null:
		return ctx.err("NO_ANIM_ROOT", "could not resolve the player's animation root node", "check the AnimationPlayer's root_node property")
	var rel := str(anim_root.get_path_to(target))
	var tpath := NodePath(rel) if ttype == Animation.TYPE_METHOD else NodePath(rel + ":" + prop)
	var added := [-1]
	var do_add := func():
		var idx := anim.add_track(ttype)
		anim.track_set_path(idx, tpath)
		added[0] = idx
	var undo_add := func():
		if added[0] >= 0 and added[0] < anim.get_track_count():
			anim.remove_track(added[0])
	ctx.undo.action("vulcan: animation_track_add", do_add, undo_add)
	return { "ok": true, "result": { "animation": str(args.get("animation")), "track": added[0], "path": str(tpath), "type": ttype_name } }


static func _key_add(player: AnimationPlayer, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var hit := _find_anim(player, str(args.get("animation", "")))
	if hit == null:
		return _anim_not_found(player, str(args.get("animation", "")), ctx)
	var anim: Animation = hit["anim"]
	var idx := _track_index(anim, args.get("track"))
	if idx < 0:
		var tracks := []
		for i in anim.get_track_count():
			tracks.append("%d: %s" % [i, str(anim.track_get_path(i))])
		return ctx.err("TRACK_NOT_FOUND", "no track matching %s" % str(args.get("track")), "tracks: %s" % ("; ".join(PackedStringArray(tracks)) if tracks.size() > 0 else "(none -- animation_track_add first)"))
	var time := maxf(0.0, float(args.get("time", 0.0)))
	var value = ctx.types.parse(args.get("value"))
	var trans := 1.0
	var easing = args.get("easing", null)
	if easing != null:
		if typeof(easing) == TYPE_STRING and EASINGS.has(str(easing)):
			trans = EASINGS[str(easing)]
		elif typeof(easing) in [TYPE_FLOAT, TYPE_INT]:
			trans = float(easing)
		else:
			return ctx.err("BAD_ARG", "easing must be a float or one of %s" % ", ".join(PackedStringArray(EASINGS.keys())), "omit easing for linear")
	if anim.track_get_type(idx) == Animation.TYPE_BEZIER and typeof(value) not in [TYPE_FLOAT, TYPE_INT]:
		return ctx.err("BAD_ARG", "bezier tracks take float values", "pass a numeric value")
	# Inserting at an occupied time OVERWRITES that key — capture it so undo
	# restores the original keyframe instead of deleting the slot outright.
	var existing := anim.track_find_key(idx, time, Animation.FIND_MODE_EXACT)
	var old_value = anim.track_get_key_value(idx, existing) if existing >= 0 else null
	var old_trans: float = anim.track_get_key_transition(idx, existing) if existing >= 0 else 1.0
	var do_add := func():
		anim.track_insert_key(idx, time, value, trans)
	var undo_add := func():
		anim.track_remove_key_at_time(idx, time)
		if existing >= 0:
			anim.track_insert_key(idx, time, old_value, old_trans)
	ctx.undo.action("vulcan: animation_key_add", do_add, undo_add)
	if time > anim.length:
		return { "ok": true, "result": { "track": idx, "time": time, "note": "the key sits past the animation length (%.2fs); raise it via animation_create's length or the inspector" % anim.length } }
	return { "ok": true, "result": { "track": idx, "time": time } }


static func _play(player: AnimationPlayer, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var anim_name := str(args.get("name", ""))
	var hit := _find_anim(player, anim_name)
	if hit == null:
		return _anim_not_found(player, anim_name, ctx)
	player.play(hit["full"])
	return { "ok": true, "result": {
		"playing": hit["full"],
		"note": "editor preview: if nothing moves, drive it from a play session instead (scene_play + runtime ops)",
	} }


# -- helpers --

# Resolves args.player (NodePath) or falls back to the first AnimationPlayer
# in the edited scene.
static func _player_of(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var pv := str(args.get("player", ""))
	if pv != "":
		var found := _node(pv, ctx)
		if found.has("err"):
			return found
		if not (found["node"] is AnimationPlayer):
			return { "err": ctx.err("NOT_A_PLAYER", "'%s' is a %s, not an AnimationPlayer" % [pv, found["node"].get_class()], "animation_list with no player arg finds the first AnimationPlayer") }
		return found
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return { "err": ctx.err("NO_SCENE", "no scene is being edited", "open a scene containing an AnimationPlayer") }
	var q := [root]
	while not q.is_empty():
		var n: Node = q.pop_front()
		if n is AnimationPlayer:
			return { "node": n }
		for c in n.get_children():
			q.append(c)
	return { "err": ctx.err("NO_PLAYER", "no AnimationPlayer in the edited scene", "node_add an AnimationPlayer first") }


# Accepts "name" or "library/name"; returns {lib, lib_name, bare, full, anim} or null.
static func _find_anim(player: AnimationPlayer, anim_name: String) -> Variant:
	if anim_name == "":
		return null
	var want_lib := ""
	var bare := anim_name
	if anim_name.contains("/"):
		want_lib = anim_name.get_slice("/", 0)
		bare = anim_name.substr(want_lib.length() + 1)
	for lib_name in player.get_animation_library_list():
		if want_lib != "" and str(lib_name) != want_lib:
			continue
		var lib := player.get_animation_library(lib_name)
		if lib.has_animation(bare):
			var full := (str(lib_name) + "/" + bare) if str(lib_name) != "" else bare
			return { "lib": lib, "lib_name": str(lib_name), "bare": bare, "full": full, "anim": lib.get_animation(bare) }
	return null


static func _anim_not_found(player: AnimationPlayer, anim_name: String, ctx: MercuryVulcanContext) -> Dictionary:
	var names := []
	for lib_name in player.get_animation_library_list():
		for a in player.get_animation_library(lib_name).get_animation_list():
			names.append((str(lib_name) + "/" + str(a)) if str(lib_name) != "" else str(a))
	return ctx.err("ANIMATION_NOT_FOUND", "no animation '%s' on '%s'" % [anim_name, player.name],
		"animations: %s" % (", ".join(PackedStringArray(names)) if names.size() > 0 else "(none -- animation_create first)"))


# Track by index (int) or by "node:property" path match (suffix tolerated).
static func _track_index(anim: Animation, track_v) -> int:
	if typeof(track_v) in [TYPE_INT, TYPE_FLOAT]:
		var i := int(track_v)
		return i if i >= 0 and i < anim.get_track_count() else -1
	var s := str(track_v)
	if s == "":
		return -1
	if s.is_valid_int():
		var i := int(s)
		return i if i >= 0 and i < anim.get_track_count() else -1
	for i in anim.get_track_count():
		var p := str(anim.track_get_path(i))
		if p == s or p.ends_with(s):
			return i
	return -1


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
