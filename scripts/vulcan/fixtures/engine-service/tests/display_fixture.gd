extends Control

var surface: ColorRect
var paint: ShaderMaterial
var feature: bool = false
var frozen_clock: Dictionary = {}
var process_ms: float = 0.0
var physics_ms: float = 0.0
var accumulator: float = 0.0
var toggles: Array = []

func _ready() -> void:
	get_window().title = "Mercury native viewport fixture"
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	surface = ColorRect.new()
	surface.name = "RenderedSurface"
	surface.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(surface)
	surface.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var shader: Shader = Shader.new()
	shader.code = """shader_type canvas_item;
render_mode unshaded;
uniform float frozen_simulation = 0.0;
uniform float frozen_shader = 0.0;
uniform float seeded_tint = 0.0;
uniform bool feature = false;
void fragment() {
	vec3 colour = vec3(0.08 + seeded_tint * 0.08, 0.18 + mod(frozen_simulation, 4.0) * 0.02, 0.36 + mod(frozen_shader, 4.0) * 0.02);
	if (UV.x < 0.125) {
		colour = vec3(0.05, 0.72, 0.63);
	}
	if (UV.y >= 0.875) {
		colour = vec3(0.86, 0.58, 0.08);
	}
	if (feature && UV.x >= 0.25 && UV.x < 0.5 && UV.y >= 0.25 && UV.y < 0.5) {
		colour = vec3(0.96, 0.08, 0.22);
	}
	COLOR = vec4(colour, 1.0);
}
"""
	paint = ShaderMaterial.new()
	paint.shader = shader
	surface.material = paint

func mercury_media_configure(context: Dictionary) -> Dictionary:
	frozen_clock = context.clock.duplicate(true)
	seed(int(frozen_clock.seed))
	paint.set_shader_parameter("seeded_tint", randf())
	paint.set_shader_parameter("frozen_simulation", float(frozen_clock.simulationTime))
	paint.set_shader_parameter("frozen_shader", float(frozen_clock.shaderTime))
	return {"simulationClock": true, "shaderClock": true, "seeded": true, "notes": "A real canvas shader paints the viewport from explicit frozen_simulation, frozen_shader and seeded_tint uniforms. The fixture never reads a running shader clock or simulation delta for pixels. CPU workload timings do not alter the rendered state.", "switchRegionUv": [0.25, 0.25, 0.5, 0.5]}

func mercury_media_step(_step: Dictionary, _context: Dictionary) -> void:
	surface.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

func mercury_media_toggle(switch_name: String, value: Variant) -> void:
	assert(switch_name == "feature")
	feature = bool(value)
	paint.set_shader_parameter("feature", feature)
	toggles.append(feature)
	print("DISPLAY FIXTURE TOGGLE " + JSON.stringify({"pid": OS.get_process_id(), "values": toggles}))

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
	return {"scripts": [{"script": "res://tests/display_fixture.gd", "selfMs": process_ms + physics_ms, "totalMs": process_ms + physics_ms, "calls": 2}], "physics": {"fixtureTick": physics_ms}}
