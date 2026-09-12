extends RefCounted

func ping() -> void:
	Events.announce("ping")
