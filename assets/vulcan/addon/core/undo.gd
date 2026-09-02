@tool
class_name MercuryVulcanUndo
extends RefCounted

var _mgr: Object = null
var _grouped := false

func setup(mgr: Object) -> void:
	_mgr = mgr

func manager() -> Object:
	return _mgr

func begin(action_name: String) -> void:
	if _grouped:
		push_warning("mercury_vulcan: nested undo.begin(\"%s\") ignored" % action_name)
		return
	_mgr.create_action(action_name, UndoRedo.MERGE_DISABLE, _context())
	_grouped = true

func commit() -> void:
	if not _grouped:
		push_warning("mercury_vulcan: undo.commit() without begin() ignored")
		return
	_mgr.commit_action(false)
	_grouped = false

func action(action_name: String, do_callable: Callable, undo_callable: Callable, do_ref = null, undo_ref = null) -> void:
	var solo := not _grouped
	if solo:
		_mgr.create_action(action_name, UndoRedo.MERGE_DISABLE, _context())
	_mgr.add_do_method(self, &"_invoke", do_callable)
	_mgr.add_undo_method(self, &"_invoke", undo_callable)
	for r in _refs(do_ref):
		_mgr.add_do_reference(r)
	for r in _refs(undo_ref):
		_mgr.add_undo_reference(r)
	if solo:
		_mgr.commit_action()
	else:
		_invoke(do_callable)

func _refs(v) -> Array:
	if v == null:
		return []
	if v is Array:
		return v
	return [v]

func _invoke(c: Callable) -> void:
	c.call()

func _context() -> Object:
	return EditorInterface.get_edited_scene_root()
