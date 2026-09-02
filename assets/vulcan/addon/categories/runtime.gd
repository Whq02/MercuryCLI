@tool
class_name MercuryVulcanRuntime
# categories/runtime.gd -- the runtime_* ops (Mercury VULCAN).
# EVERY op here is forwarded to the play-session bridge (core/runtime_bridge.gd).
#
# THE FORWARDING CONTRACT (both halves pin this):
#   editor -> bridge : {"id": <int>, "rop": "<op>", "args": {...}}     (one JSON per line)
#   bridge -> editor : {"id": <int>, "ok": true, "result": <json>} |
#                      {"id": <int>, "ok": false, "error": {"code", "message", "hint"}}
#   bridge -> editor : {"event": "runtime_error"|"runtime_log", "data": <json>}  (unsolicited)
# ctx.runtime is the proxy over the role:"runtime" connection and exposes
#   request(op: String, args: Dictionary) -> Dictionary   (AWAITABLE)
# returning the answer envelope; core/server.gd translates it onto the "rop"
# wire frame above. ctx.runtime is null when no play session is bridged --
# every op then answers NO_RUNTIME with the scene_play hint.
#
# The bridge additionally serves rops for other categories (same contract):
# profile_monitors, profile_snapshot (profiling), test_assert (testing),
# runtime_wait_signal (frontier), input_* simulation (input).

# Editor-side pre-flight: required arg names per op, for teaching errors before
# anything crosses the wire.
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
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if not ops().has(op):
		return ctx.err("UNKNOWN_OP", "the runtime category does not own '%s'" % op, "see MercuryVulcanRuntime.ops() for the runtime op list")
	if ctx.runtime == null:
		return ctx.err("NO_RUNTIME", "'%s' needs a running, bridged play session" % op, "start a play session with scene_play first")
	for req in REQUIRED.get(op, []):
		if not args.has(req) or (typeof(args[req]) == TYPE_STRING and str(args[req]) == ""):
			return ctx.err("BAD_ARG", "'%s' requires '%s'" % [op, req], "required args: %s" % ", ".join(PackedStringArray(REQUIRED[op])))
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
