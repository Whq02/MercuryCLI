#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { stampDaemonLogLine, installStampedDaemonLog } = await import('../../src/daemon/daemonLogStamp.ts')
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /

console.log('============================================================')
console.log(' Daemon log — every line carries the engage line\'s ISO stamp')
console.log('============================================================')

section('§1 the stamp: an unstamped line leads with an ISO, an already-stamped line is left alone')
const admit = stampDaemonLogLine('[daemon] concourse worker admitted: concourse-w1 (pid 42) — fable@max, cwd /w')
check('an unstamped admit line leads with an ISO stamp', ISO.test(admit), admit)
check('…and keeps its whole text after the stamp', admit.endsWith('[daemon] concourse worker admitted: concourse-w1 (pid 42) — fable@max, cwd /w'))
const park = stampDaemonLogLine('[daemon] seat idle edge: concourse-w1')
check('a park line is stamped too', ISO.test(park) && park.includes('[daemon] seat idle edge: concourse-w1'))
const already = '2026-09-19T10:00:00.000Z [INFO] [daemon] control socket up'
check('a line that already leads with an ISO is not stamped twice', stampDaemonLogLine(already) === already)
const engage = stampDaemonLogLine('[mercury-daemon] engaged v1.0.0 pid 4242 dir /work')
check('the engage line leads with the stamp and keeps its whole text after it', ISO.test(engage) && engage.endsWith('[mercury-daemon] engaged v1.0.0 pid 4242 dir /work'), engage)

section('§2 the wrapper: console.error the daemon writes is stamped once installed')
const captured: string[] = []
const realError = console.error
console.error = ((...a: unknown[]): void => {
  captured.push(a.map(x => (typeof x === 'string' ? x : String(x))).join(' '))
}) as typeof console.error
installStampedDaemonLog()
console.error('[daemon] restart armed by screen 1 — re-executes as the deployed build when the 2 live worker(s) finish')
console.error = realError
check('the wrapped console.error stamped the daemon line', captured.length === 1 && ISO.test(captured[0]!), captured[0] ?? '(nothing captured)')
check('…and the daemon text survives the stamp', (captured[0] ?? '').includes('[daemon] restart armed by screen 1'))

section('§3 the wiring: the detached daemon installs the stamp, a foreground daemon is left alone')
const main = readFileSync(join(ROOT, 'src/daemon/main.ts'), 'utf8')
check('main installs the stamp only for the detached daemon', main.includes('if (!foreground) installStampedDaemonLog()'))
check('the engage line leads with the stamp through the one stamper, written before the wrapper is installed', main.includes('stampDaemonLogLine(`[mercury-daemon] engaged v') && !main.includes('dir ${dir} at ${new Date().toISOString()}'))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
