extends Node

signal answered(value)
signal never

@export var score: int = 42

func describe(value: int) -> Dictionary:
	return {"score": score, "argument": value, "label": "fixture"}

func answer(value: int) -> void:
	answered.emit(value)

func finish() -> void:
	print("RUNTIME PASS")
	get_tree().quit()
