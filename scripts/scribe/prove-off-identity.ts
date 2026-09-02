#!/usr/bin/env bun

import {
  scribeModeEnabled,
  implementerModeEnabled,
  scribeScopeEnabled,
  scribeBusEnabled,
  isScribeRole,
  isImplementerRole,
} from '../../src/utils/scribe/scribeGates.js'
import { isImplementerSpawnEnabled } from '../../src/daemon/daemonFeatureGates.js'
import { getScribeModeSections } from '../../src/utils/scribeMode.js'
import { getImplementerModeSections } from '../../src/utils/implementerMode.js'
import { scribeScopeDoctrineLines } from '../../src/memdir/scribeScopeDoctrine.js'
import { scanMemoryFiles } from '../../src/memdir/memoryScan.js'
import { frameInboundForImplementer } from '../../src/utils/scribe/implementerFraming.js'
import { scribeRegulationEnabled } from '../../src/utils/scribe/scribeRegulation.js'
import { getSessionAccent, scribeGlowEnabled, setSessionCritter } from '../../src/components/mercury-ui/sessionAccent.js'
import { TERRA } from '../../src/components/mercuryPalette.js'

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}
const MACRO_KEY = 'MACRO' as const

console.log('============================================================')
console.log(' OFF ⇒ byte-identical — Amanuensis capstone (Phase 7.2)')
console.log('============================================================')

delete (globalThis as Record<string, unknown>)[MACRO_KEY]
for (const k of ['MERCURY_SCRIBE_MODE','MERCURY_SCRIBE_IMPLEMENTER','MERCURY_SCRIBE_SCOPE','MERCURY_SCRIBE_BUS','MERCURY_AMANUENSIS','MERCURY_SCRIBE','MERCURY_IMPLEMENTER','MERCURY_SCRIBE_GLOW']) process.env[k] = '0'
delete process.env.MERCURY_SCRIBE
delete process.env.MERCURY_IMPLEMENTER

console.log('\n── every gate is OFF with every flag opted out (=0; stamp inert) ──')
check('scribeModeEnabled() === false', scribeModeEnabled() === false)
check('implementerModeEnabled() === false', implementerModeEnabled() === false)
check('scribeScopeEnabled() === false', scribeScopeEnabled() === false)
check('scribeBusEnabled() === false', scribeBusEnabled() === false)
check('isImplementerSpawnEnabled() === false', isImplementerSpawnEnabled() === false)
check('scribeRegulationEnabled() === false', scribeRegulationEnabled() === false)
check('scribeGlowEnabled() === false', scribeGlowEnabled() === false)
check('isScribeRole()/isImplementerRole() false (no role env)', !isScribeRole() && !isImplementerRole())

console.log('\n── every live call-site degrades to [] / identity ──')
check('getScribeModeSections() === []', getScribeModeSections().length === 0)
check('getImplementerModeSections() === []', getImplementerModeSections().length === 0)
check('scribeScopeDoctrineLines() === []', scribeScopeDoctrineLines().length === 0)
const sample = '<system-reminder>from scribe</system-reminder>'
check('frameInboundForImplementer is identity', frameInboundForImplementer(sample) === sample)
setSessionCritter('crab')
check('getSessionAccent().accent is the normal critter (no glow)', getSessionAccent().accent === TERRA)

{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'hermes-off-'))
  const mk = (rel: string) => {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '---\nname: x\ndescription: d\n---\nbody')
  }
  mk('a.md'); mk(join('scribe', 'cand.md'))
  const scanned = await scanMemoryFiles(dir, new AbortController().signal)
  check('scanMemoryFiles does NOT exclude scribe/ when scope is opted out (identity recall)', scanned.some(h => h.filename.includes('cand.md')))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ OFF ⇒ BYTE-IDENTICAL HOLDS ACROSS THE WHOLE FEATURE')
else console.log(`❌ ${failures} OFF-IDENTITY CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
