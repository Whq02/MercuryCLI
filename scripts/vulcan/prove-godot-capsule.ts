#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { staticGodotCapsule } = await import(join(ROOT, 'src/services/vulcan/godotCapsule.ts'))
const { derivePresence } = await import(join(ROOT, 'src/services/vulcan/editorPresence.ts'))
const NO_EDITOR = derivePresence(6010, false, { ok: true, processes: [] }, '/fixture')
const UNBRIDGED = derivePresence(
  6010,
  false,
  { ok: true, processes: [{ pid: 4242, executable: '/Applications/Godot.app/Contents/MacOS/Godot', args: '--editor --path /fixture', editor: true, headless: false, project: '/fixture' }] },
  '/fixture',
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Godot project capsule (static half) — proof')
console.log('============================================================')

const scratch = mkdtempSync(join(tmpdir(), 'godot-capsule-'))
try {
  const proj = join(scratch, 'game')
  mkdirSync(join(proj, 'scenes'), { recursive: true })
  mkdirSync(join(proj, 'scripts'), { recursive: true })
  mkdirSync(join(proj, '.godot'), { recursive: true })
  writeFileSync(
    join(proj, 'project.godot'),
    [
      'config_version=5',
      '',
      '[application]',
      '',
      'config/name="Capsule Fixture"',
      'run/main_scene="uid://c8yhhbwq6kxu1"',
      'config/features=PackedStringArray("4.6", "Forward Plus")',
      '',
      '[autoload]',
      '',
      'GameState="*res://scripts/game_state.gd"',
      'SoundBus="res://scripts/sound_bus.gd"',
      '',
      '[editor_plugins]',
      '',
      'enabled=PackedStringArray("res://addons/mercury_vulcan/plugin.cfg")',
      '',
      '[input]',
      '',
      'move_left={"deadzone":0.5}',
      'move_right={"deadzone":0.5}',
      'interact={"deadzone":0.5}',
      'ui_accept={"deadzone":0.5}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(proj, '.godot', 'global_script_class_cache.cfg'),
    'list=Array[Dictionary]([{\n"base": &"Node",\n"class": &"GameState",\n"icon": "",\n"language": &"GDScript",\n"path": "res://scripts/game_state.gd"\n}, {\n"base": &"CharacterBody2D",\n"class": &"Player",\n"icon": "",\n"language": &"GDScript",\n"path": "res://scripts/player.gd"\n}])\n',
  )
  writeFileSync(
    join(proj, 'export_presets.cfg'),
    '[preset.0]\n\nname="macOS"\nplatform="macOS"\n\n[preset.0.options]\n\ncodesign/identity=""\n\n[preset.1]\n\nname="Web"\nplatform="Web"\n',
  )
  for (const s of ['main.tscn', 'scenes/level_1.tscn', 'scenes/level_2.tscn']) {
    writeFileSync(join(proj, s), '[gd_scene format=3]\n')
  }
  for (const s of ['scripts/game_state.gd', 'scripts/sound_bus.gd', 'scripts/player.gd']) {
    writeFileSync(join(proj, s), 'extends Node\n')
  }

  const capsule = staticGodotCapsule(proj, undefined, NO_EDITOR)
  check('labeled as file-derived, naming the editor state', capsule.source.startsWith('static (no editor running — derived from project files'), capsule.source)
  check('project name', capsule.project === 'Capsule Fixture', capsule.project)
  check('uid main scene passes through unresolved', capsule.main_scene === 'uid://c8yhhbwq6kxu1', capsule.main_scene)
  check('engine derived from the features tag', capsule.engine.startsWith('4.6'), capsule.engine)
  check('features', capsule.features.join(',') === '4.6,Forward Plus', capsule.features.join(','))
  check(
    'autoloads with the enable star stripped',
    capsule.autoloads['GameState'] === 'res://scripts/game_state.gd' && capsule.autoloads['SoundBus'] === 'res://scripts/sound_bus.gd',
    JSON.stringify(capsule.autoloads),
  )
  check(
    'input actions exclude ui_ built-ins, sorted',
    capsule.input_actions.join(',') === 'interact,move_left,move_right' && capsule.input_action_count === 3,
    capsule.input_actions.join(','),
  )
  check('plugins', capsule.plugins.join(',') === 'res://addons/mercury_vulcan/plugin.cfg', capsule.plugins.join(','))
  check(
    'global classes from the editor cache',
    capsule.global_class_count === 2 &&
      capsule.global_classes.some(c => c.class === 'Player' && c.base === 'CharacterBody2D' && c.path === 'res://scripts/player.gd'),
    JSON.stringify(capsule.global_classes),
  )
  check('scene census exact', capsule.scene_count === 3 && capsule.scene_paths.length === 3, String(capsule.scene_count))
  check('script census exact', capsule.script_count === 3, String(capsule.script_count))
  check('census paths are res:// relative', capsule.scene_paths.every(p => p.startsWith('res://')), capsule.scene_paths.join(','))
  check(
    'export presets without options sections',
    JSON.stringify(capsule.export_presets) === JSON.stringify([{ name: 'macOS', platform: 'macOS' }, { name: 'Web', platform: 'Web' }]),
    JSON.stringify(capsule.export_presets),
  )
  check('editor-only slices render their absence with the state, never "closed"', capsule.edited_scene === '(no editor running)' && capsule.open_scenes.length === 0 && capsule.engine === '4.6 (from project features; no editor running)')
  check('the class cache reads fresh here (no class_name script newer than it)', capsule.class_cache.state === 'fresh' && capsule.class_cache.hint === '')

  const again = staticGodotCapsule(proj, undefined, NO_EDITOR)
  check('deterministic (two reads identical)', JSON.stringify(capsule) === JSON.stringify(again))

  const bounded = staticGodotCapsule(proj, 5, NO_EDITOR)
  check(
    'budget floor bounds lists, totals stay exact',
    bounded.scene_paths.length <= 5 && bounded.scene_count === 3 && bounded.global_class_count === 2,
  )

  const open = staticGodotCapsule(proj, undefined, UNBRIDGED)
  check(
    'an open, unbridged editor is never called closed',
    open.source.startsWith('static (editor running (pid 4242), bridge dark — open but unbridged') && open.edited_scene === '(editor open but unbridged)' && !/closed/.test(open.engine),
    open.source,
  )

  writeFileSync(join(proj, 'scripts', 'enemy.gd'), 'class_name Enemy\nextends Node2D\n')
  const staleCap = staticGodotCapsule(proj, undefined, NO_EDITOR)
  check(
    'a class_name script missing from the cache marks the cache stale, naming project_refresh_classes',
    staleCap.class_cache.state === 'stale' && staleCap.class_cache.stale.some(s => s.class === 'Enemy' && s.reason === 'missing-from-cache') && staleCap.class_cache.hint.includes('op:"project_refresh_classes"'),
    staleCap.class_cache.hint,
  )

  const bare = join(scratch, 'bare')
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Bare"\n')
  const empty = staticGodotCapsule(bare, undefined, NO_EDITOR)
  check(
    'bare project renders absence honestly',
    empty.main_scene === '(none)' && empty.engine.includes('unknown') && empty.global_class_count === 0 && empty.scene_count === 0,
    `${empty.main_scene} · ${empty.engine}`,
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '✅ godot capsule proof PASS' : `❌ godot capsule proof: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
