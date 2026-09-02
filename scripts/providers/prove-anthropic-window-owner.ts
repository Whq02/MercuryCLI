#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  __setAnthropicOwnerResolverForTest,
  foldUtilizationFromEndpoint,
  getRawUtilization,
  resetLimitsForCredentialSwitch,
} from '../../src/services/claudeAiLimits.ts'
import { quotaWindows } from '../../src/utils/cockpit/quota.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const resetsAtIso = new Date(Date.now() + 3_600_000).toISOString()

{
  resetLimitsForCredentialSwitch()
  __setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:slot-a')
  t('§5 a never-stamped record reads empty without tripping the gate', Object.keys(getRawUtilization()).length === 0)
}

{
  foldUtilizationFromEndpoint({
    five_hour: { utilization: 41, resets_at: resetsAtIso },
    seven_day: { utilization: 12, resets_at: resetsAtIso },
  })
  const w = quotaWindows()
  t('§1 slot A observes and slot A reads: both windows live', w.fiveHour.state === 'live' && w.sevenDay.state === 'live')
  t('§1 …with the observed numbers', Math.round(w.fiveHour.usedPct ?? -1) === 41)
}

{
  __setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:slot-b')
  const w = quotaWindows()
  t(
    '§2 the flipped slot reads honest absence, never the departed numbers',
    w.fiveHour.state === 'unavailable' && w.sevenDay.state === 'unavailable',
    JSON.stringify(w),
  )
}

{
  __setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:slot-a')
  const w = quotaWindows()
  t('§3 the observing slot returns and its record stands (attribution, never destruction)', w.fiveHour.state === 'live' && Math.round(w.fiveHour.usedPct ?? -1) === 41)
}

{
  resetLimitsForCredentialSwitch()
  const w = quotaWindows()
  t('§4 after the credential-switch reset the meters are empty', w.fiveHour.state === 'unavailable')
  __setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:slot-b')
  foldUtilizationFromEndpoint({ five_hour: { utilization: 7, resets_at: resetsAtIso }, seven_day: null })
  t('§4 …and the new slot re-stamps with its own observation', Math.round(quotaWindows().fiveHour.usedPct ?? -1) === 7)
}

{
  const src = readFileSync(join(import.meta.dir, '../../src/services/claudeAiLimits.ts'), 'utf8')
  const stamps = src.match(/observedOwner = resolveOwner\(\)/g) ?? []
  t('§6 BOTH fold sites stamp the owner (headers + endpoint)', stamps.length === 2, `found ${stamps.length}`)
  t('§6 the one read gates on the stamp', src.includes('observedOwner === null || observedOwner === resolveOwner()'))
  t('§6 the reset roads clear the stamp', (src.match(/observedOwner = null/g) ?? []).length >= 2)
}

__setAnthropicOwnerResolverForTest(null)
resetLimitsForCredentialSwitch()

console.log(failures === 0 ? 'ANTHROPIC WINDOW OWNER: ALL PASS' : 'FAILURES')
process.exit(failures)
