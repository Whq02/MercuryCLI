// ============================================================================
//  scripts/pulse/lib/proveKit.ts — shared prover plumbing for the
//  matrix suite: check/section/finish (house style) + the PENDING-INTEGRATION
//  exit-2 contract.
//
//  Exit contract:
//    0 = GREEN   1 = RED   2 = PENDING-INTEGRATION (a promised src seam —
//    MERCURY_PULSE_DUMP / MERCURY_PULSE_FIXTURE — has not landed in the SHIPPED
//    artifact yet; one-line reason on stdout so run-all.sh can wire the file
//    in immediately and flip it live the moment the integrator ships).
// ============================================================================

import { distHasSpelling } from './pulseArena.ts'

let failures = 0
let checks = 0

export function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

export function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

export function finish(name: string): never {
  console.log(
    failures === 0
      ? `\n✅ ${name} GREEN (${checks} checks)`
      : `\n❌ ${name} RED (${failures}/${checks} checks failed)`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

/** Exit 2 with a one-line reason when a promised integrator seam is not in
 *  the shipped artifact. The dist is the truth (host-vs-built lesson) — a
 *  source-only landing that never reached dist/mercury.mjs is still pending. */
export function requireDistSeam(spelling: string, prover: string): void {
  if (!distHasSpelling(spelling)) {
    console.log(
      `PENDING-INTEGRATION: ${prover} needs the ${spelling} seam in dist/mercury.mjs — not present yet (rebuild after the integrator lands it)`,
    )
    process.exit(2)
  }
}

/** Watchdog: a PTY prover that wedges must die RED, not hang the suite. */
export function armWatchdog(name: string, ms: number): void {
  const guard = setTimeout(() => {
    console.log(`\n❌ ${name} TIMEOUT after ${ms}ms`)
    process.exit(1)
  }, ms)
  guard.unref?.()
}
