@tool
class_name MercuryVulcanProfiling
# mercury_vulcan — Profiling category handlers (static module, read-only).
# With a live play session both ops FORWARD to the runtime bridge (game-side numbers).
# Editor-side (no play session) they read the editor process's Performance monitors;
# profile_snapshot editor-side is a SINGLE-FRAME sample honestly labeled as such —
# blocking the editor main loop to sample a window would freeze the very monitors
# being sampled, so a real min/avg/max series needs the runtime bridge.


static func ops() -> Array:
	return ["profile_monitors", "profile_snapshot"]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"profile_monitors":
			return await _monitors(args, ctx)
		"profile_snapshot":
			return await _snapshot(args, ctx)
	return ctx.err("UNKNOWN_OP", "profiling does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


const _MONITORS := {
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


static func _selected(args: Dictionary, ctx: MercuryVulcanContext):
	var wanted = args.get("monitors")
	if wanted == null:
		return _MONITORS.keys()
	if not (wanted is Array):
		return ctx.err("BAD_ARGS", "monitors must be an array of names", "known: %s" % ", ".join(_MONITORS.keys()))
	var out: Array = []
	for w in wanted:
		var name := String(w)
		if not _MONITORS.has(name):
			return ctx.err("BAD_ARGS", "unknown monitor '%s'" % name, "known: %s" % ", ".join(_MONITORS.keys()))
		out.append(name)
	return out


static func _monitors(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if ctx.runtime != null:
		return await ctx.runtime.request("profile_monitors", args)
	var names = _selected(args, ctx)
	if names is Dictionary:
		return names
	var values := {}
	for name in names:
		values[name] = Performance.get_monitor(_MONITORS[name])
	return { "ok": true, "result": {
		"source": "editor process (no play session — these are the EDITOR's numbers)",
		"values": values,
		"hint": "scene_play first for game-side numbers",
	} }


static func _snapshot(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	if ctx.runtime != null:
		return await ctx.runtime.request("profile_snapshot", args)
	var names = _selected(args, ctx)
	if names is Dictionary:
		return names
	var series := {}
	for name in names:
		var v: float = Performance.get_monitor(_MONITORS[name])
		series[name] = { "min": v, "avg": v, "max": v, "samples": 1 }
	return { "ok": true, "result": {
		"source": "editor process, SINGLE-FRAME snapshot (min=avg=max)",
		"duration_ms": 0,
		"series": series,
		"hint": "a real sampled window needs a play session: scene_play, then profile_snapshot forwards to the game",
	} }
