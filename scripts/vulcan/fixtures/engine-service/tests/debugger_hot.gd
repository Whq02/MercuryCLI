extends Node

var accumulator: float = 0.0
var feature: bool = false

func _ready() -> void:
	for i in range(24):
		var body: RigidBody2D = RigidBody2D.new()
		var collision: CollisionShape2D = CollisionShape2D.new()
		var shape: CircleShape2D = CircleShape2D.new()
		shape.radius = 8.0
		collision.shape = shape
		body.add_child(collision)
		body.position = Vector2(float(i % 6) * 14.0, float(i / 6) * 14.0)
		add_child(body)

func _process(_delta: float) -> void:
	for _i in range(11 if feature else 7):
		hot_function()

func hot_function() -> void:
	for i in range(2000):
		accumulator = fmod(accumulator + sqrt(float(i + 1)), 10000.0)

func mercury_media_toggle(switch_name: String, value: Variant) -> void:
	assert(switch_name == "feature")
	feature = bool(value)
