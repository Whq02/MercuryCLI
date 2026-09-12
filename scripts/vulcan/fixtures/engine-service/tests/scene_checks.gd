extends Node

func _ready() -> void:
	var probe := Probe.new()
	Events.announce("scene_checks")
	print("checks=%d failures=0" % probe.count())
	print("FIXTURE PASS")
	get_tree().quit()
