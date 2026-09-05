#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWithCwdOverride } from '../../src/utils/cwd.js'
import { applyVulcanInstall } from '../../src/services/vulcan/addonInstaller.js'
import { VulcanClient } from '../../src/services/vulcan/vulcanClient.js'
import { ensureVulcanToken } from '../../src/services/vulcan/vulcanToken.js'
import { vulcanPort } from '../../src/utils/vulcan/vulcanGates.js'

const [mode, proj] = process.argv.slice(2)
if (!mode || !proj) {
  console.error('usage: smoke-driver.ts install|drive|game <project-dir>')
  process.exit(2)
}

if (mode === 'install') {
  const report = await runWithCwdOverride(proj, () => applyVulcanInstall(proj))
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

const STEPPER_GD = [
  'extends Node2D',
  '# Counts what the game hears (action events in the callbacks) and what it',
  '# sees (the polled action state, sampled once per _process), plus frames.',
  'var frames := 0',
  'var physics_frames := 0',
  'var jump_events := 0',
  'var jump_release_events := 0',
  'var jump_input_events := 0',
  'var jump_strength := 0.0',
  'var jump_polled := false',
  'var jump_polled_frames := 0',
  'var jump_polled_strength := 0.0',
  'var jump_just_pressed_frames := 0',
  'var left_events := 0',
  'var left_release_events := 0',
  'var left_frames := 0',
  '',
  'func _process(_delta: float) -> void:',
  '\tframes += 1',
  '\tjump_polled = Input.is_action_pressed("jump")',
  '\tif jump_polled:',
  '\t\tjump_polled_frames += 1',
  '\tjump_polled_strength = Input.get_action_strength("jump")',
  '\tif Input.is_action_just_pressed("jump"):',
  '\t\tjump_just_pressed_frames += 1',
  '\tif Input.is_action_pressed("left"):',
  '\t\tleft_frames += 1',
  '',
  'func _physics_process(_delta: float) -> void:',
  '\tphysics_frames += 1',
  '',
  'func _input(event: InputEvent) -> void:',
  '\tif event.is_action_pressed("jump"):',
  '\t\tjump_input_events += 1',
  '',
  'func _unhandled_input(event: InputEvent) -> void:',
  '\tif event.is_action_pressed("jump"):',
  '\t\tjump_events += 1',
  '\t\tjump_strength = event.get_action_strength("jump")',
  '\telif event.is_action_released("jump"):',
  '\t\tjump_release_events += 1',
  '\telif event.is_action_pressed("left"):',
  '\t\tleft_events += 1',
  '\telif event.is_action_released("left"):',
  '\t\tleft_release_events += 1',
  '',
].join('\n')
const STEPPER_TSCN =
  '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://stepper.gd" id="1_s"]\n\n[node name="Stepper" type="Node2D"]\nscript = ExtResource("1_s")\n'

type Counters = Record<string, number | boolean>
let gameFailures = 0
function pin(label: string, cond: boolean, detail = ''): void {
  if (!cond) gameFailures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))
type Answer = { ok: true; result: Record<string, unknown> } | { ok: false; error: { code: string; message: string; hint?: string } }
async function ask(client: VulcanClient, op: string, args?: Record<string, unknown>, timeoutMs = 30_000): Promise<Answer> {
  const r = (await client.request(op, args, timeoutMs)) as Answer
  const shown = r.ok ? JSON.stringify(r.result) : `[${r.error.code}] ${r.error.message}`
  console.log(`  · ${op}${args ? ' ' + JSON.stringify(args) : ''} → ${shown.length > 400 ? shown.slice(0, 399) + '…' : shown}`)
  return r
}
async function counters(client: VulcanClient): Promise<Counters> {
  const r = await client.request('runtime_node_get', { node: 'Stepper' }, 10_000)
  if (!r.ok) {
    console.error(`✗ runtime_node_get Stepper: [${r.error.code}] ${r.error.message}`)
    process.exit(1)
  }
  const props = (r.result as { properties?: Counters }).properties ?? {}
  console.log(`  · counters ${JSON.stringify(props)}`)
  return props
}
const n = (c: Counters, k: string): number => (typeof c[k] === 'number' ? (c[k] as number) : Number.NaN)
const near = (a: number, b: number) => Math.abs(a - b) < 0.001

async function gameLeg(client: VulcanClient, proj: string): Promise<void> {
  writeFileSync(join(proj, 'stepper.gd'), STEPPER_GD)
  writeFileSync(join(proj, 'stepper.tscn'), STEPPER_TSCN)
  await expectOk(client, 'input_map_add', { action: 'jump', events: [{ key: 'Space' }] })
  await expectOk(client, 'input_map_add', { action: 'left', events: [{ key: 'Left' }] })
  await expectOk(client, 'editor_reload', { what: 'filesystem' })
  await expectOk(client, 'scene_play', { scene: 'res://stepper.tscn' })
  let bridged = false
  for (let i = 0; i < 90 && !bridged; i++) {
    await sleep(2_000)
    const st = await client.request('runtime_status', undefined, 5_000)
    if (st.ok) bridged = true
  }
  if (!bridged) {
    console.error('✗ runtime bridge never attached after scene_play (180s)')
    await client.request('scene_stop', undefined, 10_000)
    process.exit(1)
  }
  await sleep(500)

  console.log('\n§1 a press is an event: the callbacks AND the polled state see it (live game)')
  const c0 = await counters(client)
  pin('the fixture runs (frames advance before anything is pressed)', n(c0, 'frames') > 0, `frames=${n(c0, 'frames')}`)
  await ask(client, 'input_action', { action: 'jump', pressed: true, strength: 0.5 })
  await sleep(300)
  const c1 = await counters(client)
  console.log(`  ▸ measured: jump_events=${n(c1, 'jump_events')} jump_input_events=${n(c1, 'jump_input_events')} jump_polled=${c1['jump_polled']} jump_strength=${n(c1, 'jump_strength')} jump_polled_strength=${n(c1, 'jump_polled_strength')}`)
  pin('the polled state sees the held press (Input.is_action_pressed)', c1['jump_polled'] === true)
  pin('_unhandled_input heard ONE pressed InputEventAction', n(c1, 'jump_events') === 1, `got ${n(c1, 'jump_events')}`)
  pin('_input heard it too', n(c1, 'jump_input_events') === 1, `got ${n(c1, 'jump_input_events')}`)
  pin('the strength rides the event (0.5)', near(n(c1, 'jump_strength'), 0.5), `got ${n(c1, 'jump_strength')}`)
  pin('the strength rides the polled state (0.5)', near(n(c1, 'jump_polled_strength'), 0.5), `got ${n(c1, 'jump_polled_strength')}`)
  await ask(client, 'input_action', { action: 'jump', pressed: false })
  await sleep(300)
  const c2 = await counters(client)
  pin('the release is an event the callbacks hear', n(c2, 'jump_release_events') === 1, `got ${n(c2, 'jump_release_events')}`)
  pin('the polled state sees the release', c2['jump_polled'] === false)
  await ask(client, 'input_action', { action: 'jump' })
  await sleep(300)
  const c3 = await counters(client)
  pin('a tap is a pressed event + a released event', n(c3, 'jump_events') === 2 && n(c3, 'jump_release_events') === 2, `events=${n(c3, 'jump_events')} releases=${n(c3, 'jump_release_events')}`)
  pin('a tap reads as just-pressed for one frame in the polled state', n(c3, 'jump_just_pressed_frames') === n(c2, 'jump_just_pressed_frames') + 1, `before=${n(c2, 'jump_just_pressed_frames')} after=${n(c3, 'jump_just_pressed_frames')}`)

  console.log('\n§1b a press parsed into a tree the GAME paused (no step mode) is lost to a pausable node — why step mode queues')
  await ask(client, 'runtime_eval', { expression: 'get_tree().set_pause(true)' })
  await sleep(200)
  const cp0 = await counters(client)
  await ask(client, 'input_action', { action: 'jump', pressed: true })
  await sleep(300)
  await ask(client, 'runtime_eval', { expression: 'get_tree().set_pause(false)' })
  await sleep(300)
  const cp1 = await counters(client)
  console.log(`  ▸ measured: jump_events ${n(cp0, 'jump_events')} → ${n(cp1, 'jump_events')}; jump_polled after unpause=${cp1['jump_polled']}`)
  pin('the paused node never heard the event', n(cp1, 'jump_events') === n(cp0, 'jump_events'))
  pin('the action state still flipped (the press survives only as polled state)', cp1['jump_polled'] === true)
  await ask(client, 'input_action', { action: 'jump', pressed: false })
  await sleep(300)

  console.log('\n§2 step mode: game time passes only while the agent acts')
  const st0 = await ask(client, 'runtime_status')
  pin('runtime_status names the mode: live', st0.ok && st0.result['mode'] === 'live' && st0.result['paused'] === false)
  const pz = await ask(client, 'runtime_pause')
  pin('runtime_pause parks the game and names the mode: step', pz.ok && pz.result['mode'] === 'step' && pz.result['paused'] === true)
  const c4 = await counters(client)
  await sleep(500)
  const c5 = await counters(client)
  pin('no frame runs while parked', n(c5, 'frames') === n(c4, 'frames'), `${n(c4, 'frames')} → ${n(c5, 'frames')}`)
  pin('no physics tick runs while parked', n(c5, 'physics_frames') === n(c4, 'physics_frames'), `${n(c4, 'physics_frames')} → ${n(c5, 'physics_frames')}`)
  const s30 = await ask(client, 'runtime_step', { frames: 30 })
  const c6 = await counters(client)
  pin('runtime_step {frames: 30} answers 30 frames run, still parked', s30.ok && s30.result['frames'] === 30 && s30.result['complete'] === true && s30.result['mode'] === 'step' && s30.result['paused'] === true)
  pin('the game advanced EXACTLY 30 frames', n(c6, 'frames') === n(c5, 'frames') + 30, `${n(c5, 'frames')} → ${n(c6, 'frames')}`)
  pin('the answer carries the errors/log since and the physics ticks', s30.ok && Array.isArray(s30.result['errors']) && Array.isArray(s30.result['log']) && typeof s30.result['physics_frames'] === 'number')
  const q1 = await ask(client, 'input_action', { action: 'left', pressed: true })
  pin('an input sent while parked is queued, the answer says so', q1.ok && q1.result['queued'] === true)
  const c7 = await counters(client)
  pin('nothing reaches the game before the step', n(c7, 'left_events') === 0 && n(c7, 'left_frames') === 0 && n(c7, 'frames') === n(c6, 'frames'))
  const s10 = await ask(client, 'runtime_step', { frames: 10 })
  const c8 = await counters(client)
  pin('the step delivered the queued press at the window start', s10.ok && s10.result['delivered'] === 1 && s10.result['frames'] === 10)
  pin('the callback heard the queued press', n(c8, 'left_events') === 1, `got ${n(c8, 'left_events')}`)
  pin('the press was held for the whole window: 10 frames of walking', n(c8, 'left_frames') === 10, `got ${n(c8, 'left_frames')}`)
  pin('exactly 10 frames ran', n(c8, 'frames') === n(c7, 'frames') + 10)
  await ask(client, 'input_action', { action: 'left', pressed: false })
  await ask(client, 'runtime_step', { frames: 5 })
  const c9 = await counters(client)
  pin('the queued release landed first: no further walking in the next window', n(c9, 'left_release_events') === 1 && n(c9, 'left_frames') === 10 && n(c9, 'frames') === n(c8, 'frames') + 5, `releases=${n(c9, 'left_release_events')} left_frames=${n(c9, 'left_frames')}`)
  const sms = await ask(client, 'runtime_step', { ms: 100 })
  const c10 = await counters(client)
  pin('runtime_step {ms: 100} runs at least 100 ms of game time and reports its frames', sms.ok && typeof sms.result['frames'] === 'number' && (sms.result['frames'] as number) >= 1 && (sms.result['elapsed_ms'] as number) >= 100)
  pin('the frame counter agrees with the answer', sms.ok && n(c10, 'frames') === n(c9, 'frames') + (sms.result['frames'] as number), `${n(c9, 'frames')} → ${n(c10, 'frames')}`)
  const bad0 = await ask(client, 'runtime_step', { frames: 0 })
  pin('frames: 0 is refused with a teaching error', !bad0.ok && bad0.error.code === 'BAD_ARG')
  const bad2 = await ask(client, 'runtime_step', { frames: 5, ms: 100 })
  pin('frames AND ms together are refused', !bad2.ok && bad2.error.code === 'BAD_ARG')
  const rs = await ask(client, 'runtime_resume')
  pin('runtime_resume names the mode: live', rs.ok && rs.result['mode'] === 'live' && rs.result['paused'] === false)
  await sleep(300)
  const c11 = await counters(client)
  pin('the game runs live again', n(c11, 'frames') > n(c10, 'frames'))
  const st1 = await ask(client, 'runtime_status')
  pin('runtime_status after resume: live', st1.ok && st1.result['mode'] === 'live')
  const s3 = await ask(client, 'runtime_step', { frames: 3 })
  pin('a runtime_step from a live game arms step mode', s3.ok && s3.result['mode'] === 'step' && s3.result['frames'] === 3 && s3.result['paused'] === true)
  const st2 = await ask(client, 'runtime_status')
  const c12 = await counters(client)
  await sleep(300)
  const c13 = await counters(client)
  pin('runtime_status names step mode; the game is parked again', st2.ok && st2.result['mode'] === 'step' && n(c13, 'frames') === n(c12, 'frames'))

  console.log('\n§3 one call per act: the macro sequence with step_frames')
  const macro = await ask(client, 'input_sequence', {
    steps: [
      { action: 'left', pressed: true, step_frames: 30 },
      { action: 'left', pressed: false },
      { action: 'jump', step_frames: 10 },
    ],
  }, 60_000)
  const c14 = await counters(client)
  pin('the macro answers 3 steps and 40 frames', macro.ok && macro.result['steps'] === 3 && macro.result['frames'] === 40, macro.ok ? JSON.stringify(macro.result) : '')
  pin('the game advanced exactly 40 frames in ONE call', n(c14, 'frames') === n(c13, 'frames') + 40, `${n(c13, 'frames')} → ${n(c14, 'frames')}`)
  pin('the walk maths: 30 frames of left', n(c14, 'left_frames') === n(c13, 'left_frames') + 30, `${n(c13, 'left_frames')} → ${n(c14, 'left_frames')}`)
  pin('the attack landed as a tap the callbacks heard', n(c14, 'jump_events') === n(c13, 'jump_events') + 1 && n(c14, 'jump_release_events') === n(c13, 'jump_release_events') + 1)
  pin('the attack read as just-pressed once in the polled state', n(c14, 'jump_just_pressed_frames') === n(c13, 'jump_just_pressed_frames') + 1, `${n(c13, 'jump_just_pressed_frames')} → ${n(c14, 'jump_just_pressed_frames')}`)
  const seqLive = await ask(client, 'runtime_resume')
  pin('resume after the macro', seqLive.ok)
  await expectOk(client, 'scene_stop')
  console.log(`\ngame leg: ${gameFailures === 0 ? '✅ PASS' : `❌ ${gameFailures} FAILURES`}`)
  if (gameFailures > 0) process.exit(1)
}

const token = ensureVulcanToken(proj)
const client = new VulcanClient({ port: vulcanPort(), token })
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
if (mode === 'game') {
  await gameLeg(client, proj)
  client.close()
  console.log('game leg complete')
  process.exit(0)
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
  await client.request('scene_stop', undefined, 10_000)
  process.exit(1)
}
await expectOk(client, 'runtime_tree')
await expectOk(client, 'scene_stop')
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
