#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-capacity-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — fix: ${fix}` : ''}`)
}

const globalConfig = await import('../../src/platform/config/globalConfig.js')
globalConfig.enableConfigs()
const cap = await import('../../src/daemon/switchboard-capacity/capacityCheck.js')
const { saveGlobalConfig } = await import('../../src/platform/settings/config.js')

{
  const askedAt = Date.UTC(2026, 7, 1)
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt, allowed: true, recommendedSeats: 6 } }))
  check('the ceiling honours the stored consent', cap.resolveSeatCeiling() === 6, '', 'resolveSeatCeiling in src/daemon/switchboard-capacity/capacityCheck.ts must return the stored switchboardCapacity.recommendedSeats when allowed is true')
  const words = cap.describeSeatReading(6)
  check('the stored number is named a CONSENTED reading', words.includes('consented capacity reading'), words, 'describeSeatReading in src/daemon/switchboard-capacity/capacityCheck.ts must say consented capacity reading when the ceiling equals the stored recommendedSeats')
  check('…dated with the ask’s own day', words.includes('from 2026-08-01') && words.includes('6 seats'), words, 'describeSeatReading in src/daemon/switchboard-capacity/capacityCheck.ts must print the askedAt day as from YYYY-MM-DD and the seat count')
  check('…and never wears the live sentence', !words.includes("this machine's reading"), words, 'describeSeatReading in src/daemon/switchboard-capacity/capacityCheck.ts must not use the live this-machine sentence for a stored ceiling')
}

{
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 4 } }))
  const words = cap.describeSeatReading(4)
  check('a dateless stored record: consented wording, no fabricated date', words.includes('consented capacity reading:') && !words.includes(' from '), words, 'describeSeatReading in src/daemon/switchboard-capacity/capacityCheck.ts must leave out the from-date when askedAt is 0')
}

{
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: false } }))
  const live = cap.resolveSeatCeiling()
  check('a declined record reads the machine live (the held reading)', live === cap.heldMachineSeatReading(), '', 'resolveSeatCeiling in src/daemon/switchboard-capacity/capacityCheck.ts must return heldMachineSeatReading() when the stored record has allowed false')
  const words = cap.describeSeatReading(live)
  check("the live sentence keeps its spelling: the reading's number and its inputs (the C5 pin's spelling)", new RegExp(`^this machine's reading: ${live} seat${live === 1 ? '' : 's'} \\(\\d+ cores?, [\\d.]+ GB available, \\d+ MB a seat\\)$`).test(words), words, 'describeSeatReading in src/daemon/switchboard-capacity/capacityCheck.ts must keep the live sentence spelling this machine reading: N seats (cores, GB available, MB a seat)')
}

{
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 6 } }))
  const words = cap.describeSeatReading(4)
  check('a non-stored ceiling keeps the live sentence (the guard)', words.includes("this machine's reading: 4 seats"), words, 'describeSeatReading in src/daemon/switchboard-capacity/capacityCheck.ts must use the live sentence when the ceiling differs from the stored recommendedSeats')
}


{
  const cap = await import('../../src/daemon/switchboard-capacity/capacityCheck.ts')
  const probe = await cap.probeCapacity()
  check(
    'the probe answers a real number on this platform (fail-soft, never NaN)',
    typeof probe.otherAgentClis === 'number' && probe.otherAgentClis >= 0 && Number.isInteger(probe.otherAgentClis),
    String(probe.otherAgentClis),
    'probeCapacity in src/daemon/switchboard-capacity/capacityCheck.ts must return otherAgentClis as a non-negative integer, falling back to 0 on error',
  )
}

console.log(failures === 0 ? 'prove-capacity-narration: GREEN' : `prove-capacity-narration: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
