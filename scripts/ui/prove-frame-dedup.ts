#!/usr/bin/env bun
// Proof: isDeckPaneActive() — which drives whether MercuryFrame SHEDS the deck-owned vitals
// (model/cost/usage/branch/scribe) — flips correctly on the fullscreen + deck gate. This locks
// the dedup invariant: the frame sheds vitals IFF the deck is showing them (no double-render),
// and KEEPS them when there's no deck (no inline regression).
//
// Notes: the build stamp is the folded MACRO.VERSION →
// stamp-sim via globalThis.MACRO before import. isFullscreenEnvEnabled() + isEnvTruthy() read env
// LIVE per-call, so the assertions toggle env in-process. The substrate-default ON → shed path is
// additionally render-verified (the dedup plan's after-deck.png). Joins scripts/ui/run-all.sh.
;(globalThis as any).MACRO = { ...((globalThis as any).MACRO ?? {}), VERSION: '1.0.0-beta.1' }
process.env.MERCURY_SUBSTRATE = '0' // deck reached only via explicit MERCURY_DECK_PANE in the checks
delete process.env.MERCURY_DECK_PANE
process.env.MERCURY_FULLSCREEN = '0' // fullscreen is default-ON — the defined-falsy value is the one inline opt-out (the runtime reads only this spelling)

const { isDeckPaneActive, isDeckPaneEnabled } = await import('../../src/utils/fullscreen.ts')

let fail = 0
const expect = (label: string, cond: boolean) => { if (!cond) fail++; console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`) }

// 1. No fullscreen → the deck never renders → frame KEEPS vitals (active=false), even with DECK_PANE set.
process.env.MERCURY_DECK_PANE = '1'
process.env.MERCURY_FULLSCREEN = '0' // fullscreen is default-ON — the defined-falsy value is the one inline opt-out (the runtime reads only this spelling)
expect('no fullscreen → deck NOT active → frame KEEPS vitals', isDeckPaneActive() === false)

// 2. Fullscreen + MERCURY_DECK_PANE=1 → deck ACTIVE → frame SHEDS vitals.
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_DECK_PANE = '1'
expect('fullscreen + MERCURY_DECK_PANE=1 → deck ACTIVE → frame SHEDS vitals', isDeckPaneActive() === true)
expect('gate parity: isDeckPaneEnabled() === true when the deck is enabled (the shared helper FullscreenLayout also calls)', isDeckPaneEnabled() === true)

// 3. Fullscreen but deck OFF (no DECK_PANE, substrate=0) → deck NOT active → frame KEEPS vitals.
delete process.env.MERCURY_DECK_PANE
process.env.MERCURY_SUBSTRATE = '0'
expect('fullscreen but deck OFF (substrate=0, no DECK_PANE) → frame KEEPS vitals', isDeckPaneActive() === false)
expect('gate parity: isDeckPaneEnabled() === false when the deck is off (the shared helper drives both gates — no divergence)', isDeckPaneEnabled() === false)

console.log(fail === 0 ? '\n✅ FRAME DEDUP PROOF PASS' : `\n❌ ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
