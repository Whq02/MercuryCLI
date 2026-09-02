#!/usr/bin/env bun
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

{
  const src = readFileSync(join(import.meta.dir, '../../src/cli/print.ts'), 'utf8')
  const facts = src.slice(src.indexOf("case 'session_facts'"))
  const answerBlock = facts.slice(0, facts.indexOf('identity:'))
  t('§1 the session_facts answer spreads openaiObservedUsage()', answerBlock.includes('openaiObservedUsage()'))
  t('§1 …under the openaiObserved key', answerBlock.includes('openaiObserved'))
}

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

{
  __resetOpenaiLimitStateForTest()
  const now = Date.now()

  adoptOpenaiObservedUsage(undefined)
  t('§3 absent record adopts nothing', openaiObservedUsage().primary === undefined)

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

  adoptOpenaiObservedUsage({ primary: { usedPct: 11, observedAtMs: now - 60_000 } })
  t('§3 a stale band is ignored (recency fold)', openaiObservedUsage().primary?.usedPct === 37)

  adoptOpenaiObservedUsage({ primary: { usedPct: 41, observedAtMs: now - 1_000 } })
  t('§3 a newer band wins', openaiObservedUsage().primary?.usedPct === 41)

  adoptOpenaiObservedUsage({ secondary: { usedPct: 9, observedAtMs: now } })
  const after = openaiObservedUsage()
  t('§3 bands fold independently (absent ≠ zero)', after.primary?.usedPct === 41 && after.secondary?.usedPct === 9)

  adoptOpenaiObservedUsage({ primary: { usedPct: 400, observedAtMs: now + 1 } })
  adoptOpenaiObservedUsage({ primary: { usedPct: 50, observedAtMs: Number.NaN } })
  adoptOpenaiObservedUsage('garbage' as never)
  t('§3 malformed input changes nothing', openaiObservedUsage().primary?.usedPct === 41)

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
