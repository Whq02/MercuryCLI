extends SceneTree

const Helper := preload("res://src/autoload_user.gd")

func _initialize() -> void:
	print("PRELOAD PASS")
	quit()
