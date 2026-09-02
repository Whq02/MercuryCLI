
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

export function requireDistSeam(spelling: string, prover: string): void {
  if (!distHasSpelling(spelling)) {
    console.log(
      `PENDING-INTEGRATION: ${prover} needs the ${spelling} seam in dist/mercury.mjs — not present yet (rebuild after the integrator lands it)`,
    )
    process.exit(2)
  }
}

export function armWatchdog(name: string, ms: number): void {
  const guard = setTimeout(() => {
    console.log(`\n❌ ${name} TIMEOUT after ${ms}ms`)
    process.exit(1)
  }, ms)
  guard.unref?.()
}
