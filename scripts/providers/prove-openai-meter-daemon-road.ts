#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __resetOpenaiLimitStateForTest,
  adoptOpenaiObservedUsage,
  forgetOpenaiLimitSource,
  openaiObservedUsage,
  recordOpenaiRateHeaders,
} from '../../src/models/roads/openai/openaiLimitState.ts'
import { openaiObservedWindowViews } from '../../src/models/roads/providerUsage.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}${!ok ? ' — change adoptOpenaiObservedUsage, recordOpenaiRateHeaders or forgetOpenaiLimitSource in src/models/roads/openai/openaiLimitState.ts (the window views are openaiObservedWindowViews in src/models/roads/providerUsage.ts)' : ''}`)
  if (!ok) failures = 1
}

{
  ;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
  const { publishSessionFacts } = await import('../../src/engine/connector/seatProjections.ts')
  const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
  __resetOpenaiLimitStateForTest()
  const plane = mkdtempSync(join(tmpdir(), 'openai-meter-road-'))
  const planeBefore = process.env.MERCURY_DAEMON_DIR
  process.env.MERCURY_DAEMON_DIR = plane
  const now = Date.now()
  publishSessionFacts({ schema: 1, sessionId: 'meter-road', atMs: now, busy: false, pendingModel: null, model: { effective: 'gpt-5.2', setting: null }, usage: { openaiObserved: { primary: { usedPct: 23, windowMinutes: 10_080, resetsAtMs: now + 600_000_000, observedAtMs: now - 5_000 } } }, queue: [] } as never)
  const hosted = new DaemonSessionConnector({ sessionId: 'meter-road', runnerId: 'runner-1', title: 'meter road', projectLabel: 'proof', workspaceId: plane, home: plane } as never, { rpc: async () => ({ ok: true }), armTranscriptWatcher: () => {}, armTranscriptTimer: () => {} })
  await hosted.attach()
  hosted.detach()
  if (planeBefore === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = planeBefore
  rmSync(plane, { recursive: true, force: true })
  t(
    '§2 the facts read adopts the projection through the one fold',
    openaiObservedUsage().primary?.usedPct === 23,
    `a hosted connector attached over facts whose usage.openaiObserved states 23% leaves the record at ${JSON.stringify(openaiObservedUsage())}: its facts read hands usage.openaiObserved to adoptOpenaiObservedUsage`,
  )
  __resetOpenaiLimitStateForTest()
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
  __resetOpenaiLimitStateForTest()
  const now = Date.now()
  adoptOpenaiObservedUsage({ credits: { hasCredits: true, unlimited: false, balance: '62500', source: 'endpoint', observedAtMs: now } })
  t('credits cross the daemon facts boundary without a usage band', openaiObservedUsage().credits?.balance === '62500')
  adoptOpenaiObservedUsage({ credits: { hasCredits: true, unlimited: false, balance: '1', source: 'headers', observedAtMs: now - 1 } })
  t('a stale daemon balance never regresses a newer endpoint balance', openaiObservedUsage().credits?.balance === '62500')
  adoptOpenaiObservedUsage({ primary: { usedPct: 40, observedAtMs: now + 1 } })
  t('a bands-only projection does not erase or restamp credits', openaiObservedUsage().credits?.observedAtMs === now)
  adoptOpenaiObservedUsage({ credits: { hasCredits: false, unlimited: true, observedAtMs: now + 2 } })
  t('a newer unlimited statement replaces the previous balance', openaiObservedUsage().credits?.unlimited === true && openaiObservedUsage().credits?.balance === undefined)
  forgetOpenaiLimitSource('chatgpt-subscription')
  t('the source forget drops credits with the bands', Object.keys(openaiObservedUsage()).length === 0)
}

console.log(failures === 0 ? 'OPENAI METER DAEMON ROAD: ALL PASS' : 'FAILURES')
process.exit(failures)
