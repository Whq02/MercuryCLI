#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'one-shot-roster-'))

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = detail && hint ? `${detail} — ${hint}` : detail || hint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const state = await import('../../src/boot/process-state/processState.ts')
const { cronToolsMountable, isSaturnSchedulingEnabled } = await import('../../src/tools/cron/prompt.ts')
const { isScheduleWakeupEnabled } = await import('../../src/tools/schedule-wakeup/prompt.ts')
const { getTools } = await import('../../src/tools/kit/toolList.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')

const SCHEDULING = ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup']
const cronGate = 'cronToolsMountable in src/tools/cron/prompt.ts'
const wakeGate = 'isScheduleWakeupEnabled in src/tools/schedule-wakeup/prompt.ts'
const oneShotFlag = 'setHeadlessOneShot and getIsSessionOneShotHeadless in src/boot/process-state/processState.ts'
const rosterFn = 'getTools in src/tools/kit/toolList.ts'
const rosterNames = (): string[] =>
  getTools({ ...getEmptyToolPermissionContext(), mode: 'default' } as never)
    .map(t => t.name)
    .sort()

section('§1 the default posture mounts the scheduling tools (interactive · streaming · proofs)')
const defaultRoster = rosterNames()
{
  check('the one-shot flag defaults to false', state.getIsSessionOneShotHeadless() === false, String(state.getIsSessionOneShotHeadless()), oneShotFlag + ' must start the flag false')
  check('the master gate is on (stamped build, no kill switch — SATURN gate, S6b)', isSaturnSchedulingEnabled() === true, String(isSaturnSchedulingEnabled()), 'isSaturnSchedulingEnabled in src/tools/cron/prompt.ts must read true with MERCURY_SATURN_DISABLE unset')
  check('cronToolsMountable() reads true', cronToolsMountable() === true, '', cronGate + ' must read true in the default posture')
  check('isScheduleWakeupEnabled() reads true', isScheduleWakeupEnabled() === true, '', wakeGate + ' must read true in the default posture')
  check(
    'all four scheduling tools are in the roster',
    SCHEDULING.every(n => defaultRoster.includes(n)),
    SCHEDULING.filter(n => !defaultRoster.includes(n)).join(',') + ' — missing from the roster; ' + rosterFn + ' must mount them in the default posture',
  )
}

section('§2 the one-shot headless posture drops exactly those four')
{
  state.setHeadlessOneShot(true)
  check('the flag reads true once the headless entry stamps it', state.getIsSessionOneShotHeadless() === true, String(state.getIsSessionOneShotHeadless()), oneShotFlag + ' must make setHeadlessOneShot(true) read back true')
  check('cronToolsMountable() reads false', cronToolsMountable() === false, '', cronGate + ' must read false while the one-shot flag is set')
  check('isScheduleWakeupEnabled() reads false', isScheduleWakeupEnabled() === false, '', wakeGate + ' must read false while the one-shot flag is set')
  const oneShot = rosterNames()
  check('none of the four scheduling tools is in the roster', SCHEDULING.every(n => !oneShot.includes(n)), oneShot.filter(n => SCHEDULING.includes(n)).join(',') + ' — still in the roster; ' + rosterFn + ' must drop them while the one-shot flag is set')
  const expected = defaultRoster.filter(n => !SCHEDULING.includes(n))
  check(
    'the rest of the roster is byte-identical (only the four left)',
    JSON.stringify(oneShot) === JSON.stringify(expected),
    `missing=[${expected.filter(n => !oneShot.includes(n)).join(',')}] extra=[${oneShot.filter(n => !expected.includes(n)).join(',')}] — ${rosterFn} must drop only the four scheduling tools in the one-shot posture`,
  )
  check('Bash is still there (a sanity floor)', oneShot.includes('Bash'), '', rosterFn + ' must keep Bash in the one-shot roster')
}

section('§3 leaving the one-shot posture (a streaming-input headless run) restores them')
{
  state.setHeadlessOneShot(false)
  check('cronToolsMountable() reads true again', cronToolsMountable() === true, '', cronGate + ' must read true again once the one-shot flag is cleared')
  check('isScheduleWakeupEnabled() reads true again', isScheduleWakeupEnabled() === true, '', wakeGate + ' must read true again once the one-shot flag is cleared')
  check('the roster is byte-identical to §1', JSON.stringify(rosterNames()) === JSON.stringify(defaultRoster), '', rosterFn + ' must return the full roster again once the one-shot flag is cleared')
}

section('§4 the master kill switch still rules in every posture')
{
  process.env.MERCURY_SATURN_DISABLE = '1'
  check('MERCURY_SATURN_DISABLE=1 ⇒ not mountable in the default posture', cronToolsMountable() === false && isScheduleWakeupEnabled() === false, '', cronGate + ' and ' + wakeGate + ' must both read false when MERCURY_SATURN_DISABLE=1')
  state.setHeadlessOneShot(true)
  check('MERCURY_SATURN_DISABLE=1 ⇒ not mountable in the one-shot posture either', cronToolsMountable() === false, '', cronGate + ' must keep reading false under MERCURY_SATURN_DISABLE=1 in the one-shot posture')
  state.setHeadlessOneShot(false)
  delete process.env.MERCURY_SATURN_DISABLE
  check('kill switch cleared ⇒ mountable again', cronToolsMountable() === true, '', cronGate + ' must read true again once MERCURY_SATURN_DISABLE is unset')
}


console.log(`\n${failures === 0 ? '✅ ALL ONE-SHOT ROSTER PROOFS PASS' : `❌ ${failures} ONE-SHOT ROSTER PROOF(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
