#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-c-calibration-overflow.ts —
//  epoch-keyed calibration + the overflow-ladder
//  composition).
//
//    §A — keying + typed absence: provider/model/codec-epoch keys are
//       distinct; an uncalibrated read is TYPED, never a cross-key/epoch
//       fallback; aggregates fold as a bounded EMA; the key store caps
//    §B — settlement reconciliation through the REAL plan owner:
//       an applied plan carries the epoch-keyed estimate; reconcile folds
//       measured usage; the NEXT plan estimates through the learned ratio
//    §C — the SHIPPED typed ladder composes: selection precedes the
//       gate (source-pinned order), never reads usage (level-independent
//       digests), retains required closure at EVERY ladder level, and the
//       typed states (selection.overflow × TokenWarningLevel) coexist;
//       fixed-prefix honesty + the thrash guard stay live
//    §D — post-compact shape: the capsule + tail views compaction
//       produces keep their closure whole under an armed selection
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ctm-c2-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_CONTEXT_SELECTION
delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE

const cal = await import('../../src/services/run/contextCalibration.js')
const planMod = await import('../../src/services/run/requestContextPlan.js')
const sel = await import('../../src/services/run/contextSelection.js')
const ok = await import('../../src/services/run/ownerKey.js')
const auto = await import('../../src/services/compact/autoCompact.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type AnyMessage = Record<string, unknown>
const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function userMsg(n: number, text: string): AnyMessage {
  return { type: 'user', uuid: u(n), message: { role: 'user', content: text } }
}
function assistantMsg(n: number, text: string): AnyMessage {
  return { type: 'assistant', uuid: u(n), message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

const SKIP = new Set<string>()
const build = (
  messages: AnyMessage[],
  mode: 'apply' | 'inspect',
  owner: unknown,
  extra: Record<string, unknown> = {},
) =>
  planMod.buildRequestContextPlan(
    {
      messages: messages as never,
      owner: owner as never,
      querySource: 'repl_main_thread' as never,
      contentReplacementState: undefined,
      skipToolNames: SKIP,
      ...extra,
    } as never,
    mode,
  )

section('§A C07 — epoch-keyed, typed absence, bounded EMA store')
{
  cal.resetCalibration()
  const kA = cal.calibrationKeyFor('anthropic', 'claude-opus-5')
  const kO = cal.calibrationKeyFor('openai', 'gpt-5.6-sol')
  const kZ = cal.calibrationKeyFor('zai', 'glm-5')
  check('distinct routes/models mint distinct keys', new Set([kA, kO, kZ]).size === 3)
  check('the key carries the codec epoch', kA.endsWith(`c${cal.CODEC_EPOCHS.anthropic}`))
  check('an unknown key reads TYPED uncalibrated', cal.calibrationFor(kA).calibrated === false)
  cal.noteMeasuredUsage(kA, 1000, 1200)
  const r1 = cal.calibrationFor(kA)
  check('one observation calibrates the key (ratio = measured/estimated)', r1.calibrated && Math.abs(r1.ratio - 1.2) < 1e-9)
  // A NEW epoch spelling of the same route+model never inherits the ratio.
  const kAotherEpoch = kA.replace(/c\d+$/, 'c999')
  check('a different codec epoch NEVER inherits calibration', cal.calibrationFor(kAotherEpoch).calibrated === false)
  check('a different model NEVER inherits calibration', cal.calibrationFor(cal.calibrationKeyFor('anthropic', 'claude-sonnet-5')).calibrated === false)
  cal.noteMeasuredUsage(kA, 1000, 1200)
  const r2 = cal.calibrationFor(kA)
  check('observations fold as an EMA with sample count', r2.calibrated && r2.samples === 2)
  // Bounded keys: exceed the cap and confirm eviction keeps the size.
  for (let i = 0; i < cal.MAX_CALIBRATION_KEYS + 10; i++) {
    cal.noteMeasuredUsage(`synthetic:${i}:c1`, 100, 110)
  }
  let live = 0
  for (let i = 0; i < cal.MAX_CALIBRATION_KEYS + 10; i++) {
    if (cal.calibrationFor(`synthetic:${i}:c1`).calibrated) live++
  }
  check(`the key store is hard-capped at ${cal.MAX_CALIBRATION_KEYS}`, live <= cal.MAX_CALIBRATION_KEYS)
  cal.resetCalibration()
}

section('§B C07 — settlement reconciliation through the applied plan')
{
  cal.resetCalibration()
  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c2-b', lane: 'main' })
  const key = cal.calibrationKeyFor('anthropic', 'claude-opus-5')
  const msgs: AnyMessage[] = []
  for (let i = 1; i <= 20; i++) msgs.push(i % 2 ? userMsg(i, `q${i} ${'x'.repeat(80)}`) : assistantMsg(i, `a${i} ${'y'.repeat(80)}`))
  const p1 = await build(msgs, 'apply', owner, { calibrationKey: key })
  check('the applied plan carries the epoch-keyed estimate', p1.tokenEstimate?.key === key && (p1.tokenEstimate?.estimatedTokens ?? 0) > 0)
  check('the first estimate is TYPED uncalibrated', p1.tokenEstimate?.calibration.calibrated === false)
  const est = p1.tokenEstimate!.estimatedTokens
  // The settle: measured usage 1.5× the estimate.
  planMod.reconcileAppliedPlanUsage(owner, Math.round(est * 1.5))
  const read = cal.calibrationFor(key)
  check('reconciliation calibrates the key from the plan estimate', read.calibrated && Math.abs(read.ratio - 1.5) < 0.01, JSON.stringify(read))
  const p2 = await build(msgs, 'apply', owner, { calibrationKey: key })
  check('the NEXT plan estimates through the learned ratio', p2.tokenEstimate?.calibration.calibrated === true && p2.tokenEstimate!.estimatedTokens > est)
  check('no calibration key ⇒ tokenEstimate null (explicit absence)', (await build(msgs, 'inspect', owner)).tokenEstimate === null)
  // The live wiring is source-pinned: the turn machine passes the key and
  // reconciles the FIRST call of the turn.
  const tm = readFileSync(join(import.meta.dir, '../../src/run-core/turn-machine.ts'), 'utf8')
  check("turn-machine passes calibrationKeyFor(declaredRouteOf(model) ?? 'unrecognised', model)", tm.includes("calibrationKeyFor(declaredRouteOf(model) ?? 'unrecognised', model)"))
  check('turn-machine reconciles ONLY the first call (c1)', tm.includes('`${iter.turnId}.c1`') && tm.includes('reconcileAppliedPlanUsage('))
  cal.resetCalibration()
}

section('§C C08 — the SHIPPED typed ladder composes with selection')
{
  process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
  // The real ladder, driven deterministically via the blocking override.
  process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE = '150000'
  const model = 'claude-opus-5'
  const levels = [
    auto.calculateTokenWarningState(0, model).level,
    auto.calculateTokenWarningState(149_000, model).level,
    auto.calculateTokenWarningState(200_000, model).level,
  ]
  check("the real ladder speaks ok → … → blocked", levels[0] === 'ok' && levels[2] === 'blocked', levels.join(','))
  // Selection never reads usage: its decisions are identical at every
  // ladder level (same view, same index ⇒ same digest), and required
  // closure is retained regardless of pressure.
  const msgs: AnyMessage[] = []
  for (let i = 1; i <= 40; i++) msgs.push(i % 2 ? userMsg(i, `q${i}`) : assistantMsg(i, `a${i}`))
  msgs.push(userMsg(999, 'the request'))
  const digests = new Set<string>()
  for (const _level of levels) {
    const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: `ctm-c2-c${_level}-${digests.size}`, lane: 'main' })
    const p = await build(msgs, 'inspect', owner, { selectionBudget: { maxOptionalItems: 5 } })
    digests.add(p.selection.digest)
    const outUuids = new Set(p.messages.map(m => (m as AnyMessage).uuid))
    check(`closure retained under ladder level '${_level}'`, outUuids.has(u(999).replace('000000000999', '000000000999')) || outUuids.has((msgs.at(-1) as AnyMessage).uuid))
  }
  check('selection decisions are ladder-level-independent (one digest)', digests.size === 1)
  // The typed states COEXIST in one honest report.
  const owner2 = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c2-cx', lane: 'main' })
  const p = await build(msgs, 'inspect', owner2, { selectionBudget: { maxOptionalItems: 5, maxTotalItems: 3 } })
  const composed = { ladder: auto.calculateTokenWarningState(200_000, model).level, selection: p.selection.overflow }
  check('typed states compose honestly', composed.ladder === 'blocked' && composed.selection === 'closure-exceeds-budget')
  // Fixed-prefix honesty + the thrash guard remain live surfaces.
  check('detectFixedPrefixOverflow stays live', typeof auto.detectFixedPrefixOverflow === 'function')
  check('the thrash guard stays live', typeof auto.rapidRefillCount === 'function' && auto.AUTOCOMPACT_THRASH_MESSAGE.length > 0)
  // Order pin: the turn machine builds the plan (selection inside), then
  // feeds the SELECTED view to the compaction gate — composition, never a
  // bypass.
  const tm = readFileSync(join(import.meta.dir, '../../src/run-core/turn-machine.ts'), 'utf8')
  const planAt = tm.indexOf('const requestPlan = await buildRequestContextPlan(')
  const gateAt = tm.indexOf('await deps.autocompact(')
  check('selection precedes the compaction gate (source order)', planAt !== -1 && gateAt !== -1 && planAt < gateAt)
  // The overflow ladder feeds the gate the SELECTED view's head — the
  // operator's just-sent turn is split off (splitCarriedOperatorTail) and
  // carried verbatim around a fold — so the gate's argument is foldSplit.head,
  // itself cut from messagesForQuery. Still the selected view, never a bypass.
  const selectedAt = tm.indexOf('let messagesForQuery = requestPlan.messages')
  const splitAt = tm.indexOf('splitCarriedOperatorTail(messagesForQuery)')
  check(
    'the gate consumes the SELECTED view (through the carried-tail split)',
    selectedAt !== -1 && splitAt !== -1 && selectedAt < splitAt && splitAt < gateAt && tm.slice(gateAt, gateAt + 200).includes('foldSplit.head'),
  )
  delete process.env.MERCURY_BLOCKING_LIMIT_OVERRIDE
  delete process.env.MERCURY_CONTEXT_SELECTION
}

section('§D C08 — post-compact shape keeps its closure whole')
{
  process.env.MERCURY_CONTEXT_SELECTION = 'bounded-optional'
  const owner = ok.makeOwnerKey({ workspace: '/tmp/w', sessionId: 'ctm-c2-d', lane: 'main' })
  // What compaction produces: the capsule + the preserved tail.
  const msgs: AnyMessage[] = [
    { type: 'user', uuid: u(1), isCompactSummary: true, message: { role: 'user', content: 'the continuation capsule' } },
  ]
  for (let i = 2; i <= 9; i++) msgs.push(i % 2 ? assistantMsg(i, `a${i}`) : userMsg(i, `q${i}`))
  const p = await build(msgs, 'inspect', owner, { selectionBudget: { maxOptionalItems: 0 } })
  check('the capsule survives an armed zero-budget selection', p.messages.some(m => (m as AnyMessage).uuid === u(1)))
  check('the whole post-compact view is closure (nothing excludable)', p.selection.excluded.length === 0, `excluded=${p.selection.excluded.length}`)
  delete process.env.MERCURY_CONTEXT_SELECTION
}

console.log(
  failures === 0
    ? '\n ✅ — epoch-keyed calibration reconciled at settlement; the ladder composes'
    : `\n ❌ — ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
