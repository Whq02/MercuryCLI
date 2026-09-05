@tool
class_name MercuryVulcanRuntime

const REQUIRED := {
	"runtime_node_get": ["node"],
	"runtime_watch": ["node", "property"],
	"runtime_node_set": ["node", "property", "value"],
	"runtime_call": ["node", "method"],
	"runtime_eval": ["expression"],
	"runtime_click": ["target"],
	"runtime_navigate": ["to"],
	"runtime_scene_change": ["scene"],
	"runtime_replay": ["name"],
}


static func ops() -> Array:
	return [
		"runtime_status", "runtime_tree", "runtime_node_get", "runtime_log",
		"runtime_errors", "runtime_ui_list", "runtime_ui_text", "runtime_watch",
		"runtime_record_list", "runtime_screenshot", "runtime_node_set", "runtime_call",
		"runtime_eval", "runtime_click", "runtime_navigate", "runtime_scene_change",
		"runtime_record_start", "runtime_record_stop", "runtime_replay",
		"runtime_step", "runtime_pause", "runtime_resume",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if not ops().has(op):
		return ctx.err("UNKNOWN_OP", "the runtime category does not own '%s'" % op, "see MercuryVulcanRuntime.ops() for the runtime op list")
	if ctx.runtime == null:
		return ctx.err("NO_RUNTIME", "'%s' needs a running, bridged play session" % op, "start a play session with scene_play first")
	for req in REQUIRED.get(op, []):
		if not args.has(req) or (typeof(args[req]) == TYPE_STRING and str(args[req]) == ""):
			return ctx.err("BAD_ARG", "'%s' requires '%s'" % [op, req], "required args: %s" % ", ".join(PackedStringArray(REQUIRED[op])))
	if op == "runtime_step":
		var bad := step_window_error(args, "frames", "ms", ctx)
		if not bad.is_empty():
			return bad
	var send := args
	if op == "runtime_scene_change":
		var p: String = ctx.paths.require_res(str(args["scene"]))
		if p == "":
			return ctx.err("BAD_PATH", "scene must be a res://-relative .tscn path", "e.g. res://levels/level_2.tscn")
		send = args.duplicate(true)
		send["scene"] = p
	if op == "runtime_screenshot" and args.has("out") and str(args["out"]) != "":
		var p: String = ctx.paths.require_res(str(args["out"]))
		if p == "":
			return ctx.err("BAD_PATH", "out must be a res://-relative path", "e.g. res://.godot/mercury-vulcan-shots/menu.png")
		send = args.duplicate(true)
		send["out"] = p
	return await ctx.runtime.request(op, send)


const STEP_FRAMES_MAX := 3600
const STEP_MS_MAX := 60000


static func step_window_error(args: Dictionary, frames_key: String, ms_key: String, ctx: MercuryVulcanContext) -> Dictionary:
	var has_frames: bool = args.get(frames_key) != null
	var has_ms: bool = args.get(ms_key) != null
	if has_frames and has_ms:
		return ctx.err("BAD_ARG", "pass %s or %s, not both" % [frames_key, ms_key], "e.g. {\"%s\": 30} or {\"%s\": 500}" % [frames_key, ms_key])
	if has_frames:
		var v = args[frames_key]
		var numeric: bool = typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT
		if not numeric or float(v) != floor(float(v)) or int(v) < 1 or int(v) > STEP_FRAMES_MAX:
			return ctx.err("BAD_ARG", "%s must be a whole number 1..%d" % [frames_key, STEP_FRAMES_MAX], "one process frame is 1/60 s at 60 fps; %s names game time instead" % ms_key)
	if has_ms:
		var v = args[ms_key]
		if not (typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT) or int(v) < 1 or int(v) > STEP_MS_MAX:
			return ctx.err("BAD_ARG", "%s must be 1..%d" % [ms_key, STEP_MS_MAX], "game-time milliseconds; the window ends at the first frame boundary past it")
	return {}
