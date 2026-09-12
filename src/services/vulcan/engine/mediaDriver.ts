import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { engineMediaArgv } from './argv.js'
import type { EngineMediaRequest } from './media.js'
import { engineMediaBootFile, engineMediaConfigFile, engineMediaDir, engineMediaDriverFile } from './paths.js'

export const ENGINE_MEDIA_MARKER = 'MERCURY MEDIA PASS'

export function writeEngineMediaDriver(runDir: string, treePath: string, request: EngineMediaRequest, variant: string, debuggerConnection?: { port: number; token: string }): { argv: string[]; outputDir: string; resultFile: string } {
  const outputDir = engineMediaDir(runDir, variant)
  mkdirSync(outputDir, { recursive: true })
  const resultFile = engineMediaBootFile(runDir, variant)
  const configFile = engineMediaConfigFile(runDir, variant)
  const scriptFile = engineMediaDriverFile(runDir, variant)
  writeFileSync(configFile, JSON.stringify({ ...request, variant, outputDir, resultFile, debuggerConnection }))
  writeFileSync(scriptFile, ENGINE_MEDIA_DRIVER)
  const argv = engineMediaArgv(treePath, { headless: request.route === 'headless', fixedFps: request.kind === 'capture' ? request.clock.fps : null, debuggerPort: debuggerConnection?.port ?? null, script: scriptFile, config: configFile })
  return { argv, outputDir, resultFile }
}

const ENGINE_MEDIA_DRIVER = `extends SceneTree

var config: Dictionary = {}
var subject: Node
var viewport: Viewport
var failed: bool = false
var debugger_ready: bool = false
var debugger_stopped: bool = false

func _debugger_message(message: String, _data: Array) -> bool:
	if message == "ready":
		debugger_ready = true
		return true
	if message == "stopped":
		debugger_stopped = true
		return true
	return false

func _debugger_wait(stopping: bool) -> void:
	var deadline: int = Time.get_ticks_msec() + 5000
	while not (debugger_stopped if stopping else debugger_ready):
		if Time.get_ticks_msec() >= deadline:
			_fail("engine debugger handshake or profiler drain did not finish within five seconds")
			return
		await process_frame

func _initialize() -> void:
	call_deferred("_run")

func _fail(message: String) -> void:
	failed = true
	printerr("FAIL: " + message)
	quit(1)

func _context(variant: String, step_index: int = -1) -> Dictionary:
	return {"kind": config.kind, "clock": config.clock.duplicate(true), "variant": variant, "stepIndex": step_index}

func _vec(values: Array) -> Vector3:
	return Vector3(float(values[0]), float(values[1]), float(values[2]))

func _apply_step(step: Dictionary, context: Dictionary) -> void:
	if step.has("camera"):
		var pose: Dictionary = step.camera
		var camera: Camera3D = subject.get_node_or_null(NodePath(pose.node)) as Camera3D
		if camera == null:
			_fail("camera.node must name a Camera3D beneath the tour root")
			return
		if pose.has("position"):
			camera.global_position = _vec(pose.position)
		if pose.has("rotation"):
			camera.rotation_degrees = _vec(pose.rotation)
		if pose.has("target"):
			camera.look_at(_vec(pose.target))
		if pose.has("fov"):
			camera.fov = float(pose.fov)
		camera.make_current()
	if subject.has_method("mercury_media_step"):
		await subject.call("mercury_media_step", step.duplicate(true), context)
	elif step.has("timeOfDay"):
		_fail("timeOfDay requires mercury_media_step(step, context) project cooperation")

func _wait_frames(count: int) -> void:
	for _i in range(count):
		await process_frame

func _toggle(variant: String) -> void:
	if config.pair == null:
		return
	if not subject.has_method("mercury_media_toggle"):
		_fail("pair requires mercury_media_toggle(switch_name, value)")
		return
	await subject.call("mercury_media_toggle", config.pair.switch, config.pair[variant])

func _capture(variant: String) -> Array:
	var frames: Array = []
	await _toggle(variant)
	if failed:
		return frames
	for step_index in range(config.tour.steps.size()):
		var step: Dictionary = config.tour.steps[step_index]
		var context: Dictionary = _context(variant, step_index)
		await _apply_step(step, context)
		if failed:
			return frames
		await _wait_frames(int(config.settleFrames))
		for frame_index in range(int(step.frames)):
			context["frameIndex"] = frame_index
			var image: Image
			if subject.has_method("mercury_media_capture"):
				var supplied: Variant = await subject.call("mercury_media_capture", context)
				if not supplied is Image:
					_fail("mercury_media_capture must return an Image")
					return frames
				image = supplied
			else:
				if config.route == "headless":
					_fail("headless uses dummy rendering; provide mercury_media_capture(context) returning project Image pixels, or explicitly request route display")
					return frames
				await RenderingServer.frame_post_draw
				image = viewport.get_texture().get_image()
			if image == null or image.is_empty():
				_fail("capture produced no image pixels")
				return frames
			var output: String = config.outputDir.path_join(str(step_index) + "-" + str(frame_index) + ".png")
			if image.save_png(output) != OK:
				_fail("cannot write run-scoped capture frame")
				return frames
			frames.append({"path": output, "variant": variant, "stepIndex": step_index, "frameIndex": frame_index})
	return frames

func _sample(variant: String, step_index: int) -> Dictionary:
	var phase: Dictionary = {"variant": variant, "stepIndex": step_index, "frameMs": [], "processMs": [], "physicsMs": [], "navigationMs": [], "gpuMs": [], "renderCpuMs": [], "scripts": [], "physics": {}}
	var scripts: Dictionary = {}
	await _wait_frames(int(config.settleFrames))
	var first_frame: int = Engine.get_process_frames()
	var before: int = Time.get_ticks_usec()
	for _sample_index in range(int(config.sampleFrames)):
		await process_frame
		var now: int = Time.get_ticks_usec()
		phase.frameMs.append(float(now - before) / 1000.0)
		before = now
		phase.processMs.append(Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0)
		phase.physicsMs.append(Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0)
		phase.navigationMs.append(Performance.get_monitor(Performance.TIME_NAVIGATION_PROCESS) * 1000.0)
		if config.route != "headless":
			var gpu: float = RenderingServer.viewport_get_measured_render_time_gpu(viewport.get_viewport_rid())
			var cpu: float = RenderingServer.viewport_get_measured_render_time_cpu(viewport.get_viewport_rid())
			if gpu > 0.0:
				phase.gpuMs.append(gpu)
			if cpu > 0.0:
				phase.renderCpuMs.append(cpu)
		if not subject.has_method("mercury_media_sample"):
			continue
		var measured: Variant = subject.call("mercury_media_sample")
		if not measured is Dictionary or not measured.get("scripts") is Array or not measured.get("physics") is Dictionary:
			_fail("mercury_media_sample must return {scripts:[{script,selfMs,totalMs,calls}],physics:{component:ms}}")
			return phase
		for row in measured.scripts:
			if not row is Dictionary or not row.get("script") is String or not row.has("selfMs") or not row.has("totalMs") or not row.has("calls"):
				_fail("each instrumented script needs script, selfMs, totalMs, calls")
				return phase
			var key: String = row.script
			if not scripts.has(key):
				scripts[key] = {"script": key, "selfMs": [], "totalMs": [], "calls": []}
			scripts[key].selfMs.append(row.selfMs)
			scripts[key].totalMs.append(row.totalMs)
			scripts[key].calls.append(row.calls)
		for key in measured.physics:
			if not phase.physics.has(key):
				phase.physics[key] = []
			phase.physics[key].append(measured.physics[key])
	if debugger_ready:
		EngineDebugger.send_message("mercury_profile:window", [variant, step_index, first_frame, Engine.get_process_frames()])
	for key in scripts:
		phase.scripts.append(scripts[key])
	return phase

func _profile() -> Array:
	var phases: Array = []
	if not debugger_ready and not subject.has_method("mercury_media_sample"):
		_fail("project profile requires mercury_media_sample() for script and physics tables; the engine debugger did not connect or source project was selected")
		return phases
	var variants: Array = ["single"] if config.pair == null else ["a", "b"]
	for variant in variants:
		await _toggle(variant)
		if failed:
			return phases
		for step_index in range(config.tour.steps.size()):
			await _apply_step(config.tour.steps[step_index], _context(variant, step_index))
			if failed:
				return phases
			phases.append(await _sample(variant, step_index))
			if failed:
				return phases
	return phases

func _run() -> void:
	var args: PackedStringArray = OS.get_cmdline_user_args()
	if args.size() != 1:
		_fail("media driver needs its frozen request file")
		return
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(args[0]))
	if not parsed is Dictionary:
		_fail("media request is not a JSON object")
		return
	config = parsed
	if config.kind == "profile" and config.has("debuggerConnection") and EngineDebugger.is_active():
		EngineDebugger.register_message_capture("mercury_profile", _debugger_message)
		EngineDebugger.send_message("mercury_profile:hello", [config.debuggerConnection.token, Engine.get_version_info()])
		await _debugger_wait(false)
		if failed:
			return
	seed(int(config.clock.seed))
	Engine.physics_ticks_per_second = int(config.clock.fps)
	Engine.max_fps = 0
	if config.kind == "capture":
		Engine.time_scale = 0.0
	viewport = root
	if config.route == "headless" and DisplayServer.get_name() != "headless":
		_fail("headless route did not select the headless display driver")
		return
	if config.route != "headless":
		RenderingServer.viewport_set_measure_render_time(viewport.get_viewport_rid(), true)
	var loaded: Variant = load(config.tour.get("scene", config.tour.get("script", "")))
	if loaded is PackedScene:
		subject = loaded.instantiate()
	elif loaded is Script:
		var created: Variant = loaded.new()
		if not created is Node:
			if created is Object and not created is RefCounted:
				created.free()
			_fail("tour script must extend Node, not SceneTree")
			return
		subject = created
	else:
		_fail("tour resource did not load as a scene or Node script")
		return
	root.add_child(subject)
	var evidence: Dictionary = {}
	if subject.has_method("mercury_media_configure"):
		var supplied: Variant = await subject.call("mercury_media_configure", _context(config.variant))
		if not supplied is Dictionary:
			_fail("mercury_media_configure must return a cooperation evidence dictionary")
			return
		evidence = supplied
	if config.kind == "capture":
		if evidence.get("simulationClock") != true or evidence.get("shaderClock") != true or evidence.get("seeded") != true or not evidence.get("notes") is String or evidence.get("notes", "").strip_edges().is_empty():
			_fail("capture needs mercury_media_configure evidence {simulationClock:true,shaderClock:true,seeded:true,notes:how project clocks and RNGs cooperate}; built-in shader TIME and wall clocks are not frozen by this driver")
			return
	evidence["engine"] = Engine.get_version_info()
	evidence["projectTables"] = subject.has_method("mercury_media_sample")
	evidence["debuggerConnected"] = debugger_ready
	evidence["displayDriver"] = DisplayServer.get_name()
	evidence["renderer"] = {"driver": RenderingServer.get_current_rendering_driver_name(), "method": RenderingServer.get_current_rendering_method()}
	if config.route != "headless":
		evidence["renderer"]["adapter"] = RenderingServer.get_video_adapter_name()
		evidence["renderer"]["vendor"] = RenderingServer.get_video_adapter_vendor()
		evidence["renderer"]["api"] = RenderingServer.get_video_adapter_api_version()
	evidence["pixelSource"] = "project-provided Image pixels, not GPU viewport rendering" if subject.has_method("mercury_media_capture") else "Godot viewport"
	evidence["clockScope"] = "Godot global RNG seeded before scene load; capture Engine.time_scale=0; requested simulation and shader time applied by acknowledged project hook, not universal wall-clock or shader TIME interception"
	evidence["timingSource"] = "Time.get_ticks_usec frame intervals; Performance process, physics, navigation monitors in milliseconds; positive RenderingServer viewport GPU/CPU reports only; script and physics components from project instrumentation"
	var output: Dictionary = {"kind": config.kind, "evidence": evidence, "frames": [], "phases": []}
	if config.kind == "capture":
		output.frames = await _capture(config.variant)
	else:
		output.phases = await _profile()
		if debugger_ready and not failed:
			EngineDebugger.send_message("mercury_profile:stop", [])
			await _debugger_wait(true)
	if failed:
		return
	var file: FileAccess = FileAccess.open(config.resultFile, FileAccess.WRITE)
	if file == null:
		_fail("cannot write media driver result")
		return
	file.store_string(JSON.stringify(output))
	file.close()
	if debugger_ready:
		EngineDebugger.unregister_message_capture("mercury_profile")
	subject.queue_free()
	await process_frame
	print("MERCURY MEDIA PASS")
	quit(0)
`
