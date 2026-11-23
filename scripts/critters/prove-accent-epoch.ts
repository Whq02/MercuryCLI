#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


const accent = await import('../../src/screen/widgets/sessionAccent.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond ? '' : ' — change setSessionCritter, setSessionAccentOverride, getAccentEpoch, getSessionAccent and subscribeSessionCritter in src/screen/widgets/sessionAccent.ts'}`)
}

console.log('============================================================')
console.log(' accent epoch — the theme-resolution repaint signal')
console.log('============================================================')

let notified = 0
const unsub = accent.subscribeSessionCritter(() => {
  notified++
})
const e0 = accent.getAccentEpoch()
accent.setSessionCritter('jellyfish')
check('a /critter pick bumps the epoch', accent.getAccentEpoch() === e0 + 1)
check('… and notifies the listeners', notified === 1)
accent.setSessionCritter('jellyfish')
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


console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ ACCENT EPOCH PROOF PASS')
