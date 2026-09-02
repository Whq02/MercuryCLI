@tool
class_name MercuryVulcanInput
# categories/input.gd -- the input_* ops (Mercury VULCAN).
# input_map_* edit the project's InputMap through ProjectSettings "input/" entries
# (saved, undoable). Simulation ops REQUIRE a bridged play session (ctx.runtime):
# the editor side validates + normalizes the event description, the play-mode
# bridge (core/runtime_bridge.gd) synthesizes the real InputEvent via
# Input.parse_input_event. Positions travel as [x, y] arrays (JSON-safe).

const SIM_OPS := ["input_key", "input_mouse_button", "input_mouse_move", "input_action", "input_sequence"]


static func ops() -> Array:
	return [
		"input_map_list", "input_map_add", "input_key", "input_mouse_button",
		"input_mouse_move", "input_action", "input_sequence",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"input_map_list":
			return _map_list(ctx)
		"input_map_add":
			return _map_add(args, ctx)
	if SIM_OPS.has(op):
		return await _sim(op, args, ctx)
	return ctx.err("UNKNOWN_OP", "the input category does not own '%s'" % op, "see MercuryVulcanInput.ops() for the input op list")


static func _map_list(ctx: MercuryVulcanContext) -> Dictionary:
	var actions := {}
	for prop in ProjectSettings.get_property_list():
		var pname: String = prop["name"]
		if not pname.begins_with("input/"):
			continue
		var action := pname.substr(6)
		var v = ProjectSettings.get_setting(pname)
		var events := []
		var deadzone := 0.5
		if typeof(v) == TYPE_DICTIONARY:
			deadzone = float(v.get("deadzone", 0.5))
			for ev in v.get("events", []):
				events.append(_describe_event(ev))
		actions[action] = { "deadzone": deadzone, "events": events }
	return { "ok": true, "result": { "actions": actions, "count": actions.size() } }


static func _map_add(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var action := str(args.get("action", ""))
	if action == "":
		return ctx.err("BAD_ARG", "action is required", "e.g. {\"action\": \"jump\", \"events\": [{\"key\": \"Space\"}]}")
	var descs = args.get("events", [])
	if typeof(descs) != TYPE_ARRAY or descs.is_empty():
		return ctx.err("BAD_ARG", "events must be a non-empty array", "each entry: {\"key\": \"Space\"} | {\"button\": \"left\"} | {\"joy_button\": 0}")
	var new_events := []
	for d in descs:
		var built := _build_event(d, ctx)
		if built.has("err"):
			return built["err"]
		new_events.append(built["event"])
	var setting := "input/" + action
	var prev = ProjectSettings.get_setting(setting) if ProjectSettings.has_setting(setting) else null
	var merged := { "deadzone": 0.5, "events": [] }
	if typeof(prev) == TYPE_DICTIONARY:
		merged["deadzone"] = prev.get("deadzone", 0.5)
		merged["events"] = (prev.get("events", []) as Array).duplicate()
	if args.has("deadzone"):
		merged["deadzone"] = float(args["deadzone"])
	for e in new_events:
		merged["events"].append(e)
	var do_set := func():
		ProjectSettings.set_setting(setting, merged)
		ProjectSettings.save()
	var undo_set := func():
		ProjectSettings.set_setting(setting, prev)
		ProjectSettings.save()
	ctx.undo.action("vulcan: input_map_add", do_set, undo_set)
	return { "ok": true, "result": { "action": action, "events": (merged["events"] as Array).size(), "saved": true, "existed": prev != null } }


static func _sim(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if ctx.runtime == null:
		return ctx.err("NO_RUNTIME", "input simulation needs a running, bridged play session", "start a play session with scene_play first")
	var norm := _normalize(op, args, ctx)
	if norm.has("err"):
		return norm["err"]
	return await ctx.runtime.request(op, norm["args"])


static func _normalize(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var out := args.duplicate(true)
	match op:
		"input_key":
			var keyname := str(args.get("key", ""))
			if keyname == "":
				return { "err": ctx.err("BAD_ARG", "key is required", "e.g. {\"key\": \"Space\"}; omit pressed for a tap") }
			if OS.find_keycode_from_string(keyname) == KEY_NONE:
				return { "err": ctx.err("BAD_KEY", "unknown key '%s'" % keyname, "use Godot key names: Space, Enter, Escape, A, F1, Up, ...") }
		"input_mouse_button":
			if _button_index(str(args.get("button", "left"))) == 0:
				return { "err": ctx.err("BAD_BUTTON", "unknown mouse button '%s'" % str(args.get("button")), "use left|right|middle|wheel_up|wheel_down") }
			var pos := _position_arg(args.get("position"), ctx)
			if pos.has("err"):
				return pos
			out["position"] = pos["value"]
		"input_mouse_move":
			var pos := _position_arg(args.get("position"), ctx)
			if pos.has("err"):
				return pos
			out["position"] = pos["value"]
			if args.has("relative"):
				var rel := _position_arg(args.get("relative"), ctx)
				if rel.has("err"):
					return rel
				out["relative"] = rel["value"]
		"input_action":
			if str(args.get("action", "")) == "":
				return { "err": ctx.err("BAD_ARG", "action is required", "input_map_list shows the mapped actions") }
		"input_sequence":
			var steps = args.get("steps", [])
			if typeof(steps) != TYPE_ARRAY or steps.is_empty():
				return { "err": ctx.err("BAD_ARG", "steps must be a non-empty array", "entries: {\"key\": ...} | {\"button\": ..., \"position\": ...} | {\"action\": ...} | {\"wait_ms\": 250}") }
			var normed := []
			var i := 0
			for step in steps:
				if typeof(step) != TYPE_DICTIONARY:
					return { "err": ctx.err("BAD_ARG", "step %d is not a dict" % i, "each step is one of key|button|action|wait_ms") }
				if not (step.has("key") or step.has("button") or step.has("action") or step.has("wait_ms")):
					return { "err": ctx.err("BAD_ARG", "step %d needs key|button|action|wait_ms" % i, "e.g. {\"key\": \"Space\"}, then {\"wait_ms\": 250}") }
				var s: Dictionary = step.duplicate(true)
				if s.has("position"):
					var pos := _position_arg(s.get("position"), ctx)
					if pos.has("err"):
						return pos
					s["position"] = pos["value"]
				normed.append(s)
				i += 1
			out["steps"] = normed
	return { "args": out }


# Accepts "Vector2(100, 200)" strings (ctx.types), [x, y] arrays, and {x, y}
# dicts; normalizes to a JSON-safe [x, y] array for the wire.
static func _position_arg(v, ctx: MercuryVulcanContext) -> Dictionary:
	if v == null:
		return { "value": [0.0, 0.0] }
	var parsed = v
	if typeof(v) == TYPE_STRING:
		parsed = ctx.types.parse(v)
	if parsed is Vector2 or parsed is Vector2i:
		return { "value": [float(parsed.x), float(parsed.y)] }
	if typeof(parsed) == TYPE_ARRAY and parsed.size() == 2:
		return { "value": [float(parsed[0]), float(parsed[1])] }
	if typeof(parsed) == TYPE_DICTIONARY and parsed.has("x") and parsed.has("y"):
		return { "value": [float(parsed["x"]), float(parsed["y"])] }
	return { "err": ctx.err("BAD_POSITION", "could not read a position from %s" % str(v), "pass \"Vector2(100, 200)\", [100, 200], or {\"x\": 100, \"y\": 200}") }


static func _build_event(d, ctx: MercuryVulcanContext) -> Dictionary:
	if typeof(d) != TYPE_DICTIONARY:
		return { "err": ctx.err("BAD_ARG", "each event must be a dict", "e.g. {\"key\": \"Space\"} or {\"button\": \"left\"}") }
	if d.has("key"):
		var code := OS.find_keycode_from_string(str(d["key"]))
		if code == KEY_NONE:
			return { "err": ctx.err("BAD_KEY", "unknown key '%s'" % str(d["key"]), "use Godot key names: Space, Enter, A, Escape, F1, ...") }
		var ev := InputEventKey.new()
		ev.physical_keycode = code
		ev.keycode = code
		ev.shift_pressed = bool(d.get("shift", false))
		ev.ctrl_pressed = bool(d.get("ctrl", false))
		ev.alt_pressed = bool(d.get("alt", false))
		ev.meta_pressed = bool(d.get("meta", false))
		return { "event": ev }
	if d.has("button"):
		var btn := _button_index(str(d["button"]))
		if btn == 0:
			return { "err": ctx.err("BAD_BUTTON", "unknown mouse button '%s'" % str(d["button"]), "use left|right|middle|wheel_up|wheel_down") }
		var ev := InputEventMouseButton.new()
		ev.button_index = btn
		return { "event": ev }
	if d.has("joy_button"):
		var ev := InputEventJoypadButton.new()
		ev.button_index = int(d["joy_button"])
		return { "event": ev }
	return { "err": ctx.err("BAD_ARG", "event needs key, button, or joy_button", "e.g. {\"key\": \"Space\"}") }


static func _describe_event(ev) -> Dictionary:
	if ev is InputEventKey:
		var code = ev.physical_keycode if ev.physical_keycode != KEY_NONE else ev.keycode
		return { "kind": "key", "key": OS.get_keycode_string(code), "text": ev.as_text() }
	if ev is InputEventMouseButton:
		return { "kind": "mouse_button", "button": ev.button_index, "text": ev.as_text() }
	if ev is InputEventJoypadButton:
		return { "kind": "joy_button", "button": ev.button_index, "text": ev.as_text() }
	if ev is InputEvent:
		return { "kind": ev.get_class(), "text": ev.as_text() }
	return { "kind": "unknown" }


static func _button_index(name: String) -> int:
	match name:
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