#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  VULCAN_OPS,
  VULCAN_OPTABLE_DIGEST,
  VULCAN_STEP_WALL_MS_PER_FRAME,
  vulcanOp,
  vulcanOpNames,
  vulcanCategories,
} from '../../src/integrations/vulcan-optable/optable.generated.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const OPTABLE_FIX = 'edit the op rows in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs to rebuild src/integrations/vulcan-optable/optable.generated.ts'
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
  'engine_run', 'engine_check', 'engine_capture', 'engine_profile', 'engine_node_call',
])

section('1. per-category counts — the 163-op contract')
const byCat = new Map<string, number>()
for (const op of VULCAN_OPS) byCat.set(op.category, (byCat.get(op.category) ?? 0) + 1)
for (const [cat, want] of Object.entries(CONTRACT)) {
  check(`${cat}: ${want} ops`, byCat.get(cat) === want, `got ${byCat.get(cat) ?? 0}`, OPTABLE_FIX)
}
const contractTotal = VULCAN_OPS.filter(o => o.category !== 'frontier').length
check('contract total is 163', contractTotal === 163, `got ${contractTotal}`, OPTABLE_FIX)
check(
  'no undeclared categories',
  [...byCat.keys()].every(c => c === 'frontier' || c in CONTRACT),
  [...byCat.keys()].filter(c => c !== 'frontier' && !(c in CONTRACT)).join(','),
  'a category in assets/vulcan/optable.json is not in CONTRACT of this script; move the op into a declared category or declare the new one here',
)
check('frontier ops remain outside the lite core and carry explicit classes', VULCAN_OPS.filter(o => o.category === 'frontier').every(o => !o.lite && ['read', 'mutate', 'exec'].includes(o.cls)), '', 'a frontier op in assets/vulcan/optable.json is lite or has no read, mutate or exec class; fix that op row, then run node scripts/vulcan/regen-optable.mjs')
check('runtime queries and project leases have their reviewed classes and Mercury-side dispatch', [
  ['engine_scene_tree', 'read'], ['engine_node_get', 'read'], ['engine_node_call', 'exec'], ['engine_signal_wait', 'read'],
  ['lease_take', 'mutate'], ['lease_release', 'mutate'], ['lease_list', 'read'],
].every(([name, cls]) => vulcanOp(name)?.cls === cls && vulcanOp(name)?.side === 'mercury' && vulcanOp(name)?.category === 'frontier'), '', OPTABLE_FIX)
check('the engine job service rides the frontier: engine_run/engine_check exec, engine_jobs/engine_result read, engine_cancel mutate',
  vulcanOp('engine_run')?.cls === 'exec' && vulcanOp('engine_check')?.cls === 'exec' && vulcanOp('engine_jobs')?.cls === 'read' && vulcanOp('engine_result')?.cls === 'read' && vulcanOp('engine_cancel')?.cls === 'mutate' &&
    ['engine_run', 'engine_check', 'engine_jobs', 'engine_cancel', 'engine_result'].every(n => vulcanOp(n)?.category === 'frontier' && vulcanOp(n)?.lite === false), '', OPTABLE_FIX)

check('capture and profile execute on Mercury; frame images mutate only Mercury files',
  vulcanOp('engine_capture')?.cls === 'exec' && vulcanOp('engine_profile')?.cls === 'exec' && vulcanOp('engine_frames')?.cls === 'mutate' &&
    ['engine_capture', 'engine_profile', 'engine_frames'].every(n => vulcanOp(n)?.side === 'mercury' && vulcanOp(n)?.category === 'frontier' && vulcanOp(n)?.lite === false), '', OPTABLE_FIX)
check('the editor health snapshot is the frontier read op editor_health, answered on the editor side',
  vulcanOp('editor_health')?.cls === 'read' && vulcanOp('editor_health')?.side === 'editor' && vulcanOp('editor_health')?.category === 'frontier' && vulcanOp('editor_health')?.lite === false && /^Editor health snapshot/.test(vulcanOp('editor_health')?.summary ?? ''),
  JSON.stringify(vulcanOp('editor_health') ?? null), OPTABLE_FIX)

section('2. the lite subset')
const lite = VULCAN_OPS.filter(o => o.lite)
check('lite is exactly 76 ops', lite.length === 76, `got ${lite.length}`, 'change the lite flags of op rows in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')
check('lite ⊆ the 163 (frontier never lite)', lite.every(o => o.category !== 'frontier'), '', 'a frontier op row in assets/vulcan/optable.json has lite set; clear it, then run node scripts/vulcan/regen-optable.mjs')
check('vulcanOpNames({lite:true}) agrees', vulcanOpNames({ lite: true }).length === 76, '', 'vulcanOpNames in src/integrations/vulcan-optable/optable.generated.ts disagrees with the lite flags; run node scripts/vulcan/regen-optable.mjs')

section('3. permission classes')
check('every op classified', VULCAN_OPS.every(o => ['read', 'mutate', 'exec'].includes(o.cls)), '', 'give every op row in assets/vulcan/optable.json a class of read, mutate or exec, then run node scripts/vulcan/regen-optable.mjs')
const execActual = new Set(VULCAN_OPS.filter(o => o.cls === 'exec').map(o => o.name))
const missingDecl = [...execActual].filter(n => !EXEC_OPS.has(n))
const missingActual = [...EXEC_OPS].filter(n => !execActual.has(n))
check('exec set === the declared ask-always list', missingDecl.length === 0 && missingActual.length === 0,
  `undeclared: ${missingDecl.join(',') || '—'}; stale: ${missingActual.join(',') || '—'}`, 'make the exec ops in assets/vulcan/optable.json and EXEC_OPS in this script list the same names: add undeclared names to EXEC_OPS, drop stale ones from it')
check('reads never lite-excluded arbitrarily: all analysis/profiling reads are lite',
  VULCAN_OPS.filter(o => (o.category === 'analysis' || o.category === 'profiling') && o.cls === 'read').every(o => o.lite), '', 'set lite on the analysis and profiling read ops in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')

section('4. names + drift')
const names = VULCAN_OPS.map(o => o.name)
check('unique names', new Set(names).size === names.length, '', 'two op rows in assets/vulcan/optable.json share a name; rename or remove one, then run node scripts/vulcan/regen-optable.mjs')
check('vulcanOp resolves', vulcanOp('node_add')?.cls === 'mutate' && vulcanOp('nope') === undefined, '', 'vulcanOp in src/integrations/vulcan-optable/optable.generated.ts must find node_add as a mutate op and return undefined for an unknown name; run node scripts/vulcan/regen-optable.mjs')
check('categories helper', vulcanCategories().length === Object.keys(CONTRACT).length + 1, '', 'vulcanCategories in src/integrations/vulcan-optable/optable.generated.ts must list the CONTRACT categories of this script plus frontier; fix the categories in assets/vulcan/optable.json')
const rawJson = readFileSync(join(repo, 'assets', 'vulcan', 'optable.json'), 'utf8')
const digest = createHash('sha256').update(rawJson).digest('hex')
check('digest matches the json', digest === VULCAN_OPTABLE_DIGEST, '', 'assets/vulcan/optable.json changed after src/integrations/vulcan-optable/optable.generated.ts was built; run node scripts/vulcan/regen-optable.mjs')
let checkOk = true
try {
  execFileSync('node', [join(repo, 'scripts', 'vulcan', 'regen-optable.mjs'), '--check'], { stdio: 'pipe' })
} catch {
  checkOk = false
}
check('regen --check clean', checkOk, '', 'run node scripts/vulcan/regen-optable.mjs to rewrite src/integrations/vulcan-optable/optable.generated.ts and assets/vulcan/addon/core/op_classes.gd from assets/vulcan/optable.json, and keep the results')

section('5. the game-driving verbs — a press is an event; step mode rides the frontier')
{
  check('input_action is documented as a real InputEventAction both roads see', /InputEventAction/.test(vulcanOp('input_action')?.summary ?? '') && /polled action state/.test(vulcanOp('input_action')?.summary ?? ''), '', 'fix the input_action summary in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')
  const step = vulcanOp('runtime_step')
  check('runtime_step: a frontier exec op taking frames or ms', step?.cls === 'exec' && step?.category === 'frontier' && /^optional/.test(step?.args.frames ?? '') && /^optional/.test(step?.args.ms ?? ''), JSON.stringify(step?.args), 'fix the runtime_step row in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')
  check('runtime_step names the exact frame window and the default physics tick', /exactly N process frames/.test(step?.summary ?? '') && /physics tick/.test(step?.summary ?? ''), '', 'fix the runtime_step summary in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')
  check('runtime_pause / runtime_resume: frontier exec ops, no args', ['runtime_pause', 'runtime_resume'].every(n => vulcanOp(n)?.cls === 'exec' && vulcanOp(n)?.category === 'frontier' && Object.keys(vulcanOp(n)?.args ?? { x: 1 }).length === 0), '', 'fix the runtime_pause and runtime_resume rows in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')
  check('runtime_pause says input queues for the next step', /queues for the next runtime_step/.test(vulcanOp('runtime_pause')?.summary ?? ''), '', 'fix the runtime_pause summary in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')
  check('the 163 contract is untouched by the step verbs (all three above it)', ['runtime_step', 'runtime_pause', 'runtime_resume'].every(n => vulcanOp(n)?.category === 'frontier'), '', 'move runtime_step, runtime_pause and runtime_resume to the frontier category in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')
  const seq = vulcanOp('input_sequence')
  check('input_sequence steps accept step_frames and step_ms', /step_frames/.test(seq?.args.steps ?? '') && /step_ms/.test(seq?.args.steps ?? ''), seq?.args.steps, 'fix the input_sequence steps argument text in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs')
  const jsonFigure = (JSON.parse(rawJson) as { step_wall_ms_per_frame?: unknown }).step_wall_ms_per_frame
  const gdFigure = Number(/^const STEP_WALL_MS_PER_FRAME := (\d+)$/m.exec(readFileSync(join(repo, 'assets', 'vulcan', 'addon', 'core', 'op_classes.gd'), 'utf8'))?.[1])
  check('the stepped-frame budget is ONE figure: optable.json = the TS constant = op_classes.gd', Number.isInteger(jsonFigure) && jsonFigure === VULCAN_STEP_WALL_MS_PER_FRAME && gdFigure === VULCAN_STEP_WALL_MS_PER_FRAME && VULCAN_STEP_WALL_MS_PER_FRAME >= 1, `json=${String(jsonFigure)} ts=${VULCAN_STEP_WALL_MS_PER_FRAME} gd=${gdFigure}`, 'set step_wall_ms_per_frame to one positive integer in assets/vulcan/optable.json, then run node scripts/vulcan/regen-optable.mjs to rewrite the TS constant and assets/vulcan/addon/core/op_classes.gd')
}

console.log('\n' + (failures === 0 ? '✅ vulcan optable proof PASS' : `❌ ${failures} FAILURES`))
process.exit(failures === 0 ? 0 : 1)
