#!/usr/bin/env bun
// ============================================================================
//  prove-anthropic-window-owner — the window records belong to ONE slot
//  (a duplicate-paint sighting).
//
//  THE SIGHTING: the operator flipped their active Anthropic slot and the
//  rail kept painting the DEPARTED slot's usage numbers. The records
//  (header-fed rawUtilization + endpoint-fed windows) carried no slot
//  identity — correctness hung entirely on every account-changing road
//  remembering to call the reset, and any road that missed it repainted
//  the old account's meters (credentialIdentity.ts names the class: a
//  snapshot keyed coarser than its credential outlives it).
//
//  THE LAW: every fold stamps the ACTIVE slot's wallet-entry id
//  (observedOwner); the ONE read (getRawUtilization — quotaWindows, the
//  pool views, the rail and the /usage tab all derive from it) answers
//  only while the stamp names the active slot. A mismatch reads as honest
//  absence until the new slot's own observation lands — stale-by-
//  construction, with the credential-switch resets kept as the belt.
//
//  §1 an observation answers while its slot is active
//  §2 the flip alone (NO reset) blanks the meters
//  §3 flipping back restores the still-fresh record (attribution, never
//     destruction)
//  §4 the reset road clears the stamp with the records (the belt)
//  §5 a never-stamped record passes vacuously
//  §6 both fold sites stamp; the read gates (source pins)
// ============================================================================
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

// §5 first (clean world): nothing observed — the gate is silent
{
  resetLimitsForCredentialSwitch()
  __setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:slot-a')
  t('§5 a never-stamped record reads empty without tripping the gate', Object.keys(getRawUtilization()).length === 0)
}

// §1 the observation answers while its slot is active
{
  foldUtilizationFromEndpoint({
    five_hour: { utilization: 41, resets_at: resetsAtIso },
    seven_day: { utilization: 12, resets_at: resetsAtIso },
  })
  const w = quotaWindows()
  t('§1 slot A observes and slot A reads: both windows live', w.fiveHour.state === 'live' && w.sevenDay.state === 'live')
  t('§1 …with the observed numbers', Math.round(w.fiveHour.usedPct ?? -1) === 41)
}

// §2 the flip ALONE blanks the meters — no reset ran
{
  __setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:slot-b')
  const w = quotaWindows()
  t(
    '§2 the flipped slot reads honest absence, never the departed numbers',
    w.fiveHour.state === 'unavailable' && w.sevenDay.state === 'unavailable',
    JSON.stringify(w),
  )
}

// §3 flipping back restores the still-fresh record
{
  __setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:slot-a')
  const w = quotaWindows()
  t('§3 the observing slot returns and its record stands (attribution, never destruction)', w.fiveHour.state === 'live' && Math.round(w.fiveHour.usedPct ?? -1) === 41)
}

// §4 the reset road clears record AND stamp (the belt)
{
  resetLimitsForCredentialSwitch()
  const w = quotaWindows()
  t('§4 after the credential-switch reset the meters are empty', w.fiveHour.state === 'unavailable')
  // and a fresh observation under the NEW slot stamps anew
  __setAnthropicOwnerResolverForTest(() => 'anthropic:oauth:slot-b')
  foldUtilizationFromEndpoint({ five_hour: { utilization: 7, resets_at: resetsAtIso }, seven_day: null })
  t('§4 …and the new slot re-stamps with its own observation', Math.round(quotaWindows().fiveHour.usedPct ?? -1) === 7)
}

// §6 source pins: the fold sites stamp; the read gates
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
