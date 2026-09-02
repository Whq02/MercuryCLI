@tool
class_name MercuryVulcanTilemap
# mercury_vulcan — TileMap category handlers (static module, no instances).
# Godot 4 caveat (documented per the writer contract): ops target the 4.3+
# TileMapLayer node first; a legacy TileMap node is ALSO accepted and driven through
# its layer-indexed API ('layer' arg, default 0). All TileMapLayer access is via
# is_class("TileMapLayer") + dynamic call() so this file still parses on editors
# older than 4.3 (where the class does not exist). tilemap_clear's undo snapshots
# every used cell — very large maps are capped (TOO_LARGE) rather than half-undone.


const _MAX_UNDO_CELLS := 65536


static func ops() -> Array:
	return [
		"tilemap_used_cells", "tilemap_query_cell", "tilemap_tileset_info",
		"tilemap_set_cell", "tilemap_fill", "tilemap_clear",
	]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"tilemap_used_cells":
			return _used_cells(args, ctx)
		"tilemap_query_cell":
			return _query_cell(args, ctx)
		"tilemap_tileset_info":
			return _tileset_info(args, ctx)
		"tilemap_set_cell":
			return _set_cell(args, ctx)
		"tilemap_fill":
			return _fill(args, ctx)
		"tilemap_clear":
			return _clear(args, ctx)
	return ctx.err("UNKNOWN_OP", "tilemap does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


# _tm resolves the node and classifies it: {node, layered:bool, layer:int} or {err}.
static func _tm(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var r := _resolve(String(args.get("tilemap", "")), ctx)
	if r.has("err"):
		return r
	var node: Node = r.node
	if node.is_class("TileMapLayer"):
		return { "node": node, "layered": false }
	if node.is_class("TileMap"):
		return { "node": node, "layered": true, "layer": int(args.get("layer", 0)) }
	return { "err": ctx.err("BAD_TYPE", "%s is a %s, not a TileMapLayer/TileMap" % [args.get("tilemap"), node.get_class()], "point 'tilemap' at a TileMapLayer (Godot 4.3+) or legacy TileMap node — see scene_tree") }


static func _used_cells(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var t := _tm(args, ctx)
	if t.has("err"):
		return t.err
	var used: Array = t.node.call("get_used_cells", t.layer) if t.layered else t.node.call("get_used_cells")
	var rect = t.node.call("get_used_rect")  # no layer arg on either class (TileMap's spans all layers)
	var sample: Array = []
	for c in used:
		sample.append([c.x, c.y])
		if sample.size() >= 200:
			break
	return { "ok": true, "result": {
		"count": used.size(),
		"bounds": { "position": [rect.position.x, rect.position.y], "size": [rect.size.x, rect.size.y] },
		"cells_sample": sample,
		"truncated": used.size() > sample.size(),
	} }


static func _query_cell(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var t := _tm(args, ctx)
	if t.has("err"):
		return t.err
	var cell = _v2i(ctx.types.parse(args.get("cell")))
	if cell == null:
		return ctx.err("BAD_ARGS", "cell must be a Vector2i", "e.g. \"Vector2i(3, -1)\" or [3, -1]")
	var src: int
	var atlas
	var alt: int
	if t.layered:
		src = t.node.call("get_cell_source_id", t.layer, cell)
		atlas = t.node.call("get_cell_atlas_coords", t.layer, cell)
		alt = t.node.call("get_cell_alternative_tile", t.layer, cell)
	else:
		src = t.node.call("get_cell_source_id", cell)
		atlas = t.node.call("get_cell_atlas_coords", cell)
		alt = t.node.call("get_cell_alternative_tile", cell)
	return { "ok": true, "result": {
		"cell": [cell.x, cell.y],
		"empty": src == -1,
		"source": src,
		"atlas": [atlas.x, atlas.y],
		"alternative": alt,
	} }


static func _tileset_info(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var t := _tm(args, ctx)
	if t.has("err"):
		return t.err
	var ts = t.node.get("tile_set")
	if ts == null:
		return ctx.err("NOT_FOUND", "%s has no TileSet assigned" % t.node.name, "assign one in the editor or via node_set_property tile_set")
	var sources: Array = []
	for i in ts.get_source_count():
		var sid: int = ts.get_source_id(i)
		var src = ts.get_source(sid)
		var entry := { "id": sid, "class": src.get_class() }
		if src.is_class("TileSetAtlasSource"):
			var tex = src.get("texture")
			entry["texture"] = tex.resource_path if tex != null else ""
			var grid = src.call("get_atlas_grid_size")
			entry["atlas_grid"] = [grid.x, grid.y]
			entry["tile_count"] = src.call("get_tiles_count")
			var ids: Array = []
			for j in mini(int(entry["tile_count"]), 50):
				var tc = src.call("get_tile_id", j)
				ids.append([tc.x, tc.y])
			entry["tile_ids_sample"] = ids
		sources.append(entry)
	var shape: int = ts.tile_shape
	return { "ok": true, "result": {
		"tile_size": [ts.tile_size.x, ts.tile_size.y],
		"tile_shape": shape,
		"source_count": ts.get_source_count(),
		"sources": sources,
	} }


static func _set_cell(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var t := _tm(args, ctx)
	if t.has("err"):
		return t.err
	var cell = _v2i(ctx.types.parse(args.get("cell")))
	if cell == null:
		return ctx.err("BAD_ARGS", "cell must be a Vector2i", "e.g. \"Vector2i(3, -1)\" or [3, -1]")
	if not args.has("source") or not args.has("atlas"):
		return ctx.err("BAD_ARGS", "source and atlas are required", "e.g. {\"source\": 0, \"atlas\": \"Vector2i(1, 0)\"} — see tilemap_tileset_info for valid ids")
	var atlas = _v2i(ctx.types.parse(args.get("atlas")))
	if atlas == null:
		return ctx.err("BAD_ARGS", "atlas must be a Vector2i", "e.g. \"Vector2i(1, 0)\" or [1, 0]")
	var source := int(args.get("source"))
	var alt := int(args.get("alternative", 0))
	var prior := _snapshot_cells(t, [cell])
	var do := func():
		_apply_cell(t, cell, source, atlas, alt)
	var undo := func():
		_restore_cells(t, prior)
	ctx.undo.action("vulcan: tilemap_set_cell", do, undo)
	return { "ok": true, "result": { "cell": [cell.x, cell.y], "source": source, "atlas": [atlas.x, atlas.y], "alternative": alt, "undoable": true } }


static func _fill(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var t := _tm(args, ctx)
	if t.has("err"):
		return t.err
	var from_c = _v2i(ctx.types.parse(args.get("from")))
	var to_c = _v2i(ctx.types.parse(args.get("to")))
	if from_c == null or to_c == null:
		return ctx.err("BAD_ARGS", "from and to must be Vector2i", "e.g. {\"from\": [0, 0], \"to\": [9, 4]}")
	if not args.has("source") or not args.has("atlas"):
		return ctx.err("BAD_ARGS", "source and atlas are required", "see tilemap_tileset_info for valid ids")
	var atlas = _v2i(ctx.types.parse(args.get("atlas")))
	if atlas == null:
		return ctx.err("BAD_ARGS", "atlas must be a Vector2i", "e.g. \"Vector2i(1, 0)\" or [1, 0]")
	var source := int(args.get("source"))
	var alt := int(args.get("alternative", 0))
	var lo := Vector2i(mini(from_c.x, to_c.x), mini(from_c.y, to_c.y))
	var hi := Vector2i(maxi(from_c.x, to_c.x), maxi(from_c.y, to_c.y))
	var count := (hi.x - lo.x + 1) * (hi.y - lo.y + 1)
	if count > _MAX_UNDO_CELLS:
		return ctx.err("TOO_LARGE", "fill rect covers %d cells (cap %d)" % [count, _MAX_UNDO_CELLS], "fill in smaller rects")
	var cells: Array = []
	for y in range(lo.y, hi.y + 1):
		for x in range(lo.x, hi.x + 1):
			cells.append(Vector2i(x, y))
	var prior := _snapshot_cells(t, cells)
	var do := func():
		for c in cells:
			_apply_cell(t, c, source, atlas, alt)
	var undo := func():
		_restore_cells(t, prior)
	ctx.undo.action("vulcan: tilemap_fill", do, undo)
	return { "ok": true, "result": { "filled": count, "from": [lo.x, lo.y], "to": [hi.x, hi.y], "undoable": true } }


static func _clear(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var t := _tm(args, ctx)
	if t.has("err"):
		return t.err
	# Legacy TileMap with no layer arg = clear ALL layers; TileMapLayer = its cells.
	var clear_all_layers: bool = t.layered and not args.has("layer")
	var layers: Array = []
	if t.layered:
		if clear_all_layers:
			for i in int(t.node.call("get_layers_count")):
				layers.append(i)
		else:
			layers.append(t.layer)
	else:
		layers.append(-1)
	var prior: Array = []
	var total := 0
	for layer in layers:
		var scoped := { "node": t.node, "layered": t.layered, "layer": layer }
		var used: Array = t.node.call("get_used_cells", layer) if t.layered else t.node.call("get_used_cells")
		total += used.size()
		if total > _MAX_UNDO_CELLS:
			return ctx.err("TOO_LARGE", "clear would snapshot %d+ cells for undo (cap %d)" % [total, _MAX_UNDO_CELLS], "clear one layer at a time, or clear rects with tilemap_fill using source -1")
		prior.append({ "layer": layer, "cells": _snapshot_cells(scoped, used) })
	var node: Node = t.node
	var layered: bool = t.layered
	var do := func():
		if layered:
			for entry in prior:
				node.call("clear_layer", entry.layer)
		else:
			node.call("clear")
	var undo := func():
		for entry in prior:
			var scoped := { "node": node, "layered": layered, "layer": entry.layer }
			_restore_cells(scoped, entry.cells)
	ctx.undo.action("vulcan: tilemap_clear", do, undo)
	return { "ok": true, "result": { "cleared_cells": total, "layers": layers if layered else "n/a (TileMapLayer)", "undoable": true } }


# --- cell snapshot/apply helpers (uniform over TileMapLayer + legacy TileMap) ---

static func _snapshot_cells(t: Dictionary, cells: Array) -> Array:
	var out: Array = []
	for c in cells:
		var src: int
		var atlas
		var alt: int
		if t.layered:
			src = t.node.call("get_cell_source_id", t.layer, c)
			atlas = t.node.call("get_cell_atlas_coords", t.layer, c)
			alt = t.node.call("get_cell_alternative_tile", t.layer, c)
		else:
			src = t.node.call("get_cell_source_id", c)
			atlas = t.node.call("get_cell_atlas_coords", c)
			alt = t.node.call("get_cell_alternative_tile", c)
		out.append([c, src, atlas, alt])
	return out


static func _apply_cell(t: Dictionary, cell, source: int, atlas, alt: int) -> void:
	if t.layered:
		t.node.call("set_cell", t.layer, cell, source, atlas, alt)
	else:
		t.node.call("set_cell", cell, source, atlas, alt)


static func _restore_cells(t: Dictionary, prior: Array) -> void:
	for entry in prior:
		_apply_cell(t, entry[0], entry[1], entry[2], entry[3])


static func _v2i(v):
	match typeof(v):
		TYPE_VECTOR2I:
			return v
		TYPE_VECTOR2:
			return Vector2i(v)
		TYPE_ARRAY:
			if v.size() == 2:
				return Vector2i(int(v[0]), int(v[1]))
	return null


static func _resolve(raw: String, ctx: MercuryVulcanContext) -> Dictionary:
	var root: Node = ctx.editor.get_edited_scene_root()
	if root == null:
		return { "err": ctx.err("NO_SCENE", "no scene is being edited", "open or create a scene first (scene_open / scene_create)") }
	var rel := raw.strip_edges().trim_prefix("/root/").trim_prefix("/").trim_prefix("./")
	if rel == "" or rel == "." or rel == root.name:
		return { "node": root }
	var cur: Node = root
	for part in rel.split("/"):
		var nxt: Node = cur.get_node_or_null(NodePath(String(part)))
		if nxt == null:
			var names: Array = []
			for c in cur.get_children():
				names.append(String(c.name))
			var where := "the scene root '%s'" % root.name if cur == root else "'%s'" % String(root.get_path_to(cur))
			var near := ", ".join(names) if names.size() > 0 else "(no children)"
			return { "err": ctx.err("NODE_NOT_FOUND", "no node '%s' under %s" % [part, where], "children there: %s" % near) }
		cur = nxt
	return { "node": cur }
