#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VULCAN_OPS,
  VULCAN_OPTABLE_DIGEST,
  vulcanOp,
  vulcanOpNames,
  vulcanCategories,
} from '../../src/utils/vulcan/optable.generated.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const repo = join(import.meta.dir, '..', '..')

const CONTRACT: Record<string, number> = {
  project: 7, scene: 9, node: 14, script: 8, editor: 9, input: 7, runtime: 19,
  animation: 6, animtree: 8, three_d: 6, physics: 6, particles: 5, navigation: 6,
  audio: 6, tilemap: 6, theme: 6, shader: 6, resource: 6, batch: 8, analysis: 4,
  testing: 6, profiling: 2, export: 3,
}

const EXEC_OPS = new Set([
  'scene_play', 'scene_stop', 'node_call_method', 'editor_execute_script',
  'input_key', 'input_mouse_button', 'input_mouse_move', 'input_action', 'input_sequence',
  'runtime_node_set', 'runtime_call', 'runtime_eval', 'runtime_click', 'runtime_navigate',
  'runtime_scene_change', 'runtime_record_start', 'runtime_record_stop', 'runtime_replay',
  'playtest_run',
  'animation_play', 'animtree_travel', 'particles_emit', 'nav_bake', 'audio_play',
  'test_run', 'test_assert', 'test_screenshot_baseline', 'test_screenshot_compare',
  'export_run', 'runtime_wait_signal',
  'project_refresh_classes',
  'runtime_pause', 'runtime_step', 'runtime_resume',
])

section('1. per-category counts — the 163-op contract')
const byCat = new Map<string, number>()
for (const op of VULCAN_OPS) byCat.set(op.category, (byCat.get(op.category) ?? 0) + 1)
for (const [cat, want] of Object.entries(CONTRACT)) {
  check(`${cat}: ${want} ops`, byCat.get(cat) === want, `got ${byCat.get(cat) ?? 0}`)
}
const contractTotal = VULCAN_OPS.filter(o => o.category !== 'frontier').length
check('contract total is 163', contractTotal === 163, `got ${contractTotal}`)
check(
  'no undeclared categories',
  [...byCat.keys()].every(c => c === 'frontier' || c in CONTRACT),
  [...byCat.keys()].filter(c => c !== 'frontier' && !(c in CONTRACT)).join(','),
)
check('frontier exists and is small', (byCat.get('frontier') ?? 0) >= 5 && (byCat.get('frontier') ?? 0) <= 20, `got ${byCat.get('frontier') ?? 0}`)

section('2. the lite subset')
const lite = VULCAN_OPS.filter(o => o.lite)
check('lite is exactly 76 ops', lite.length === 76, `got ${lite.length}`)
check('lite ⊆ the 163 (frontier never lite)', lite.every(o => o.category !== 'frontier'))
check('vulcanOpNames({lite:true}) agrees', vulcanOpNames({ lite: true }).length === 76)

section('3. permission classes')
check('every op classified', VULCAN_OPS.every(o => ['read', 'mutate', 'exec'].includes(o.cls)))
const execActual = new Set(VULCAN_OPS.filter(o => o.cls === 'exec').map(o => o.name))
const missingDecl = [...execActual].filter(n => !EXEC_OPS.has(n))
const missingActual = [...EXEC_OPS].filter(n => !execActual.has(n))
check('exec set === the declared ask-always list', missingDecl.length === 0 && missingActual.length === 0,
  `undeclared: ${missingDecl.join(',') || '—'}; stale: ${missingActual.join(',') || '—'}`)
check('reads never lite-excluded arbitrarily: all analysis/profiling reads are lite',
  VULCAN_OPS.filter(o => (o.category === 'analysis' || o.category === 'profiling') && o.cls === 'read').every(o => o.lite))

section('4. names + drift')
const names = VULCAN_OPS.map(o => o.name)
check('unique names', new Set(names).size === names.length)
check('vulcanOp resolves', vulcanOp('node_add')?.cls === 'mutate' && vulcanOp('nope') === undefined)
check('categories helper', vulcanCategories().length === Object.keys(CONTRACT).length + 1)
const rawJson = readFileSync(join(repo, 'assets', 'vulcan', 'optable.json'), 'utf8')
const digest = createHash('sha256').update(rawJson).digest('hex')
check('digest matches the json', digest === VULCAN_OPTABLE_DIGEST)
let checkOk = true
try {
  execFileSync('node', [join(repo, 'scripts', 'vulcan', 'regen-optable.mjs'), '--check'], { stdio: 'pipe' })
} catch {
  checkOk = false
}
check('regen --check clean', checkOk)

section('5. the game-driving verbs — a press is an event; step mode rides the frontier')
{
  check('input_action is documented as a real InputEventAction both roads see', /InputEventAction/.test(vulcanOp('input_action')?.summary ?? '') && /polled action state/.test(vulcanOp('input_action')?.summary ?? ''))
  const step = vulcanOp('runtime_step')
  check('runtime_step: a frontier exec op taking frames or ms', step?.cls === 'exec' && step?.category === 'frontier' && /^optional/.test(step?.args.frames ?? '') && /^optional/.test(step?.args.ms ?? ''), JSON.stringify(step?.args))
  check('runtime_step names the exact frame window and the default physics tick', /exactly N process frames/.test(step?.summary ?? '') && /physics tick/.test(step?.summary ?? ''))
  check('runtime_pause / runtime_resume: frontier exec ops, no args', ['runtime_pause', 'runtime_resume'].every(n => vulcanOp(n)?.cls === 'exec' && vulcanOp(n)?.category === 'frontier' && Object.keys(vulcanOp(n)?.args ?? { x: 1 }).length === 0))
  check('runtime_pause says input queues for the next step', /queues for the next runtime_step/.test(vulcanOp('runtime_pause')?.summary ?? ''))
  check('the 163 contract is untouched by the step verbs (all three above it)', ['runtime_step', 'runtime_pause', 'runtime_resume'].every(n => vulcanOp(n)?.category === 'frontier'))
  const seq = vulcanOp('input_sequence')
  check('input_sequence steps accept step_frames and step_ms', /step_frames/.test(seq?.args.steps ?? '') && /step_ms/.test(seq?.args.steps ?? ''), seq?.args.steps)
}

console.log('\n' + (failures === 0 ? '✅ vulcan optable proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
