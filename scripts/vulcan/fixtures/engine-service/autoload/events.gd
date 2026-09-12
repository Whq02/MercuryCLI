extends Node

signal fixture_signal(name: String)

func announce(name: String) -> void:
	fixture_signal.emit(name)
