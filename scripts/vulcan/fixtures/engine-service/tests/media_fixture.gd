extends Node3D

var frozen_clock: Dictionary = {}
var feature: bool = false
var random_colour: float = 0.0
var time_of_day: float = 12.0
var process_ms: float = 0.0
var physics_ms: float = 0.0
var accumulator: float = 0.0
var toggles: Array = []

func _ready() -> void:
	var camera: Camera3D = Camera3D.new()
	camera.name = "Camera"
	add_child(camera)
	camera.position = Vector3(0.0, 2.0, 4.0)

func mercury_media_configure(context: Dictionary) -> Dictionary:
	frozen_clock = context.clock.duplicate(true)
	seed(int(frozen_clock.seed))
	random_colour = randf()
	return {"simulationClock": true, "shaderClock": true, "seeded": true, "notes": "CPU Image fixture evaluates its colours from the requested simulation and shader clocks and the seeded Godot RNG; no GPU shader or wall clock supplies image pixels."}

func mercury_media_step(step: Dictionary, _context: Dictionary) -> void:
	time_of_day = float(step.get("timeOfDay", 12.0))

func mercury_media_toggle(switch_name: String, value: Variant) -> void:
	assert(switch_name == "feature")
	feature = bool(value)
	toggles.append(feature)
	print("FIXTURE TOGGLE " + JSON.stringify({"pid": OS.get_process_id(), "values": toggles}))

func mercury_media_capture(_context: Dictionary) -> Image:
	var image: Image = Image.create(64, 48, false, Image.FORMAT_RGBA8)
	var camera: Camera3D = get_node("Camera") as Camera3D
	image.fill(Color(random_colour, fmod(float(frozen_clock.shaderTime) + time_of_day, 24.0) / 24.0, fmod(float(frozen_clock.simulationTime) + camera.fov, 100.0) / 100.0, 1.0))
	if feature:
		image.fill_rect(Rect2i(8, 10, 16, 12), Color(1.0, 0.0, 0.0, 1.0))
	return image

func _process(_delta: float) -> void:
	var start: int = Time.get_ticks_usec()
	var iterations: int = 2000 if feature else 1000
	for i in range(iterations):
		accumulator = fmod(accumulator + sqrt(float(i + 1)), 10000.0)
	process_ms = float(Time.get_ticks_usec() - start) / 1000.0

func _physics_process(_delta: float) -> void:
	var start: int = Time.get_ticks_usec()
	for i in range(500):
		accumulator = fmod(accumulator + sin(float(i)), 10000.0)
	physics_ms = float(Time.get_ticks_usec() - start) / 1000.0

func mercury_media_sample() -> Dictionary:
	return {"scripts": [{"script": "res://tests/media_fixture.gd", "selfMs": process_ms + physics_ms, "totalMs": process_ms + physics_ms, "calls": 2}], "physics": {"fixtureTick": physics_ms}}
