#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-headless-one-shot-roster.ts — the scheduling tools
//  are gated OUT of a one-shot headless roster, and ONLY there.
//
//  The law: a one-shot `-p "prompt"` run (text input) never starts the
//  self-pacing scheduler — src/cli/print.ts starts it only under
//  `streamingInput` — so CronCreate/CronDelete/CronList + ScheduleWakeup are
//  an OFF surface there and must not be advertised (a model spends a call on a
//  fire that can never happen). Everywhere else they mount exactly as before:
//  interactive sessions, streaming-input SDK runs, and proofs (which never boot
//  the headless entry). The posture is an IN-PROCESS flag on the bootstrap
//  PostureOwner (never an env read ⇒ no flag-registry row), set by main.tsx
//  BEFORE the headless tool pool is assembled.
//
//    §1 the default posture (interactive / streaming / proofs) mounts all four
//    §2 the one-shot posture drops exactly those four — the rest byte-identical
//    §3 leaving the one-shot posture (streaming-input headless) restores them
// §4 the master kill switch still rules regardless (AMENDED:
//    the TOOLS' master kill is MERCURY_SATURN_DISABLE — the engine
//    re-home; the legacy print block died in R2a — §5 pins the sink)
//    §5 source pins: the stamp precedes the pool in main.tsx; the scheduler
//       start is streaming-gated in print.ts; the four gates read the posture
//
//  Run: ~/.bun/bin/bun run scripts/substrate/prove-headless-one-shot-roster.ts
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'one-shot-roster-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const ROOT = join(import.meta.dir, '..', '..')
const state = await import('../../src/bootstrap/state.ts')
const { cronToolsMountable, isSaturnSchedulingEnabled } = await import('../../src/tools/ScheduleCronTool/prompt.ts')
const { isScheduleWakeupEnabled } = await import('../../src/tools/ScheduleWakeupTool/prompt.ts')
const { getTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

const SCHEDULING = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']
const rosterNames = (): string[] =>
  getTools({ ...getEmptyToolPermissionContext(), mode: 'default' } as never)
    .map(t => t.name)
    .sort()

section('§1 the default posture mounts the scheduling tools (interactive · streaming · proofs)')
const defaultRoster = rosterNames()
{
  check('the one-shot flag defaults to false', state.getIsSessionOneShotHeadless() === false)
  check('the master gate is on (stamped build, no kill switch — SATURN gate, S6b)', isSaturnSchedulingEnabled() === true)
  check('cronToolsMountable() reads true', cronToolsMountable() === true)
  check('isScheduleWakeupEnabled() reads true', isScheduleWakeupEnabled() === true)
  check(
    'all four scheduling tools are in the roster',
    SCHEDULING.every(n => defaultRoster.includes(n)),
    SCHEDULING.filter(n => !defaultRoster.includes(n)).join(','),
  )
}

section('§2 the one-shot headless posture drops exactly those four')
{
  state.setHeadlessOneShot(true)
  check('the flag reads true once the headless entry stamps it', state.getIsSessionOneShotHeadless() === true)
  check('cronToolsMountable() reads false', cronToolsMountable() === false)
  check('isScheduleWakeupEnabled() reads false', isScheduleWakeupEnabled() === false)
  const oneShot = rosterNames()
  check('none of the four scheduling tools is in the roster', SCHEDULING.every(n => !oneShot.includes(n)), oneShot.filter(n => SCHEDULING.includes(n)).join(','))
  const expected = defaultRoster.filter(n => !SCHEDULING.includes(n))
  check(
    'the rest of the roster is byte-identical (only the four left)',
    JSON.stringify(oneShot) === JSON.stringify(expected),
    `missing=[${expected.filter(n => !oneShot.includes(n)).join(',')}] extra=[${oneShot.filter(n => !expected.includes(n)).join(',')}]`,
  )
  check('Bash is still there (a sanity floor)', oneShot.includes('Bash'))
}

section('§3 leaving the one-shot posture (a streaming-input headless run) restores them')
{
  state.setHeadlessOneShot(false)
  check('cronToolsMountable() reads true again', cronToolsMountable() === true)
  check('isScheduleWakeupEnabled() reads true again', isScheduleWakeupEnabled() === true)
  check('the roster is byte-identical to §1', JSON.stringify(rosterNames()) === JSON.stringify(defaultRoster))
}

section('§4 the master kill switch still rules in every posture')
{
  process.env.MERCURY_SATURN_DISABLE = '1'
  check('MERCURY_SATURN_DISABLE=1 ⇒ not mountable in the default posture', cronToolsMountable() === false && isScheduleWakeupEnabled() === false)
  state.setHeadlessOneShot(true)
  check('MERCURY_SATURN_DISABLE=1 ⇒ not mountable in the one-shot posture either', cronToolsMountable() === false)
  state.setHeadlessOneShot(false)
  delete process.env.MERCURY_SATURN_DISABLE
  check('kill switch cleared ⇒ mountable again', cronToolsMountable() === true)
}

section('§5 source pins — the stamp precedes the pool; the scheduler start is streaming-gated')
{
  const main = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
  const stampAt = main.indexOf("setHeadlessOneShot(args.inputFormat !== 'stream-json')")
  const poolAt = main.indexOf('let tools = [...getTools(args.toolPermissionContext)]')
  check('main.tsx stamps the one-shot posture from the input format', stampAt >= 0)
  check('…BEFORE the headless tool pool is assembled', stampAt >= 0 && poolAt > stampAt, `stamp@${stampAt} pool@${poolAt}`)
  const print = readFileSync(join(ROOT, 'src', 'cli', 'print.ts'), 'utf8')
  // AMENDED: the legacy in-process engine left the
  // runner — the streaming-only law now lives on the LOCAL-WAKE SINK (the
  // seatless self-pacing arm registers only under streaming input).
  check(
    'print.ts arms the local-wake sink only for streaming input (the OFF-surface evidence)',
    /if \(streamingInput\) \{\s*\n\s*registerLocalWakeSink/.test(print),
  )
  const posture = readFileSync(join(ROOT, 'src', 'bootstrap', 'runtime', 'posture.ts'), 'utf8')
  check('the posture is an in-process PostureOwner field (no env read ⇒ no flag-registry row)', /headlessOneShot = false/.test(posture))
  const cronPrompt = readFileSync(join(ROOT, 'src', 'tools', 'ScheduleCronTool', 'prompt.ts'), 'utf8')
  check('cronToolsMountable reads the bootstrap posture', /getIsSessionOneShotHeadless\(\)/.test(cronPrompt))
  for (const file of ['CronCreateTool', 'CronDeleteTool', 'CronListTool']) {
    const src = readFileSync(join(ROOT, 'src', 'tools', 'ScheduleCronTool', `${file}.ts`), 'utf8')
    check(`${file}.isEnabled reads cronToolsMountable`, /isEnabled: \(\) => cronToolsMountable\(\)/.test(src))
  }
  const wakeup = readFileSync(join(ROOT, 'src', 'tools', 'ScheduleWakeupTool', 'prompt.ts'), 'utf8')
  check('ScheduleWakeup shares the same gate', /return cronToolsMountable\(\)/.test(wakeup))
}

console.log(`\n${failures === 0 ? '✅ ALL ONE-SHOT ROSTER PROOFS PASS' : `❌ ${failures} ONE-SHOT ROSTER PROOF(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
