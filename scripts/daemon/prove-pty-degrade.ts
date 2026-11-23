#!/usr/bin/env bun

import {
  attachToJobPty,
  isPtyHostAvailable,
  type AttachResult,
} from '../../src/daemon/runner-link/runPtyHost.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const bunGlobal = (globalThis as { Bun?: { Terminal?: unknown } }).Bun
const hasTerminalPrimitive = !!bunGlobal && typeof bunGlobal.Terminal !== 'undefined'

console.log('============================================================')
console.log(' PTY-host tier — graceful-degrade proof')
console.log('============================================================')

section('isPtyHostAvailable — pure probe, never throws, agrees with the primitive')
let avail: boolean | undefined
let probeThrew = false
try {
  avail = isPtyHostAvailable()
} catch {
  probeThrew = true
}
check('isPtyHostAvailable() does not throw', probeThrew === false, '', 'isPtyHostAvailable in src/daemon/runner-link/runPtyHost.ts must return a boolean and catch its own errors')
check(
  'isPtyHostAvailable() agrees with the live terminal primitive',
  avail === hasTerminalPrimitive,
  `probe=${avail} primitive=${hasTerminalPrimitive}`,
  'isPtyHostAvailable in src/daemon/runner-link/runPtyHost.ts must report true exactly when Bun.Terminal exists',
)
if (hasTerminalPrimitive) {
  check('under bun (Bun.Terminal present) ⇒ TRUE (node product reads FALSE)', avail === true, '', 'isPtyHostAvailable in src/daemon/runner-link/runPtyHost.ts must return true when Bun.Terminal is present')
} else {
  check('under the node product (no Bun.Terminal) ⇒ FALSE', avail === false, '', 'isPtyHostAvailable in src/daemon/runner-link/runPtyHost.ts must return false when Bun.Terminal is absent')
}

section('attachToJobPty — ENOTSUP-shaped, never throws')
let res: AttachResult | undefined
let attachThrew = false
try {
  res = attachToJobPty('ab12cd')
} catch {
  attachThrew = true
}
check('attachToJobPty(short) does not throw', attachThrew === false, '', 'attachToJobPty in src/daemon/runner-link/runPtyHost.ts must return an error result instead of throwing')
check('result.ok === false', res?.ok === false, '', 'attachToJobPty in src/daemon/runner-link/runPtyHost.ts must return ok false when no PTY is available')
check('result.code === "ENOTSUP"', res?.ok === false && res.code === 'ENOTSUP', '', 'attachToJobPty in src/daemon/runner-link/runPtyHost.ts must return code ENOTSUP when no PTY is available')

section('attach error text — honest (no phantom "run log")')
const err = res && res.ok === false ? res.error : ''
check('error is a non-empty string', typeof err === 'string' && err.length > 0, '', 'attachToJobPty in src/daemon/runner-link/runPtyHost.ts must return a non-empty error text')
check('error names the PTY requirement', /pty/i.test(err), '', 'the error text from attachToJobPty in src/daemon/runner-link/runPtyHost.ts must name the PTY requirement')
check('error references the failing job id', err.includes('ab12cd'), '', 'the error text from attachToJobPty in src/daemon/runner-link/runPtyHost.ts must include the job id it was given')
check('error does NOT claim a per-job "run log" (none exists on disk)', !/run log/i.test(err), '', 'remove the words run log from the error text of attachToJobPty in src/daemon/runner-link/runPtyHost.ts')

section('never-throws contract — odd inputs still degrade cleanly')
let edgeThrew = false
try {
  attachToJobPty('')
  attachToJobPty('a'.repeat(4096))
} catch {
  edgeThrew = true
}
check('empty / oversized short ⇒ still no throw', edgeThrew === false, '', 'attachToJobPty in src/daemon/runner-link/runPtyHost.ts must not throw on an empty or very long job id')

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PTY-DEGRADE PROOFS PASS')
else console.log(`❌ ${failures} PTY-DEGRADE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
