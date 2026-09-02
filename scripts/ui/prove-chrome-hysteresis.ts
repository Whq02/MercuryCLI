#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-chrome-hysteresis.ts — the cockpit-boundary hysteresis
//  oracle (mercury-feel; DoD: "a one-column resize or transient
//  terminal report cannot flap layouts").
//
//  chromeModeLive (the layout owner's entry) holds an ENGAGED cockpit
//  through a ≤3-column shrink and re-enters only at the true threshold —
//  while the pure computeChromeMode stays a stateless threshold for the
//  context-width callers.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-chrome-hysteresis.ts
// ============================================================================

const { chromeModeLive, computeChromeMode, resetChromeModeLatchForTests, LAYOUT_BREAKPOINTS } = await import('../../src/hooks/useLayoutTier.js')

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

console.log(failures === 0 ? '\n✓ prove-chrome-hysteresis: all green' : `\n✗ prove-chrome-hysteresis: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
