@tool
class_name MercuryVulcanTypes
extends RefCounted
# Smart type parsing for VULCAN args + jsonable conversion for results.
# parse() turns strings like "Vector2(100, 200)", "#ff0000", "Color(1,0,0)",
# "Vector3(1,2,3)", "Rect2(0,0,64,64)", "Vector2i(3,4)", "Vector3i(0,1,0)"
# and "NodePath(\"A/B\")" into real Variants; numbers/bools/arrays/dicts pass
# through JSON natively (arrays and dict values are parsed recursively).
# to_jsonable() is the inverse for results: Godot Variants become JSON-safe
# values (constructor-form strings for math types, paths for nodes/resources).

var _ctor_re: RegEx = null

func parse(value):
	match typeof(value):
		TYPE_STRING:
			return _parse_string(value)
		TYPE_ARRAY:
			var out := []
			for e in value:
				out.append(parse(e))
			return out
		TYPE_DICTIONARY:
			return parse_dict(value)
		_:
			return value

func parse_dict(d: Dictionary) -> Dictionary:
	var out := {}
	for k in d:
		out[k] = parse(d[k])
	return out

func _parse_string(s: String):
	var t := s.strip_edges()
	if t.begins_with("#") and Color.html_is_valid(t):
		return Color.html(t)
	if _ctor_re == null:
		_ctor_re = RegEx.new()
		_ctor_re.compile("^(Vector2i|Vector2|Vector3i|Vector3|Vector4|Rect2i|Rect2|Color|NodePath)\\s*\\((.*)\\)$")
	var m := _ctor_re.search(t)
	if m == null:
		return s
	var kind := m.get_string(1)
	var inner := m.get_string(2).strip_edges()
	if kind == "NodePath":
		return NodePath(inner.trim_prefix("\"").trim_suffix("\""))
	if kind == "Color" and inner.begins_with("\""):
		var color_name := inner.trim_prefix("\"").trim_suffix("\"")
		if Color.html_is_valid(color_name):
			return Color.html(color_name)
		return Color.from_string(color_name, Color.WHITE)
	var nums := _floats(inner)
	match kind:
		"Vector2":
			if nums.size() == 2: return Vector2(nums[0], nums[1])
		"Vector2i":
			if nums.size() == 2: return Vector2i(int(nums[0]), int(nums[1]))
		"Vector3":
			if nums.size() == 3: return Vector3(nums[0], nums[1], nums[2])
		"Vector3i":
			if nums.size() == 3: return Vector3i(int(nums[0]), int(nums[1]), int(nums[2]))
		"Vector4":
			if nums.size() == 4: return Vector4(nums[0], nums[1], nums[2], nums[3])
		"Rect2":
			if nums.size() == 4: return Rect2(nums[0], nums[1], nums[2], nums[3])
		"Rect2i":
			if nums.size() == 4: return Rect2i(int(nums[0]), int(nums[1]), int(nums[2]), int(nums[3]))
		"Color":
			if nums.size() == 3: return Color(nums[0], nums[1], nums[2])
			if nums.size() == 4: return Color(nums[0], nums[1], nums[2], nums[3])
	return s

func _floats(inner: String) -> Array:
	if inner.is_empty():
		return []
	var out := []
	for part in inner.split(","):
		var p := part.strip_edges()
		if not p.is_valid_float():
			return []
		out.append(p.to_float())
	return out

func to_jsonable(v):
	match typeof(v):
		TYPE_NIL:
			return null
		TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return v
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return String(v)
		TYPE_ARRAY:
			var out := []
			for e in v:
				out.append(to_jsonable(e))
			return out
		TYPE_DICTIONARY:
			var d := {}
			for k in v:
				d[String(k)] = to_jsonable(v[k])
			return d
		TYPE_OBJECT:
			if v == null or not is_instance_valid(v):
				return null
			if v is Node:
				return String(v.get_path()) if v.is_inside_tree() else "<Node %s>" % String(v.name)
			if v is Resource:
				return v.resource_path if v.resource_path != "" else "<%s>" % v.get_class()
			return "<%s>" % v.get_class()
		TYPE_PACKED_BYTE_ARRAY:
			return {"bytes": v.size()}
		TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY:
			var arr := []
			for e in v:
				arr.append(to_jsonable(e))
			return arr
		_:
			return var_to_str(v).replace("\n", " ")
