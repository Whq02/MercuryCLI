#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'stale-capacity-'))
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const globalConfig = await import('../../src/utils/config/globalConfig.js')
globalConfig.enableConfigs()
const cap = await import('../../src/services/switchboard/capacityCheck.js')
const { saveGlobalConfig } = await import('../../src/utils/config.js')

{
  const askedAt = Date.UTC(2026, 7, 1)
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt, allowed: true, recommendedSeats: 6 } }))
  check('the ceiling honours the stored consent', cap.resolveSeatCeiling() === 6)
  const words = cap.describeSeatReading(6)
  check('the stored number is named a CONSENTED reading', words.includes('consented capacity reading'), words)
  check('…dated with the ask’s own day', words.includes('from 2026-08-01') && words.includes('6 seats'), words)
  check('…and never wears the live sentence', !words.includes("this machine's reading"), words)
}

{
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 4 } }))
  const words = cap.describeSeatReading(4)
  check('a dateless stored record: consented wording, no fabricated date', words.includes('consented capacity reading:') && !words.includes(' from '), words)
}

{
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: false } }))
  const live = cap.resolveSeatCeiling()
  check('a declined record reads the machine live', live === cap.machineSeatReading())
  const words = cap.describeSeatReading(live)
  check('the live sentence is byte-stable (the C5 pin’s spelling)', words === `this machine's reading: ${live} seat${live === 1 ? '' : 's'} (cores/memory)`, words)
}

{
  saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 6 } }))
  const words = cap.describeSeatReading(4)
  check('a non-stored ceiling keeps the live sentence (the guard)', words.includes("this machine's reading: 4 seats"), words)
}


{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'switchboard', 'capacityCheck.ts'), 'utf8')
  check(
    'the win32 return-0 arm is GONE (the ask named an input the code never probed)',
    !src.includes("if (process.platform === 'win32') return 0"),
  )
  check(
    'win32 scans through the CIM listing with command lines, via the windowsHide spawner',
    src.includes('Get-CimInstance Win32_Process') && src.includes('execFileNoThrow'),
  )
  const cap = await import('../../src/services/switchboard/capacityCheck.ts')
  const probe = await cap.probeCapacity()
  check(
    'the probe answers a real number on this platform (fail-soft, never NaN)',
    typeof probe.otherAgentClis === 'number' && probe.otherAgentClis >= 0 && Number.isInteger(probe.otherAgentClis),
    String(probe.otherAgentClis),
  )
}

console.log(failures === 0 ? 'prove-capacity-narration: GREEN' : `prove-capacity-narration: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
