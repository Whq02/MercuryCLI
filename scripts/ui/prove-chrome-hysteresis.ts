#!/usr/bin/env bun

const { chromeModeLive, layoutChromeLive, computeChromeMode, resetChromeModeLatchForTests, LAYOUT_BREAKPOINTS } = await import('../../src/hooks/useLayoutTier.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('prove-chrome-hysteresis')
const MIN = LAYOUT_BREAKPOINTS.cockpitMin
const ROWS = 40

resetChromeModeLatchForTests()
check('below threshold boots deck-strip', chromeModeLive(MIN - 1, ROWS) !== 'cockpit')
check('threshold engages the cockpit', chromeModeLive(MIN, ROWS) === 'cockpit')
check('a 1-col wobble DOWN holds the cockpit (latched)', chromeModeLive(MIN - 1, ROWS) === 'cockpit')
check('a 3-col shrink still holds (edge of the band)', chromeModeLive(MIN - 3, ROWS) === 'cockpit')
check('a 4-col shrink disengages', chromeModeLive(MIN - 4, ROWS) !== 'cockpit')
check('re-entry needs the TRUE threshold (band is one-way)', chromeModeLive(MIN - 1, ROWS) !== 'cockpit')
check('back at the threshold re-engages', chromeModeLive(MIN, ROWS) === 'cockpit')
check('a short terminal disengages regardless of the latch', chromeModeLive(MIN, 8) !== 'cockpit')
check('the PURE decision stays stateless at the boundary', computeChromeMode(MIN - 1, ROWS) !== 'cockpit' && computeChromeMode(MIN, ROWS) === 'cockpit')
resetChromeModeLatchForTests()

resetChromeModeLatchForTests()
check('100x26 is the exact full-layout entry', chromeModeLive(100, 26) === 'cockpit')
check('height exits immediately even within the width hold band', chromeModeLive(97, 25) !== 'cockpit')
check('height recovery at 97 does not recreate a discarded width latch', chromeModeLive(97, 30) !== 'cockpit')
check('100 columns restores full after the height release', chromeModeLive(100, 30) === 'cockpit')
check('120x25 is compact despite its width', chromeModeLive(120, 25) !== 'cockpit')
check('120x26 returns to full immediately', chromeModeLive(120, 26) === 'cockpit')
resetChromeModeLatchForTests()
check('a fresh 99x26 frame is compact', chromeModeLive(99, 26) !== 'cockpit')
resetChromeModeLatchForTests()

const savedHome = process.env.MERCURY_HELM_HOME
const savedDeck = process.env.MERCURY_DECK_PANE
process.env.MERCURY_HELM_HOME = '0'
process.env.MERCURY_DECK_PANE = '1'
resetChromeModeLatchForTests()
check('the full-size home opt-out preserves the deck rather than forcing compact', layoutChromeLive(120, 40).isCompact === false && chromeModeLive(120, 40) === 'deck-strip')
check('the full-size latch survives the width band with the home opted out', layoutChromeLive(97, 26).isCompact === false)
check('short geometry is compact even when the deck is enabled', layoutChromeLive(120, 24).isCompact === true)
if (savedHome === undefined) delete process.env.MERCURY_HELM_HOME; else process.env.MERCURY_HELM_HOME = savedHome
if (savedDeck === undefined) delete process.env.MERCURY_DECK_PANE; else process.env.MERCURY_DECK_PANE = savedDeck
resetChromeModeLatchForTests()

console.log(failures === 0 ? '\n✓ prove-chrome-hysteresis: all green' : `\n✗ prove-chrome-hysteresis: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
