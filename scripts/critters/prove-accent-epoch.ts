#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const accent = await import('../../src/components/mercury-ui/sessionAccent.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' accent epoch — the theme-resolution repaint signal')
console.log('============================================================')

let notified = 0
const unsub = accent.subscribeSessionCritter(() => {
  notified++
})
const e0 = accent.getAccentEpoch()
accent.setSessionCritter('crab')
check('a /critter pick bumps the epoch', accent.getAccentEpoch() === e0 + 1)
check('… and notifies the listeners', notified === 1)
accent.setSessionCritter('crab')
check('a same-key pick is a full no-op (no bump, no notify)', accent.getAccentEpoch() === e0 + 1 && notified === 1)
accent.setSessionCritter('not-a-critter')
check('an unknown key is a full no-op', accent.getAccentEpoch() === e0 + 1 && notified === 1)

const e1 = accent.getAccentEpoch()
check('override set returns true + bumps', accent.setSessionAccentOverride('#3FBFA0') === true && accent.getAccentEpoch() === e1 + 1)
check('… and notifies', notified === 2)
check('override clear bumps + notifies', accent.setSessionAccentOverride(null) === true && accent.getAccentEpoch() === e1 + 2 && notified === 3)
check('a no-op clear bumps nothing', accent.setSessionAccentOverride(null) === false && accent.getAccentEpoch() === e1 + 2 && notified === 3)
check('junk input bumps nothing', accent.setSessionAccentOverride('not-a-hex') === false && accent.getAccentEpoch() === e1 + 2)
unsub()
accent.setSessionCritter('octopus')
check('unsubscribe honored (restore pick did not notify the dead listener)', notified === 3)

accent.setSessionCritter('octopus')
accent.setSessionAccentOverride('#3f7e96')
check('override keeps the LIVE critter identity', accent.getSessionAccent().key === 'octopus', accent.getSessionAccent().key)
check('… while the accent is the override tint', accent.getSessionAccent().accent === '#3f7e96')
accent.setSessionCritter('clam')
check('a /critter pick under override MORPHS the identity', accent.getSessionAccent().key === 'clam', accent.getSessionAccent().key)
check('… and keeps the override tint', accent.getSessionAccent().accent === '#3f7e96')
check('the hook snapshot reflects the pick under override', accent.getSessionAccentSnapshotKey().startsWith('clam:'))
accent.setSessionAccentOverride(null)
check('clear restores the derived accent for the live critter', accent.getSessionAccent().accent === accent.CRITTERS.clam!.accent)
accent.setSessionCritter('octopus')

const ROOT = join(import.meta.dir, '..', '..')
const accentSrc = readFileSync(join(ROOT, 'src/components/mercury-ui/sessionAccent.ts'), 'utf8')
check('scribe toggles bridge into the accent listeners (glow repaint)', /subscribeScribeMode\(\(\) => \{\s*bumpAccentEpoch\(\)/.test(accentSrc))
check('the hook snapshot covers the scribe-glow bit', /scribeGlowEnabled\(\) \? 'glow'/.test(accentSrc))
const boxSrc = readFileSync(join(ROOT, 'src/components/design-system/ThemedBox.tsx'), 'utf8')
const textSrc = readFileSync(join(ROOT, 'src/components/design-system/ThemedText.tsx'), 'utf8')
const pin = 'useSessionAccent()'
const hookSrc = accentSrc
check('useSessionAccent subscribes to the session critter store (accent epoch reactivity)', /useSyncExternalStore\(\s*subscribeSessionCritter,\s*getSessionAccentSnapshotKey,\s*getSessionAccentSnapshotKey,\s*\)/.test(hookSrc))
check('ThemedBox re-resolves on accent moves', boxSrc.includes(pin))
check('ThemedText re-resolves on accent moves', textSrc.includes(pin))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ACCENT EPOCH PROOF PASS')
