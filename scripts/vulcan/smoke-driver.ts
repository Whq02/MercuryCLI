#!/usr/bin/env bun
// smoke-driver — the live-vulcan-smoke.sh helper: `install <proj>` materializes
// the bundled addon; `drive <proj>` runs the live loop against the REAL editor
// through the production client (create scene → add node → tree → play →
// status → stop). RUN_LIVE-only territory; never part of the deterministic gate.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWithCwdOverride } from '../../src/utils/cwd.js'
import { applyVulcanInstall } from '../../src/services/vulcan/addonInstaller.js'
import { VulcanClient } from '../../src/services/vulcan/vulcanClient.js'
import { ensureVulcanToken } from '../../src/services/vulcan/vulcanToken.js'
import { vulcanPort } from '../../src/utils/vulcan/vulcanGates.js'

const [mode, proj] = process.argv.slice(2)
if (!mode || !proj) {
  console.error('usage: smoke-driver.ts install|drive <project-dir>')
  process.exit(2)
}

if (mode === 'install') {
  const report = runWithCwdOverride(proj, () => applyVulcanInstall(proj))
  console.log(report)
  if (report.includes('bundle is empty')) process.exit(1)
  process.exit(0)
}

async function expectOk(client: VulcanClient, op: string, args?: Record<string, unknown>) {
  const r = await client.request(op, args, 20_000)
  if (!r.ok) {
    console.error(`✗ ${op}: [${r.error.code}] ${r.error.message}${r.error.hint ? ` — ${r.error.hint}` : ''}`)
    process.exit(1)
  }
  console.log(`✓ ${op}`)
  return r.result
}

const token = ensureVulcanToken(proj)
const client = new VulcanClient({ port: vulcanPort(), token })
// The editor may still be importing — retry the first contact for up to ~60s.
let up = false
for (let i = 0; i < 30 && !up; i++) {
  const r = await client.request('ping', undefined, 3_000)
  if (r.ok) up = true
  else await new Promise(res => setTimeout(res, 2_000))
}
if (!up) {
  console.error('✗ editor never answered (see editor.log)')
  process.exit(1)
}
await expectOk(client, 'editor_state')
const capsule = (await expectOk(client, 'project_capsule')) as Record<string, unknown>
if (capsule['source'] !== 'editor' || typeof capsule['autoloads'] !== 'object' || typeof capsule['engine'] !== 'string') {
  console.error(`✗ project_capsule shape: ${JSON.stringify(capsule).slice(0, 200)}`)
  process.exit(1)
}
await expectOk(client, 'scene_create', { path: 'res://smoke.tscn', root_type: 'Node2D', root_name: 'Root' })
await expectOk(client, 'node_add', { parent: 'Root', type: 'Sprite2D', name: 'Hero' })
const tree = (await expectOk(client, 'scene_tree', {})) as unknown
if (!JSON.stringify(tree).includes('Hero')) {
  console.error('✗ scene_tree does not show the added node')
  process.exit(1)
}
// Anchored mutation: a stale expect refuses with the live value; a true
// expect writes and the receipt carries the previous value.
const stale = (await client.request('node_set_property', { node: 'Hero', property: 'position', value: 'Vector2(5, 5)', expect: 'Vector2(9, 9)' }, 15_000)) as {
  ok: boolean
  error?: { code: string; message: string }
}
if (stale.ok || stale.error?.code !== 'ANCHOR_MISMATCH') {
  console.error(`✗ stale anchor should refuse: ${JSON.stringify(stale).slice(0, 250)}`)
  process.exit(1)
}
const anchored = (await client.request('node_set_property', { node: 'Hero', property: 'position', value: 'Vector2(5, 5)', expect: 'Vector2(0, 0)' }, 15_000)) as {
  ok: boolean
  result?: { changed?: boolean; previous?: unknown }
}
if (!anchored.ok || anchored.result?.changed !== true || anchored.result?.previous === undefined) {
  console.error(`✗ anchored write: ${JSON.stringify(anchored).slice(0, 250)}`)
  process.exit(1)
}
console.log('✓ node_set_property expect anchor (stale refused with live value; true anchor wrote + previous in receipt)')
await expectOk(client, 'editor_undo')
await expectOk(client, 'editor_undo')
await expectOk(client, 'scene_save')
await expectOk(client, 'scene_play', { scene: 'current' })
// The play-mode bridge attaches asynchronously (game-process spawn + boot +
// back-connect; a cold headless editor can hold the spawn for tens of
// seconds, and macOS Gatekeeper translocation slows a quarantined binary's
// first child launch) — poll for the settled state, never a fixed sleep.
let bridged = false
for (let i = 0; i < 90 && !bridged; i++) {
  await new Promise(res => setTimeout(res, 2_000))
  const st = await client.request('runtime_status', undefined, 5_000)
  if (st.ok) {
    bridged = true
    console.log('✓ runtime_status (bridge attached)')
  } else if (i > 0 && i % 15 === 0) {
    console.log(`… still waiting for the play-mode bridge (${i * 2}s; a quarantined binary's first child spawn can sit under Gatekeeper scanning for minutes)`)
  }
}
if (!bridged) {
  console.error('✗ runtime bridge never attached after scene_play (180s)')
  // Stop the play session so no orphaned game process outlives the smoke.
  await client.request('scene_stop', undefined, 10_000)
  process.exit(1)
}
await expectOk(client, 'runtime_tree')
await expectOk(client, 'scene_stop')
// The composed evidence loop, as a second fresh session (screenshot off —
// the dummy renderer has no image; the bundle's other slices stay real).
const bundle = (await client.request(
  'playtest_run',
  { duration_ms: 1500, settle_ms: 300, screenshot: false, hitch_ms: 40 },
  180_000,
)) as { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } }
if (!bundle.ok) {
  console.error(`✗ playtest_run: [${bundle.error?.code}] ${bundle.error?.message}`)
  process.exit(1)
}
const evidence = bundle.result as { frames?: { frames?: number }; monitor_deltas?: unknown; stopped?: unknown }
if (!evidence.frames || typeof evidence.frames.frames !== 'number' || evidence.frames.frames < 10 || evidence.stopped !== true) {
  console.error(`✗ playtest_run bundle shape: ${JSON.stringify(evidence).slice(0, 300)}`)
  process.exit(1)
}
console.log(`✓ playtest_run (${evidence.frames.frames} frames sampled, session stopped)`)

// Asset integrity + import pipeline: a real texture import, a scene with a
// dead dependency, a script with a dead res:// literal — all via the editor.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
writeFileSync(join(proj, 'dot.png'), Buffer.from(PNG_1X1, 'base64'))
writeFileSync(
  join(proj, 'broken.tscn'),
  '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Texture2D" path="res://missing.png" id="1_x"]\n\n[node name="Broken" type="Sprite2D"]\ntexture = ExtResource("1_x")\n',
)
writeFileSync(join(proj, 'dangling.gd'), 'extends Node\n\nfunc _ready() -> void:\n\tvar t: Resource = load("res://nope.png")\n\tprint(t)\n')
await expectOk(client, 'editor_reload', { what: 'filesystem' })
let imported: { importer?: string; params?: Record<string, unknown> } | null = null
for (let i = 0; i < 30 && !imported; i++) {
  await new Promise(res => setTimeout(res, 2_000))
  const r = await client.request('import_get', { path: 'res://dot.png' }, 10_000)
  if (r.ok) imported = r.result as typeof imported
}
if (!imported || imported.importer !== 'texture' || typeof imported.params !== 'object') {
  console.error(`✗ import_get after scan: ${JSON.stringify(imported).slice(0, 200)}`)
  process.exit(1)
}
console.log('✓ import_get (texture importer, params visible)')
const setr = (await client.request('import_set', { path: 'res://dot.png', params: { 'mipmaps/generate': true } }, 60_000)) as {
  ok: boolean
  result?: { changed?: Record<string, { to?: unknown }>; reimported?: boolean }
  error?: { code: string; message: string }
}
if (!setr.ok || setr.result?.changed?.['mipmaps/generate']?.to !== true || setr.result?.reimported !== true) {
  console.error(`✗ import_set: ${JSON.stringify(setr).slice(0, 250)}`)
  process.exit(1)
}
const confirm = (await client.request('import_get', { path: 'res://dot.png' }, 10_000)) as { ok: boolean; result?: { params?: Record<string, unknown> } }
if (!confirm.ok || confirm.result?.params?.['mipmaps/generate'] !== true) {
  console.error(`✗ import_set did not persist: ${JSON.stringify(confirm.result?.params).slice(0, 200)}`)
  process.exit(1)
}
console.log('✓ import_set (param written + reimported + read back)')
const refs = (await client.request('broken_refs', {}, 60_000)) as {
  ok: boolean
  result?: { finding_count?: number; findings?: Array<{ file: string; ref: string; kind: string }> }
}
const findings = refs.ok ? (refs.result?.findings ?? []) : []
const sceneHit = findings.some(f => f.file.includes('broken.tscn') && f.ref === 'res://missing.png' && f.kind === 'broken')
const scriptHit = findings.some(f => f.file.includes('dangling.gd') && f.ref === 'res://nope.png' && f.kind === 'script_literal_missing')
if (!refs.ok || !sceneHit || !scriptHit || refs.result?.finding_count !== 2) {
  console.error(`✗ broken_refs (want exactly the 2 planted findings): ${JSON.stringify(refs).slice(0, 400)}`)
  process.exit(1)
}
console.log('✓ broken_refs (exactly the 2 planted findings: dead dependency + dead script literal)')

// Scene-aware refactors: a signal wired in the inspector and an @export
// override, renamed once, with the .tscn text and reload as the verdict.
writeFileSync(
  join(proj, 'player.gd'),
  'extends Node2D\nclass_name SmokePlayer\n\nsignal died(cause)\n\n@export var speed: float = 100.0\n\nfunc _ready() -> void:\n\tdied.emit("boot")\n\temit_signal("died", "again")\n\tprint(speed)\n',
)
writeFileSync(
  join(proj, 'arena.gd'),
  'extends Node2D\n\nfunc hook(p: SmokePlayer) -> void:\n\tp.died.connect(_on_player_died)\n\nfunc _on_player_died(_cause: Variant) -> void:\n\tpass\n',
)
writeFileSync(
  join(proj, 'arena.tscn'),
  '[gd_scene load_steps=3 format=3]\n\n[ext_resource type="Script" path="res://arena.gd" id="1_a"]\n[ext_resource type="Script" path="res://player.gd" id="2_p"]\n\n[node name="Arena" type="Node2D"]\nscript = ExtResource("1_a")\n\n[node name="Player" type="Node2D" parent="."]\nscript = ExtResource("2_p")\nspeed = 250.0\n\n[connection signal="died" from="Player" to="." method="_on_player_died"]\n',
)
await expectOk(client, 'editor_reload', { what: 'filesystem' })
await new Promise(res => setTimeout(res, 4_000))
const dryRun = (await client.request('refactor_rename_signal', { script: 'res://player.gd', from: 'died', to: 'perished', dry_run: true }, 60_000)) as {
  ok: boolean
  result?: { scenes_rewritten?: Array<{ scene: string }>; findings?: Array<{ file: string }> }
}
if (!dryRun.ok || !dryRun.result?.scenes_rewritten?.some(s => s.scene === 'res://arena.tscn')) {
  console.error(`✗ refactor_rename_signal dry_run: ${JSON.stringify(dryRun).slice(0, 400)}`)
  process.exit(1)
}
if (readFileSync(join(proj, 'arena.tscn'), 'utf8').includes('perished')) {
  console.error('✗ dry_run wrote to disk')
  process.exit(1)
}
console.log('✓ refactor_rename_signal dry_run (planned, wrote nothing)')
const renameSig = (await client.request('refactor_rename_signal', { script: 'res://player.gd', from: 'died', to: 'perished' }, 60_000)) as {
  ok: boolean
  result?: { scenes_rewritten?: Array<{ scene: string }>; findings?: Array<{ file: string }>; script_edits?: Array<{ file: string }> }
  error?: { code: string; message: string }
}
const sceneText = readFileSync(join(proj, 'arena.tscn'), 'utf8')
const playerText = readFileSync(join(proj, 'player.gd'), 'utf8')
const sigOk =
  renameSig.ok &&
  renameSig.result?.scenes_rewritten?.some(s => s.scene === 'res://arena.tscn') &&
  sceneText.includes('signal="perished"') &&
  !sceneText.includes('signal="died"') &&
  playerText.includes('signal perished') &&
  playerText.includes('perished.emit') &&
  playerText.includes('emit_signal("perished"') &&
  (renameSig.result?.findings ?? []).some(f => f.file.startsWith('res://arena.gd'))
if (!sigOk) {
  console.error(`✗ refactor_rename_signal: ${JSON.stringify(renameSig).slice(0, 500)}`)
  process.exit(1)
}
console.log('✓ refactor_rename_signal (connection + declaration + emits renamed; foreign site reported)')
const renameExp = (await client.request('refactor_rename_export', { script: 'res://player.gd', from: 'speed', to: 'move_speed' }, 60_000)) as {
  ok: boolean
  result?: { files_rewritten?: Array<{ file: string }> }
  error?: { code: string; message: string }
}
const sceneText2 = readFileSync(join(proj, 'arena.tscn'), 'utf8')
const playerText2 = readFileSync(join(proj, 'player.gd'), 'utf8')
const expOk =
  renameExp.ok &&
  renameExp.result?.files_rewritten?.some(f => f.file === 'res://arena.tscn') &&
  sceneText2.includes('move_speed = 250.0') &&
  !sceneText2.includes('\nspeed = ') &&
  playerText2.includes('@export var move_speed') &&
  playerText2.includes('print(move_speed)')
if (!expOk) {
  console.error(`✗ refactor_rename_export: ${JSON.stringify(renameExp).slice(0, 500)}`)
  process.exit(1)
}
console.log('✓ refactor_rename_export (scene override + declaration + uses renamed)')
client.close()
console.log('drive complete')
