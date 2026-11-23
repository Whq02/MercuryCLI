#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

for (const key of [
  'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_LOCAL_PROBE_TARGETS', 'MERCURY_MODEL',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-preempt-reuse-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const compact = await import('../../src/engine/compaction/autoFold.ts')
const tokens = await import('../../src/engine/context-window/contextTokenCount.ts')

const MODEL = 'claude-sonnet-5'

function transcriptAt(n: number): unknown[] {
  return [
    { type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hi' } },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: new Date().toISOString(),
      message: {
        id: 'resp-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      },
    },
  ]
}

section('R1 · the surfaced count IS the canonical count (level parity incl. blocked)')
{
  const window = compact.getEffectiveContextWindowSize(MODEL)
  for (const [label, n] of [
    ['mid-window', Math.floor(window / 2)],
    ['one under the window', window - 1],
    ['over the window (blocked)', window + 1],
  ] as const) {
    const messages = transcriptAt(n)
    let surfaced: number | null = null
    await compact.shouldAutoCompact(messages as never, MODEL, undefined, 0, raw => {
      surfaced = raw
    })
    const direct = tokens.tokenCountWithEstimation(messages as never)
    check(`${label}: surfaced === tokenCountWithEstimation (${direct})`, surfaced === direct, `surfaced=${surfaced} direct=${direct} — shouldAutoCompact in src/engine/compaction/autoFold.ts must pass onMeasured the same count tokenCountWithEstimation gives (plus snipTokensFreed)`)
    if (surfaced !== null) {
      const fromSurfaced = compact.calculateTokenWarningState(surfaced, MODEL).level
      const fromRecount = compact.calculateTokenWarningState(direct, MODEL).level
      check(`${label}: decision level identical from surfaced vs recount (${fromSurfaced})`, fromSurfaced === fromRecount, `${fromSurfaced} vs ${fromRecount} — the count shouldAutoCompact in src/engine/compaction/autoFold.ts hands to onMeasured must be the raw count, so calculateTokenWarningState reads the same level from it as from a recount`)
    }
  }
}

section('R2 · the early returns surface nothing')
{
  let called = 0
  await compact.shouldAutoCompact(transcriptAt(1000) as never, MODEL, 'compact', 0, () => {
    called++
  })
  await compact.shouldAutoCompact(transcriptAt(1000) as never, MODEL, 'session_memory', 0, () => {
    called++
  })
  check('forked sources (compact / session_memory) never call onMeasured', called === 0, `called=${called} — shouldAutoCompact in src/engine/compaction/autoFold.ts must return before onMeasured for the compact and session_memory sources`)
  process.env.MERCURY_AUTO_COMPACT = '0'
  await compact.shouldAutoCompact(transcriptAt(1000) as never, MODEL, undefined, 0, () => {
    called++
  })
  delete process.env.MERCURY_AUTO_COMPACT
  check('auto-compact off never calls onMeasured', called === 0, `called=${called} — shouldAutoCompact in src/engine/compaction/autoFold.ts must return before onMeasured when isAutoCompactEnabled is false (MERCURY_AUTO_COMPACT=0)`)
}

section('R3 · the wiring reads the carried count first (source pins on the fold gate; the preempt, called)')
{
  const t = await import('../core-runtime/turnScenarios.ts')
  const { makeRequest } = await import('../../src/engine/loop/turn/makeRequest.ts')
  const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
  const f = t.fixtures
  type Row = Record<string, unknown>
  const j = (value: unknown): string => JSON.stringify(value)
  const preempt = async (plan: Parameters<typeof t.plantRun>[0], state: Row = {}, realPrune = false) => {
    const planted = await t.plantRun(plan)
    Object.assign(planted.state, state)
    if (realPrune) planted.run.deps = { ...(planted.run.deps as Row), microcompact: undefined }
    const out = await t.drain(makeRequest(planted.run as never, planted.state as never, 1))
    planted.close()
    const iter = (out.decision as { iter?: Row }).iter
    const built = iter?.requestPlan as { gauge?: { tokens: number; rebase?: boolean }; reductions: { pressurePruned?: { tokensSaved: number } } } | undefined
    return { said: t.reasonOf(out.decision), events: out.events, iter, gauge: built?.gauge, saved: built?.reductions.pressurePruned?.tokensSaved ?? 0, folds: (planted.log as Row[]).filter(row => row.autocompact !== undefined) }
  }
  const under = (limit: number): Record<string, string> => ({ MERCURY_BLOCKING_LIMIT_OVERRIDE: String(limit) })
  const small = (): unknown[] => [f.ask('hello there rig')]
  const fat = (): unknown[] => [f.ask('hello there rig'), f.fat('previous fat turn', 5_000)]
  const sideQuestion = (seed: unknown[], answer: Row): Parameters<typeof t.plantRun>[0] => ({ env: under(100), querySource: 'side_question', seed, autocompact: [answer], script: [] })

  const carriedOver = await preempt(sideQuestion(small(), { wasCompacted: false, measuredRawTokenCount: 5_000 }))
  const carriedUnder = await preempt(sideQuestion(fat(), { wasCompacted: false, measuredRawTokenCount: 10 }))
  const recountedOver = await preempt(sideQuestion(fat(), { wasCompacted: false }))
  const recountedUnder = await preempt(sideQuestion(small(), { wasCompacted: false }))

  const FILE_BODY = 'a line of the file that was read over and over\n'.repeat(350)
  const readTwelveTimes = (): unknown[] => [
    f.ask('read the notes again and again'),
    ...Array.from({ length: 12 }, (_, i) => [f.calls(`read_${i + 1}`, 'Read', { file_path: '/rig/notes.txt' }), createUserMessage({ content: [{ type: 'tool_result', tool_use_id: `read_${i + 1}`, content: FILE_BODY }] as never })]).flat(),
    f.fat('every read is in.', 60_000),
    f.ask('hello there rig'),
  ]
  const pruneRung = { pendingOverflow: { signal: { source: 'estimate', family: 'anthropic', shape: 'prompt-too-long', actualTokens: 60_000, limitTokens: 100 }, rung: 'prune' }, overflowEpisode: { pruned: true, folded: true } }
  const pruning = (limit: number, model?: string): Parameters<typeof t.plantRun>[0] => ({ env: under(limit), querySource: 'side_question', tools: [{ name: 'Read' }], seed: readTwelveTimes(), ...(model !== undefined ? { model } : {}), script: [] })
  const NO_MODEL = ''

  const gauged = await preempt(pruning(10_000_000), pruneRung, true)
  const gaugedCount = gauged.gauge?.tokens ?? 0
  const gaugedBetween = await preempt(pruning(gaugedCount - Math.floor(gauged.saved / 2)), pruneRung, true)
  const gaugedAbove = await preempt(pruning(gaugedCount + 1), pruneRung, true)
  const unstamped = await preempt(pruning(10_000_000, NO_MODEL), pruneRung, true)
  const unstampedCount = unstamped.iter === undefined ? 0 : tokens.tokenCountWithEstimation(unstamped.iter.messagesForQuery as never, NO_MODEL)
  const unstampedBetween = await preempt(pruning(unstampedCount - Math.floor(unstamped.saved / 2), NO_MODEL), pruneRung, true)
  const nothingPruned = await preempt(pruning(unstampedCount - Math.floor(unstamped.saved / 2), NO_MODEL), pruneRung)
  const tracking = { compacted: false, turnId: 'rig-turn', turnCounter: 0, consecutiveFailures: 1 }
  const forced = await preempt({ seed: f.history(), autocompact: [f.folded()], script: [] }, { pendingOverflow: { signal: f.providerOverflow(), rung: 'fold' }, overflowEpisode: { pruned: false, folded: true }, autoCompactTracking: tracking })

  check(
    'the blocking preempt reuses the carried count, recounts only as fallback, and credits the prune receipt of this iteration against either (never below zero)',
    carriedOver.said === 'end blocking_limit' && carriedUnder.said === 'go_on' && recountedOver.said === 'end blocking_limit' && recountedUnder.said === 'go_on' && unstamped.saved > 0 && unstampedBetween.said === 'go_on' && nothingPruned.said === 'end blocking_limit',
    `limit 100 — a carried count of 5,000 over a one-line transcript: ${carriedOver.said} (end blocking_limit is right); a carried count of 10 over a transcript stamped 5,000: ${carriedUnder.said} (go_on); no carried count, the stamped transcript: ${recountedOver.said} (end blocking_limit); no carried count, one line: ${recountedUnder.said} (go_on); a prune that saved ${unstamped.saved} of ${unstampedCount} with the limit between the two: ${unstampedBetween.said} (go_on), the same limit with nothing pruned: ${nothingPruned.said} (end blocking_limit) — the blocking check of makeRequest in src/engine/loop/turn/makeRequest.ts judges by the count the fold gate measured when it carried one, recounts the view only when it carried none, and takes this turn's prune saving off`,
  )
  check(
    'a projected request gauge needs no prune subtraction; an unstamped view keeps the receipt credit',
    gauged.gauge !== undefined && gauged.gauge.rebase === true && gauged.saved > 0 && gaugedBetween.said === 'end blocking_limit' && gaugedAbove.said === 'go_on' && unstamped.said === 'go_on' && unstamped.gauge === undefined && unstampedBetween.said === 'go_on' &&
      forced.folds.length === 1 && forced.folds[0]?.source === 'sdk' && j(forced.folds[0]?.tracking) === j(tracking) && forced.folds[0]?.prunedTokensFreed === 0 && j(forced.folds[0]?.forced) === j(f.providerOverflow()),
    `a pruned view with a projected gauge of ${gaugedCount} (the prune saved ${gauged.saved}): limit ${gaugedCount - Math.floor(gauged.saved / 2)} ${gaugedBetween.said} (end blocking_limit is right: nothing is taken off a count made of the pruned view), limit ${gaugedCount + 1} ${gaugedAbove.said} (go_on); a view with no gauge counted ${unstampedCount} by its usage stamp: limit ${unstampedCount - Math.floor(unstamped.saved / 2)} ${unstampedBetween.said} (go_on: the saving is taken off); the fold gate was asked ${j(forced.folds.map(row => ({ source: row.source, tracking: row.tracking, prunedTokensFreed: row.prunedTokensFreed, forced: row.forced })))} (the source, the turn's tracking, a saving of 0, the overflow that forces it) — src/engine/loop/turn/makeRequest.ts`,
  )

  const landedUnder = await preempt(sideQuestion(fat(), { ...f.folded(50), measuredRawTokenCount: 5_000 }))
  const landedOver = await preempt(sideQuestion(fat(), f.folded(5_000)))
  const noTrueFigure = f.folded(50)
  ;(noTrueFigure.compactionResult as Row).truePostCompactTokenCount = undefined
  const landedUncounted = await preempt(sideQuestion(fat(), { ...noTrueFigure, measuredRawTokenCount: 5_000 }))
  const summariser = await preempt({ ...sideQuestion(fat(), { wasCompacted: false }), querySource: 'compact' })
  const sessionMemory = await preempt({ ...sideQuestion(fat(), { wasCompacted: false }), querySource: 'session_memory' })
  check(
    'the preempt stays gated on the just-compacted exemption (a compaction-changed view never reuses a stale number; the exemption holds only under the limit)',
    landedUnder.said === 'go_on' && landedUnder.events.some(event => event.kind === 'compaction_boundary') && landedOver.said === 'end blocking_limit' && landedUncounted.said === 'go_on' && summariser.said === 'go_on' && sessionMemory.said === 'go_on',
    `limit 100 — a fold that landed at 50 beside a carried count of 5,000 taken before it: ${landedUnder.said} (go_on is right); a fold that landed at 5,000: ${landedOver.said} (end blocking_limit); a fold with no true post figure beside the same carried count: ${landedUncounted.said} (go_on); the summariser's own request over the limit: ${summariser.said} (go_on); the session-memory request: ${sessionMemory.said} (go_on) — the blocking check of makeRequest in src/engine/loop/turn/makeRequest.ts`,
  )
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
