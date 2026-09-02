// ============================================================================
//  godotCapsule — the editor-closed half of op:"project_capsule".
//
//  Derives the one-call project picture from the project's own files
//  (project.godot, .godot/global_script_class_cache.cfg, export_presets.cfg,
//  a bounded tree walk) so the capsule answers even before the editor is up.
//  The result carries the same slices as the addon's editor-side capsule with
//  a "source" label naming the derivation honestly: file truth can trail an
//  open editor's unsaved state, and uid:// references stay unresolved here
//  (the uid cache is editor-owned). Every listed slice is budget-bounded;
//  totals are exact. Built-in ui_* input actions are omitted, matching the
//  editor-side capsule.
// ============================================================================

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

export interface GodotStaticCapsule {
  source: string
  engine: string
  project: string
  main_scene: string
  features: string[]
  autoloads: Record<string, string>
  input_actions: string[]
  input_action_count: number
  global_classes: Array<{ class: string; base: string; path: string }>
  global_class_count: number
  scene_count: number
  script_count: number
  scene_paths: string[]
  open_scenes: string[]
  edited_scene: string
  plugins: string[]
  export_presets: Array<{ name: string; platform: string }>
}

const WALK_ENTRY_CAP = 20_000

/** Split project.godot / export_presets.cfg into [section] -> key=value lines. */
function iniSections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let current = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      current = line.slice(1, -1)
      if (!out.has(current)) out.set(current, [])
      continue
    }
    if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) continue
    out.get(current)?.push(line) ?? out.set(current, [line])
  }
  return out
}

function keyOf(line: string): string | null {
  const eq = line.indexOf('=')
  return eq > 0 ? line.slice(0, eq).trim() : null
}

function valueOf(line: string): string {
  const eq = line.indexOf('=')
  return eq > 0 ? line.slice(eq + 1).trim() : ''
}

function unquote(v: string): string {
  return v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v
}

/** Pull the quoted strings out of a PackedStringArray("a", "b") literal. */
function packedStrings(v: string): string[] {
  const out: string[] = []
  for (const m of v.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]!)
  return out
}

function walkCensus(
  dir: string,
  root: string,
  census: { scenes: number; scripts: number; paths: string[]; visited: number },
  budget: number,
): void {
  if (census.visited > WALK_ENTRY_CAP) return
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return
  }
  for (const name of entries) {
    if (census.visited++ > WALK_ENTRY_CAP) return
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkCensus(full, root, census, budget)
    } else if (name.endsWith('.tscn') || name.endsWith('.scn')) {
      census.scenes++
      if (census.paths.length < budget) {
        census.paths.push('res://' + full.slice(root.length + 1).split('\\').join('/'))
      }
    } else if (name.endsWith('.gd')) {
      census.scripts++
    }
  }
}

/** The class-name cache is editor-generated; harvest class/base/path triples. */
function globalClasses(projectRoot: string, budget: number): { list: Array<{ class: string; base: string; path: string }>; total: number } {
  const cache = join(projectRoot, '.godot', 'global_script_class_cache.cfg')
  if (!existsSync(cache)) return { list: [], total: 0 }
  let text: string
  try {
    text = readFileSync(cache, 'utf8')
  } catch {
    return { list: [], total: 0 }
  }
  const list: Array<{ class: string; base: string; path: string }> = []
  let total = 0
  for (const m of text.matchAll(/\{[^}]*"base"\s*:\s*&?"([^"]*)"[^}]*"class"\s*:\s*&?"([^"]*)"[^}]*"path"\s*:\s*"([^"]*)"[^}]*\}/g)) {
    total++
    if (list.length < budget) list.push({ class: m[2]!, base: m[1]!, path: m[3]! })
  }
  return { list, total }
}

function exportPresets(projectRoot: string): Array<{ name: string; platform: string }> {
  const file = join(projectRoot, 'export_presets.cfg')
  if (!existsSync(file)) return []
  let sections: Map<string, string[]>
  try {
    sections = iniSections(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const out: Array<{ name: string; platform: string }> = []
  for (const [section, lines] of sections) {
    if (!/^preset\.\d+$/.test(section)) continue
    let name = ''
    let platform = ''
    for (const line of lines) {
      if (keyOf(line) === 'name') name = unquote(valueOf(line))
      if (keyOf(line) === 'platform') platform = unquote(valueOf(line))
    }
    out.push({ name, platform })
  }
  return out
}

export function staticGodotCapsule(projectRoot: string, budgetArg?: unknown): GodotStaticCapsule {
  const budget = Math.min(200, Math.max(5, Number(budgetArg) || 40))
  const text = readFileSync(join(projectRoot, 'project.godot'), 'utf8')
  const sections = iniSections(text)

  const app = sections.get('application') ?? []
  let project = ''
  let mainScene = ''
  let features: string[] = []
  for (const line of app) {
    if (keyOf(line) === 'config/name') project = unquote(valueOf(line))
    if (keyOf(line) === 'run/main_scene') mainScene = unquote(valueOf(line))
    if (keyOf(line) === 'config/features') features = packedStrings(valueOf(line))
  }

  const autoloads: Record<string, string> = {}
  for (const line of sections.get('autoload') ?? []) {
    const key = keyOf(line)
    if (key) autoloads[key] = unquote(valueOf(line)).replace(/^\*/, '')
  }

  const inputActions: string[] = []
  for (const line of sections.get('input') ?? []) {
    const key = keyOf(line)
    if (key && !key.startsWith('ui_')) inputActions.push(key)
  }
  inputActions.sort()

  const plugins: string[] = []
  for (const line of sections.get('editor_plugins') ?? []) {
    if (keyOf(line) === 'enabled') plugins.push(...packedStrings(valueOf(line)))
  }

  const classes = globalClasses(projectRoot, budget)
  const census = { scenes: 0, scripts: 0, paths: [] as string[], visited: 0 }
  walkCensus(projectRoot, projectRoot, census, budget)

  const versionFeature = features.find(f => /^\d+\.\d+/.test(f))
  return {
    source: 'static (editor closed — derived from project files; unsaved editor state and uid:// resolution need the live editor)',
    engine: versionFeature ? `${versionFeature} (from project features; editor closed)` : '(unknown — editor closed)',
    project,
    main_scene: mainScene.length > 0 ? mainScene : '(none)',
    features,
    autoloads,
    input_actions: inputActions.slice(0, budget),
    input_action_count: inputActions.length,
    global_classes: classes.list,
    global_class_count: classes.total,
    scene_count: census.scenes,
    script_count: census.scripts,
    scene_paths: census.paths,
    open_scenes: [],
    edited_scene: '(editor closed)',
    plugins,
    export_presets: exportPresets(projectRoot),
  }
}
