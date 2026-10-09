#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { collapseHookSummaries } = await import('../../src/utils/collapseHookSummaries.ts')
const { createStopHookSummaryMessage, createUserMessage } = await import('../../src/utils/messages.ts')
type Row = Parameters<typeof collapseHookSummaries>[0][number]
type Summary = ReturnType<typeof createStopHookSummaryMessage>

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const show = (value: unknown): string => JSON.stringify(value)

type Facts = {
  label?: string
  count?: number
  infos?: { command?: string; promptText?: string; durationMs?: number }[]
  errors?: string[]
  prevented?: boolean
  stopReason?: string
  hasOutput?: boolean
  level?: 'info' | 'warning' | 'error' | 'suggestion'
  toolUseID?: string
  wallClockMs?: number
}
const summary = (facts: Facts): Summary =>
  createStopHookSummaryMessage(
    facts.count ?? 1,
    facts.infos ?? [],
    facts.errors ?? [],
    facts.prevented ?? false,
    facts.stopReason,
    facts.hasOutput ?? false,
    facts.level ?? 'info',
    facts.toolUseID,
    facts.label,
    facts.wallClockMs,
  )
const user = (text: string): Row => createUserMessage({ content: text }) as unknown as Row
const fold = (rows: Row[]): Row[] => collapseHookSummaries(rows)
const asSummary = (row: Row | undefined): Summary => row as Summary
const sameRows = (a: Row[], b: Row[]): boolean => a.length === b.length && a.every((row, i) => row === b[i])

section('§1 rows that are not labelled summaries pass through, in order, as the same objects')
{
  check('an empty list folds to an empty list', fold([]).length === 0)
  const unlabelled = summary({ count: 2 })
  const rows: Row[] = [user('one'), unlabelled as Row, user('two')]
  const out = fold(rows)
  check('three ordinary rows come back as the same three objects in order', sameRows(out, rows), show(out.map(r => r.type)))
  check('an unlabelled hook summary is never folded', out[1] === unlabelled)
}

section('§2 a labelled summary on its own is the row itself')
{
  const alone = summary({ label: 'PostToolUse', count: 1, infos: [{ command: 'lint' }] })
  const out = fold([user('a'), alone as Row, user('b')])
  check('three rows stay three rows', out.length === 3, show(out.length))
  check('the lone summary is the same object reference', out[1] === alone)
}

section('§3 a run of one label becomes one row on the first row\'s identity with the tallies combined')
{
  const first = summary({
    label: 'PostToolUse', count: 1, infos: [{ command: 'lint', durationMs: 120 }], errors: [],
    prevented: false, stopReason: 'first says stop', hasOutput: false, level: 'suggestion', toolUseID: 'tu-1', wallClockMs: 300,
  })
  const second = summary({
    label: 'PostToolUse', count: 2, infos: [{ command: 'test', durationMs: 900 }, { promptText: 'review' }], errors: ['test exited 1'],
    prevented: true, stopReason: 'second says stop', hasOutput: true, level: 'error', toolUseID: 'tu-2', wallClockMs: 1200,
  })
  const third = summary({
    label: 'PostToolUse', count: 1, infos: [{ command: 'fmt' }], errors: ['fmt exited 2'],
    prevented: false, hasOutput: false, level: 'info', toolUseID: 'tu-3', wallClockMs: 50,
  })
  const out = fold([first as Row, second as Row, third as Row])
  const merged = asSummary(out[0])
  check('three summaries of one label fold into one row', out.length === 1, show(out.length))
  check('the folded row is a new object, not the first row mutated', merged !== first && first.hookCount === 1 && first.hookInfos.length === 1)
  check('the folded row keeps the first row\'s uuid', merged.uuid === first.uuid, show([merged.uuid, first.uuid]))
  check('the folded row keeps the first row\'s timestamp', merged.timestamp === first.timestamp)
  check('the folded row keeps the first row\'s level', merged.level === 'suggestion', show(merged.level))
  check('the folded row keeps the first row\'s stop reason', merged.stopReason === 'first says stop', show(merged.stopReason))
  check('the folded row keeps the first row\'s tool use id', merged.toolUseID === 'tu-1', show(merged.toolUseID))
  check('the folded row keeps the label', merged.hookLabel === 'PostToolUse', show(merged.hookLabel))
  check('the folded row stays a stop_hook_summary system row', merged.type === 'system' && merged.subtype === 'stop_hook_summary')
  check('hookCount is the sum', merged.hookCount === 4, show(merged.hookCount))
  check('hookInfos are concatenated in order', show(merged.hookInfos.map(i => i.command ?? i.promptText)) === show(['lint', 'test', 'review', 'fmt']), show(merged.hookInfos))
  check('hookErrors are concatenated in order', show(merged.hookErrors) === show(['test exited 1', 'fmt exited 2']), show(merged.hookErrors))
  check('preventedContinuation is true when any row prevented it', merged.preventedContinuation === true)
  check('hasOutput is true when any row had output', merged.hasOutput === true)
  check('the wall clock is the longest of the run, not the sum', merged.totalDurationMs === 1200, show(merged.totalDurationMs))
  check('the later rows\' identities are gone', !out.some(r => (r as Summary).uuid === second.uuid || (r as Summary).uuid === third.uuid))
}

section('§4 flags stay false when no row raised them; a run nobody timed reads a zero wall clock')
{
  const a = summary({ label: 'PreToolUse', count: 1, infos: [{ command: 'a', durationMs: 5 }] })
  const b = summary({ label: 'PreToolUse', count: 1, infos: [{ command: 'b', durationMs: 7 }] })
  const merged = asSummary(fold([a as Row, b as Row])[0])
  check('two quiet rows fold to one', merged !== a && merged.hookCount === 2, show(merged.hookCount))
  check('preventedContinuation stays false', merged.preventedContinuation === false)
  check('hasOutput stays false', merged.hasOutput === false)
  check('an untimed run reads 0', merged.totalDurationMs === 0, show(merged.totalDurationMs))
  const timed = asSummary(fold([summary({ label: 'PreToolUse', wallClockMs: 40 }) as Row, b as Row])[0])
  check('one timed row beside an untimed one reads the timed clock', timed.totalDurationMs === 40, show(timed.totalDurationMs))
}

section('§5 a label change ends the run; the next label begins its own')
{
  const a1 = summary({ label: 'A', count: 1 })
  const a2 = summary({ label: 'A', count: 2 })
  const b1 = summary({ label: 'B', count: 3 })
  const b2 = summary({ label: 'B', count: 4 })
  const a3 = summary({ label: 'A', count: 5 })
  const out = fold([a1 as Row, a2 as Row, b1 as Row, b2 as Row, a3 as Row])
  check('A A B B A folds to three rows', out.length === 3, show(out.length))
  check('the first row is the A run with count 3 on a1\'s uuid', asSummary(out[0]).hookCount === 3 && asSummary(out[0]).uuid === a1.uuid, show(out[0]))
  check('the second row is the B run with count 7 on b1\'s uuid', asSummary(out[1]).hookCount === 7 && asSummary(out[1]).uuid === b1.uuid, show(out[1]))
  check('the trailing lone A is the same object', out[2] === a3)
}

section('§6 any other row ends a run, and the rows keep their order')
{
  const a1 = summary({ label: 'A', count: 1 })
  const a2 = summary({ label: 'A', count: 1 })
  const plain = summary({ count: 9 })
  const a3 = summary({ label: 'A', count: 1 })
  const a4 = summary({ label: 'A', count: 1 })
  const between = user('between')
  const out = fold([user('lead'), a1 as Row, a2 as Row, plain as Row, a3 as Row, between, a4 as Row])
  check('seven rows fold to six', out.length === 6, show(out.length))
  check('the lead user row is first and untouched', out[0]?.type === 'user')
  check('the first A run folded to count 2', asSummary(out[1]).hookCount === 2 && asSummary(out[1]).uuid === a1.uuid)
  check('the unlabelled summary sits between the runs, the same object', out[2] === plain)
  check('an A beside the unlabelled summary is not folded across it', out[3] === a3)
  check('the user row keeps its place', out[4] === between)
  check('the last lone A is the same object', out[5] === a4)
}

section('§7 the input list is left as it was')
{
  const a1 = summary({ label: 'A', count: 1, infos: [{ command: 'x' }], errors: ['e1'] })
  const a2 = summary({ label: 'A', count: 1, infos: [{ command: 'y' }], errors: ['e2'] })
  const rows: Row[] = [a1 as Row, a2 as Row]
  const before = [...rows]
  const out = fold(rows)
  check('the input array keeps its length and its objects', sameRows(rows, before))
  check('the first row\'s own tallies are untouched', a1.hookCount === 1 && a1.hookInfos.length === 1 && a1.hookErrors.length === 1, show(a1))
  check('the folded row is not the input array\'s element', out[0] !== a1 && out[0] !== a2)
}

if (failures) {
  console.log(`\n❌ ${failures} hook-summary fold check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL HOOK-SUMMARY FOLD PROOFS PASS')
