//  global-classes slice reads the class cache through classCache, which also

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { classCacheReport, type StaleClass } from './classCache.js'
import { editorOnlySliceWords, staticCapsuleSource, type GodotEditorPresence } from './editorPresence.js'

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
  class_cache: { state: 'fresh' | 'stale' | 'absent'; stale: Array<Pick<StaleClass, 'class' | 'path' | 'reason'>>; hint: string }
  scene_count: number
  script_count: number
  scene_paths: string[]
  open_scenes: string[]
  edited_scene: string
  plugins: string[]
  export_presets: Array<{ name: string; platform: string }>
}

const WALK_ENTRY_CAP = 20_000

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

export function staticGodotCapsule(projectRoot: string, budgetArg: unknown, presence: GodotEditorPresence): GodotStaticCapsule {
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

  const cache = classCacheReport(projectRoot, budget)
  const census = { scenes: 0, scripts: 0, paths: [] as string[], visited: 0 }
  walkCensus(projectRoot, projectRoot, census, budget)

  const versionFeature = features.find(f => /^\d+\.\d+/.test(f))
  const sliceWords = editorOnlySliceWords(presence)
  return {
    source: staticCapsuleSource(presence),
    engine: versionFeature ? `${versionFeature} (from project features; ${presence.words})` : `(unknown — ${presence.words})`,
    project,
    main_scene: mainScene.length > 0 ? mainScene : '(none)',
    features,
    autoloads,
    input_actions: inputActions.slice(0, budget),
    input_action_count: inputActions.length,
    global_classes: cache.classes,
    global_class_count: cache.classTotal,
    class_cache: {
      state: cache.state,
      stale: cache.stale.slice(0, budget).map(s => ({ class: s.class, path: s.path, reason: s.reason })),
      hint: cache.hint,
    },
    scene_count: census.scenes,
    script_count: census.scripts,
    scene_paths: census.paths,
    open_scenes: [],
    edited_scene: sliceWords,
    plugins,
    export_presets: exportPresets(projectRoot),
  }
}
