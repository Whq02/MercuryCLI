extends Node

func _ready() -> void:
	print("FAIL: expected 3 got 4")
	print("checks=2 failures=1")
	get_tree().quit(1)
