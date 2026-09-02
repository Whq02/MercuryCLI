@tool
class_name MercuryVulcanRegistry
extends RefCounted
# Maps op name -> category handler script. Categories self-describe via their
# static ops(); the registry loads every categories/<key>.gd it finds and
# tolerates missing files (partial installs warn instead of crashing).
# vulcan_install / vulcan_uninstall / vulcan_status are Mercury-side and are
# answered by the server before routing (never in this table).

const CATEGORY_KEYS := [
	"project", "scene", "node", "script", "editor", "input", "runtime",
	"animation", "animtree", "three_d", "physics", "particles", "navigation",
	"audio", "tilemap", "theme", "shader", "resource", "batch", "analysis",
	"testing", "profiling", "export", "frontier",
]

var _handlers := {}
var _op_category := {}

func _init() -> void:
	var base := (get_script() as Script).resource_path.get_base_dir().get_base_dir()
	for key in CATEGORY_KEYS:
		# "export" is a GDScript keyword — its handler file is export_cat.gd.
		var fname := "export_cat" if key == "export" else String(key)
		var path := "%s/categories/%s.gd" % [base, fname]
		if not ResourceLoader.exists(path):
			push_warning("mercury_vulcan: category file missing: %s" % path)
			continue
		var script = load(path)
		if script == null:
			push_warning("mercury_vulcan: category failed to load: %s" % path)
			continue
		for op in script.ops():
			if _handlers.has(op):
				push_warning("mercury_vulcan: op \"%s\" claimed twice (second: %s)" % [op, key])
				continue
			_handlers[op] = script
			_op_category[op] = key

func handler_for(op: String):
	return _handlers.get(op)

func known_ops() -> Array:
	return _handlers.keys()

func closest_category(op: String) -> String:
	var best := ""
	var best_score := -1.0
	for known in _handlers.keys():
		var score: float = op.similarity(known)
		if score > best_score:
			best_score = score
			best = known
	if best.is_empty():
		return "project"
	return String(_op_category.get(best, "project"))
