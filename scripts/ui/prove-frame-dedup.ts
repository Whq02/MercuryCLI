#!/usr/bin/env bun
;(globalThis as any).MACRO = { ...((globalThis as any).MACRO ?? {}), VERSION: '1.0.0-beta.1' }
process.env.MERCURY_SUBSTRATE = '0'
delete process.env.MERCURY_DECK_PANE
process.env.MERCURY_FULLSCREEN = '0'

const { isDeckPaneActive, isDeckPaneEnabled } = await import('../../src/utils/fullscreen.ts')

let fail = 0
const expect = (label: string, cond: boolean) => { if (!cond) fail++; console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`) }

process.env.MERCURY_DECK_PANE = '1'
process.env.MERCURY_FULLSCREEN = '0'
expect('no fullscreen → deck NOT active → frame KEEPS vitals', isDeckPaneActive() === false)

process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_DECK_PANE = '1'
expect('fullscreen + MERCURY_DECK_PANE=1 → deck ACTIVE → frame SHEDS vitals', isDeckPaneActive() === true)
expect('gate parity: isDeckPaneEnabled() === true when the deck is enabled (the shared helper FullscreenLayout also calls)', isDeckPaneEnabled() === true)

delete process.env.MERCURY_DECK_PANE
process.env.MERCURY_SUBSTRATE = '0'
expect('fullscreen but deck OFF (substrate=0, no DECK_PANE) → frame KEEPS vitals', isDeckPaneActive() === false)
expect('gate parity: isDeckPaneEnabled() === false when the deck is off (the shared helper drives both gates — no divergence)', isDeckPaneEnabled() === false)

console.log(fail === 0 ? '\n✅ FRAME DEDUP PROOF PASS' : `\n❌ ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
