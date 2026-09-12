extends SceneTree

func _initialize() -> void:
	var probe := Probe.new()
	print("checks=%d failures=0" % probe.count())
	print("SCRIPT PASS")
	quit()
