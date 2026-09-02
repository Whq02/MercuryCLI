@tool
class_name MercuryVulcanExport
# mercury_vulcan — Export category handlers (static module, read-only + exec).
# export_run INVESTIGATION (documented per the writer contract): Godot 4.x exposes
# NO scriptable export API to GDScript — EditorExportPlugin is hook-only, and the
# editor's export pipeline (EditorExport/EditorExportManager) is C++-internal, not in
# ClassDB for tool scripts. We probe ClassDB at runtime anyway so a future 4.x that
# exposes one flips the hint, but today export_run always answers EDITOR_LIMIT with
# the exact CLI to run. The registry maps the "export" optable category to this file
# (named export_cat.gd because "export" is a GDScript keyword).


static func ops() -> Array:
	return ["export_presets", "export_templates", "export_run"]


static func handle(op: String, args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	match op:
		"export_presets":
			return _presets(args, ctx)
		"export_templates":
			return _templates(args, ctx)
		"export_run":
			return _run(args, ctx)
	return ctx.err("UNKNOWN_OP", "export does not handle '%s'" % op, "one of: %s" % ", ".join(ops()))


static func _presets(_args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var cfg_path := "res://export_presets.cfg"
	if not FileAccess.file_exists(cfg_path):
		return ctx.err("NOT_FOUND", "no export_presets.cfg in the project", "create presets in the editor: Project > Export…")
	var cf := ConfigFile.new()
	var err := cf.load(cfg_path)
	if err != OK:
		return ctx.err("LOAD_FAILED", "could not parse export_presets.cfg (error %d)" % err, "open Project > Export… in the editor to repair it")
	var presets: Array = []
	for section in cf.get_sections():
		# preset sections are "preset.N"; their options live in "preset.N.options"
		if not section.begins_with("preset.") or section.ends_with(".options"):
			continue
		var entry := {
			"name": String(cf.get_value(section, "name", "")),
			"platform": String(cf.get_value(section, "platform", "")),
			"runnable": bool(cf.get_value(section, "runnable", false)),
			"export_path": String(cf.get_value(section, "export_path", "")),
			"include_filter": String(cf.get_value(section, "include_filter", "")),
			"exclude_filter": String(cf.get_value(section, "exclude_filter", "")),
		}
		var opt_section := section + ".options"
		if cf.has_section(opt_section):
			var keys := cf.get_section_keys(opt_section)
			entry["option_count"] = keys.size()
			var sample := {}
			for i in mini(keys.size(), 12):
				sample[keys[i]] = str(cf.get_value(opt_section, keys[i]))
			entry["options_sample"] = sample
		presets.append(entry)
	return { "ok": true, "result": { "count": presets.size(), "presets": presets } }


static func _templates(_args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var paths = ctx.editor.get_editor_paths()
	if paths == null:
		return ctx.err("EDITOR_LIMIT", "EditorPaths unavailable", "run inside a full editor build (not headless-stripped)")
	var templates_root: String = paths.get_data_dir().path_join("export_templates")
	var info := Engine.get_version_info()
	var expected := "%d.%d.%s" % [info.major, info.minor, String(info.get("status", "stable"))]
	if int(info.get("patch", 0)) > 0:
		expected = "%d.%d.%d.%s" % [info.major, info.minor, info.patch, String(info.get("status", "stable"))]
	var versions: Array = []
	var d := DirAccess.open(templates_root)
	if d != null:
		d.list_dir_begin()
		var entry := d.get_next()
		while entry != "":
			if d.current_is_dir() and not entry.begins_with("."):
				var files: Array = []
				var vd := DirAccess.open(templates_root.path_join(entry))
				if vd != null:
					vd.list_dir_begin()
					var f := vd.get_next()
					while f != "":
						if not vd.current_is_dir():
							files.append(f)
						f = vd.get_next()
					vd.list_dir_end()
				versions.append({ "version": entry, "files": files, "matches_editor": entry == expected })
			entry = d.get_next()
		d.list_dir_end()
	return { "ok": true, "result": {
		"templates_dir": templates_root,
		"editor_version": expected,
		"installed": versions,
		"installed_for_this_editor": versions.any(func(v): return bool(v.matches_editor)),
		"hint": "" if versions.size() > 0 else "no templates installed — Editor > Manage Export Templates…, or godot --headless --install-export-templates",
	} }


static func _run(args: Dictionary, ctx: MercuryVulcanContext) -> Dictionary:
	var preset := String(args.get("preset", "<preset name>"))
	var out := String(args.get("out", "<output path>"))
	var flavor := "--export-debug" if bool(args.get("debug", false)) else "--export-release"
	# Probe for a scriptable export manager (none exists in 4.x today; see header).
	for klass in ["EditorExportManager", "EditorExport"]:
		if ClassDB.class_exists(klass) and ClassDB.can_instantiate(klass):
			return ctx.err("EDITOR_LIMIT", "a scriptable %s exists in this Godot build but mercury_vulcan does not drive it yet" % klass, "export from the shell: godot --headless %s \"%s\" \"%s\" --path <project dir>" % [flavor, preset, out])
	return ctx.err("EDITOR_LIMIT", "Godot 4.x has no scriptable in-editor export API (EditorExportPlugin is hook-only)", "exporting runs the godot CLI: godot --headless %s \"%s\" \"%s\" --path <project dir> — run it from the shell; check presets first with export_presets and templates with export_templates" % [flavor, preset, out])
