#!/usr/bin/env bun
// ============================================================================
//  scripts/compact/prove-blocking-preempt-reuse.ts — the token count is
//  measured ONCE per unchanged request view.
//
//  The same transcript used to be counted twice per non-compacting
//  iteration (three times with the advance flag on): shouldAutoCompact
//  walked it for the compaction decision, the advance branch walked it
//  again, and the turn machine's blocking-limit preempt walked it a third
//  time for the SAME messages. The decision now surfaces its measured RAW
//  count and both other readers reuse it. The laws:
//
//   R1  the surfaced count IS the canonical count — the onMeasured callback
//       receives exactly tokenCountWithEstimation(messages), and the
//       decision-relevant level computed from the surfaced number equals
//       the level computed from a fresh recount (blocked included);
//   R2  the early returns surface NOTHING (forked sources, auto-compact
//       off): no count happened, so nothing may pretend to be one;
//   R3  the wiring (source pins, the pool-reset-prover idiom): the
//       no-compaction exit carries measuredRawTokenCount; the advance
//       branch and the turn machine's preempt read the carried count FIRST
//       and recount only as the fallback; the preempt stays gated on
//       !compactionResult so a compaction-changed view can never reuse a
//       stale number (the carried count is also only attached on the
//       no-compaction exit).
//
//  Run: ~/.bun/bin/bun run scripts/compact/prove-blocking-preempt-reuse.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
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
const ROOT = join(import.meta.dir, '..', '..')

for (const key of [
  'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_LOCAL_PROBE_TARGETS', 'ANTHROPIC_MODEL',
]) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-preempt-reuse-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const compact = await import('../../src/services/compact/autoCompact.ts')
const tokens = await import('../../src/utils/tokens.ts')

const MODEL = 'claude-sonnet-5'

/** A transcript whose canonical count is exactly `n`: one settled
 *  usage-bearing assistant row (the anchor) and nothing after it. */
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
    check(`${label}: surfaced === tokenCountWithEstimation (${direct})`, surfaced === direct, `surfaced=${surfaced} direct=${direct}`)
    if (surfaced !== null) {
      const fromSurfaced = compact.calculateTokenWarningState(surfaced, MODEL).level
      const fromRecount = compact.calculateTokenWarningState(direct, MODEL).level
      check(`${label}: decision level identical from surfaced vs recount (${fromSurfaced})`, fromSurfaced === fromRecount, `${fromSurfaced} vs ${fromRecount}`)
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
  check('forked sources (compact / session_memory) never call onMeasured', called === 0, `called=${called}`)
  process.env.DISABLE_AUTO_COMPACT = '1'
  await compact.shouldAutoCompact(transcriptAt(1000) as never, MODEL, undefined, 0, () => {
    called++
  })
  delete process.env.DISABLE_AUTO_COMPACT
  check('auto-compact off never calls onMeasured', called === 0, `called=${called}`)
}

section('R3 · the wiring reads the carried count first (source pins)')
{
  const auto = readFileSync(join(ROOT, 'src/services/compact/autoCompact.ts'), 'utf8')
  check(
    'the no-compaction exit carries the measured count',
    auto.includes('if (!compact) return { ...notCompacted, measuredRawTokenCount }'),
  )
  check(
    'the advance branch reuses the measured count and recounts only as fallback',
    auto.includes('(measuredRawTokenCount ?? tokenCountWithEstimation(messages)) - snipTokensFreed'),
  )
  const tm = readFileSync(join(ROOT, 'src/run-core/turn-machine.ts'), 'utf8')
  // The carried count is read FIRST and the recount is the fallback; the
  // number is bound once (estimatedTokens) because the overflow ladder's
  // estimate-side signal reads the same count the level was computed from.
  // An over-limit fold's own estimate leads (FN-015 rank 26); the carried
  // count follows; the recount is the fallback.
  check(
    'the blocking preempt reuses the carried count and recounts only as fallback',
    /const estimatedTokens =\s*compactionResult\?\.truePostCompactTokenCount \?\? measuredRawTokenCount \?\? tokenCountWithEstimation\(messagesForQuery\)[\s\S]{0,80}calculateTokenWarningState\(\s*estimatedTokens,/.test(tm),
  )
  check(
    'the preempt stays gated on the just-compacted exemption (a compaction-changed view never reuses a stale number; the exemption holds only under the limit)',
    /const justCompactedUnderLimit =\s*compactionResult !== undefined &&[\s\S]{0,400}!justCompactedUnderLimit &&[\s\S]{0,220}querySource !== 'session_memory'[\s\S]{0,900}?measuredRawTokenCount \?\? tokenCountWithEstimation/.test(tm),
  )
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
