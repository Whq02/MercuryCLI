#!/usr/bin/env bun
import { join, sep } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const OVERRIDE = join('/tmp', 'mercury-seam-proof', 'daemon-home')

section('1. MERCURY_DAEMON_DIR redirects every daemon-home path (live env read)')

const prevEnv = process.env.MERCURY_DAEMON_DIR
try {
  const cs = await import(join(ROOT, 'src', 'daemon', 'control', 'controlSocket.ts'))

  process.env.MERCURY_DAEMON_DIR = OVERRIDE
  check('daemonDir() honors the override', cs.daemonDir() === OVERRIDE, cs.daemonDir())
  check(
    'daemonStatePath() lands under the override',
    (cs.daemonStatePath() as string).startsWith(OVERRIDE + sep),
    cs.daemonStatePath(),
  )

  delete process.env.MERCURY_DAEMON_DIR
  const defDir = cs.daemonDir() as string
  check(
    'unset ⇒ daemonDir() falls back to <configHome>/daemon',
    defDir.endsWith(sep + 'daemon') && !defDir.startsWith(OVERRIDE),
    defDir,
  )


} finally {
  if (prevEnv === undefined) delete process.env.MERCURY_DAEMON_DIR
  else process.env.MERCURY_DAEMON_DIR = prevEnv
}

console.log('')
if (failures > 0) {
  console.log(`❌ daemon-dir seam proof: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ daemon-dir seam proof: all checks pass')
