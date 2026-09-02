#!/usr/bin/env bun
// ============================================================================
//  prove-openai-meter-daemon-road — the GPT meter crosses the process
//  boundary (a duplicate-paint sighting).
//
//  THE SIGHTING: a focused gpt chat had JUST answered, and the rail showed
//  no GPT meter at all. The mechanism: the OpenAI lane has no polled usage
//  endpoint — its truth arrives on response headers (the x-codex bands),
//  observed into openaiLimitState's process-local record by whichever
//  process MAKES the calls. On the daemon road that is the session's
//  RUNNER; the cockpit paints from its own process record, which nothing
//  ever fed — an eternally-empty meter beside real signal. The Anthropic
//  windows never showed this class because the cockpit polls that lane's
//  endpoint itself.
//
//  THE LAW: the runner's facts answer carries its last-observed bands
//  (UsageFactsV1.openaiObserved — additive, absent = older runner or a
//  lane that never spoke), and the connector ADOPTS them on every facts
//  read through openaiLimitState's one recency fold: a stated band lands
//  only when newer than what the screen holds, absent ≠ zero, malformed
//  records are ignored whole.
//
//  §1 the child's answer spreads its observed record (source pin)
//  §2 the connector adopts on every facts read (source pin)
//  §3 the adoption fold laws through the REAL store + window views
//  §4 the wire carries the band shape (structural)
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  __resetOpenaiLimitStateForTest,
  adoptOpenaiObservedUsage,
  openaiObservedUsage,
  recordOpenaiRateHeaders,
} from '../../src/services/providers/openai/openaiLimitState.ts'
import { openaiObservedWindowViews } from '../../src/services/providers/providerUsage.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// §1 the child's answer
{
  const src = readFileSync(join(import.meta.dir, '../../src/cli/print.ts'), 'utf8')
  const facts = src.slice(src.indexOf("case 'session_facts'"))
  const answerBlock = facts.slice(0, facts.indexOf('identity:'))
  t('§1 the session_facts answer spreads openaiObservedUsage()', answerBlock.includes('openaiObservedUsage()'))
  t('§1 …under the openaiObserved key', answerBlock.includes('openaiObserved'))
}

// §2 the connector adoption
{
  const src = readFileSync(
    join(import.meta.dir, '../../src/services/engine-connector/daemonConnector.ts'),
    'utf8',
  )
  t(
    '§2 readFacts adopts the projection through the one fold',
    src.includes('adoptOpenaiObservedUsage(next.usage?.openaiObserved)'),
  )
}

// §3 the fold laws on the real store
{
  __resetOpenaiLimitStateForTest()
  const now = Date.now()

  // absent record: no-op, never throws
  adoptOpenaiObservedUsage(undefined)
  t('§3 absent record adopts nothing', openaiObservedUsage().primary === undefined)

  // a fresh stated band lands and reaches the window views
  adoptOpenaiObservedUsage({
    primary: { usedPct: 37, windowMinutes: 10_080, resetsAtMs: now + 600_000_000, observedAtMs: now - 5_000 },
  })
  const landed = openaiObservedUsage().primary
  t('§3 a stated band lands whole', landed?.usedPct === 37 && landed.windowMinutes === 10_080)
  const views = openaiObservedWindowViews()
  t(
    '§3 …and lights the window views (the rail/tab derivation)',
    views.some(v => v.state === 'live' && Math.round(v.usedPct ?? -1) === 37),
    JSON.stringify(views),
  )

  // a STALE projection never regresses the held record
  adoptOpenaiObservedUsage({ primary: { usedPct: 11, observedAtMs: now - 60_000 } })
  t('§3 a stale band is ignored (recency fold)', openaiObservedUsage().primary?.usedPct === 37)

  // a NEWER projection wins
  adoptOpenaiObservedUsage({ primary: { usedPct: 41, observedAtMs: now - 1_000 } })
  t('§3 a newer band wins', openaiObservedUsage().primary?.usedPct === 41)

  // the secondary band folds independently; absent primary changes nothing
  adoptOpenaiObservedUsage({ secondary: { usedPct: 9, observedAtMs: now } })
  const after = openaiObservedUsage()
  t('§3 bands fold independently (absent ≠ zero)', after.primary?.usedPct === 41 && after.secondary?.usedPct === 9)

  // malformed records are ignored whole
  adoptOpenaiObservedUsage({ primary: { usedPct: 400, observedAtMs: now + 1 } })
  adoptOpenaiObservedUsage({ primary: { usedPct: 50, observedAtMs: Number.NaN } })
  adoptOpenaiObservedUsage('garbage' as never)
  t('§3 malformed input changes nothing', openaiObservedUsage().primary?.usedPct === 41)

  // the header road (this process's own traffic) still wins by the same
  // recency law — one record, two feeders, no divergence
  const headers = new Headers({
    'x-codex-primary-used-percent': '55',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-after-seconds': '600',
  })
  recordOpenaiRateHeaders(headers, () => now + 10_000)
  t('§3 the header feeder shares the record', openaiObservedUsage().primary?.usedPct === 55)
  adoptOpenaiObservedUsage({ primary: { usedPct: 60, observedAtMs: now + 5_000 } })
  t('§3 …and a projection older than the headers stays out', openaiObservedUsage().primary?.usedPct === 55)

  __resetOpenaiLimitStateForTest()
}

// §4 the wire shape
{
  const src = readFileSync(
    join(import.meta.dir, '../../src/services/engine-connector/types.ts'),
    'utf8',
  )
  t('§4 UsageFactsV1 carries openaiObserved', /openaiObserved\?:/.test(src))
  t('§4 the band shape stamps its observation', src.includes('OpenaiObservedBandV1') && /observedAtMs: number/.test(src))
}

console.log(failures === 0 ? 'OPENAI METER DAEMON ROAD: ALL PASS' : 'FAILURES')
process.exit(failures)
