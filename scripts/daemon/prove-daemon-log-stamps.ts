#!/usr/bin/env bun
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { stampDaemonLogLine, installStampedDaemonLog } = await import('../../src/daemon/control/daemonLogStamp.ts')
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /

console.log('============================================================')
console.log(' Daemon log — every line carries the engage line\'s ISO stamp')
console.log('============================================================')

section('§1 the stamp: an unstamped line leads with an ISO, an already-stamped line is left alone')
const admit = stampDaemonLogLine('[daemon] concourse worker admitted: concourse-w1 (pid 42) — fable@max, cwd /w')
check('an unstamped admit line leads with an ISO stamp', ISO.test(admit), admit + ' — stampDaemonLogLine in src/daemon/control/daemonLogStamp.ts must prefix an ISO stamp')
check('…and keeps its whole text after the stamp', admit.endsWith('[daemon] concourse worker admitted: concourse-w1 (pid 42) — fable@max, cwd /w'), admit + ' — stampDaemonLogLine in src/daemon/control/daemonLogStamp.ts must keep the line text after the ISO stamp')
const park = stampDaemonLogLine('[daemon] seat idle edge: concourse-w1')
check('a park line is stamped too', ISO.test(park) && park.includes('[daemon] seat idle edge: concourse-w1'), park + ' — stampDaemonLogLine in src/daemon/control/daemonLogStamp.ts must prefix every unstamped line with an ISO stamp')
const already = '2026-09-19T10:00:00.000Z [INFO] [daemon] control socket up'
check('a line that already leads with an ISO is not stamped twice', stampDaemonLogLine(already) === already, stampDaemonLogLine(already) + ' — stampDaemonLogLine in src/daemon/control/daemonLogStamp.ts (ISO_LINE_START) must leave a line that already starts with an ISO alone')
const engage = stampDaemonLogLine('[mercury-daemon] engaged v1.0.0 pid 4242 dir /work')
check('the engage line leads with the stamp and keeps its whole text after it', ISO.test(engage) && engage.endsWith('[mercury-daemon] engaged v1.0.0 pid 4242 dir /work'), engage + ' — stampDaemonLogLine in src/daemon/control/daemonLogStamp.ts must stamp the engage line and keep its text')

section('§2 the wrapper: console.error the daemon writes is stamped once installed')
const captured: string[] = []
const realError = console.error
console.error = ((...a: unknown[]): void => {
  captured.push(a.map(x => (typeof x === 'string' ? x : String(x))).join(' '))
}) as typeof console.error
installStampedDaemonLog()
console.error('[daemon] restart armed by screen 1 — re-executes as the deployed build when the 2 live worker(s) finish')
console.error = realError
check('the wrapped console.error stamped the daemon line', captured.length === 1 && ISO.test(captured[0]!), (captured[0] ?? '(nothing captured)') + ' — installStampedDaemonLog in src/daemon/control/daemonLogStamp.ts must wrap console.error to stamp each line once')
check('…and the daemon text survives the stamp', (captured[0] ?? '').includes('[daemon] restart armed by screen 1'), 'installStampedDaemonLog in src/daemon/control/daemonLogStamp.ts must pass the daemon text through the stamp')


console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
