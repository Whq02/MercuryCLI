@tool
class_name MercuryVulcanUndo
extends RefCounted
# EditorUndoRedoManager wrapper. ONE instance lives for the addon's lifetime
# (it is the trampoline object the undo history calls back into — do not
# recreate it per request or committed history breaks).
#
#   action(name, do_callable, undo_callable [, do_ref, undo_ref])
#     one editor undo step; committing executes do_callable. Ctrl+Z runs
#     undo_callable. Callables must fully perform / fully revert the change.
#   begin(name) / commit()
#     group several action() calls into ONE undo step (batch_transaction).
#     Grouped mode executes each do_callable IMMEDIATELY at action() time —
#     later sub-ops in the transaction must see the live tree/file state, not
#     the pre-batch snapshot — and commit() therefore commits with
#     execute=false so the queued do methods don't run a second time.
#   do_ref / undo_ref (optional): the Node(s) the do side CREATES
#     (add_do_reference) or the undo side RESTORES after do deleted them
#     (add_undo_reference), so purged history frees them instead of leaking.
#     Each accepts a single Object or an Array of them (batch_replace_type
#     swaps many nodes in one step).

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
	# The grouped do callables already ran inline (see action()); executing
	# here would apply every sub-op twice.
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
