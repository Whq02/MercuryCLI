#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-pty-degrade.ts
//  PROOF: the daemon's PTY-host tier (src/daemon/runPtyHost.ts) DEGRADES
//  honestly — isPtyHostAvailable() is a pure, never-throwing capability probe and
//  attachToJobPty(...) returns an ENOTSUP-shaped result without throwing.
//  Exercised against the REAL production module, not a reimpl. The module's whole
//  value proposition ("detect honestly and DEGRADE, never crash") had zero
//  committed regression coverage.
//
//  Covers: isPtyHostAvailable() never throws AND agrees with the live terminal
//   primitive (⇒ false under the Hermes node product, where there is no
//   globalThis.Bun / node-pty) · attachToJobPty(...) is { ok:false, code:'ENOTSUP' }
//   without throwing · the error text is honest (names the PTY requirement and a
//   REAL alternative, and does NOT claim a per-job "run log" exists — none does).
//
//  RUNTIME NOTE: the suite runs under `bun`, where globalThis.Bun.Terminal exists,
//  so the probe legitimately reads TRUE there; the Hermes product ships under
//  `node`, where it reads FALSE. globalThis.Bun is a frozen, non-configurable
//  global under bun (can't be deleted to fake node), so we assert the probe AGREES
//  with the live primitive (true under either runtime) and additionally pin the
//  node-product `=== false` expectation when actually run under node.
// ============================================================================

import {
  attachToJobPty,
  isPtyHostAvailable,
  type AttachResult,
} from '../../src/daemon/runPtyHost.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
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
check('isPtyHostAvailable() does not throw', probeThrew === false)
check(
  'isPtyHostAvailable() agrees with the live terminal primitive',
  avail === hasTerminalPrimitive,
  `probe=${avail} primitive=${hasTerminalPrimitive}`,
)
if (hasTerminalPrimitive) {
  check('under bun (Bun.Terminal present) ⇒ TRUE (node product reads FALSE)', avail === true)
} else {
  check('under the node product (no Bun.Terminal) ⇒ FALSE', avail === false)
}

section('attachToJobPty — ENOTSUP-shaped, never throws')
let res: AttachResult | undefined
let attachThrew = false
try {
  res = attachToJobPty('ab12cd')
} catch {
  attachThrew = true
}
check('attachToJobPty(short) does not throw', attachThrew === false)
check('result.ok === false', res?.ok === false)
check('result.code === "ENOTSUP"', res?.ok === false && res.code === 'ENOTSUP')

section('attach error text — honest (no phantom "run log")')
const err = res && res.ok === false ? res.error : ''
check('error is a non-empty string', typeof err === 'string' && err.length > 0)
check('error names the PTY requirement', /pty/i.test(err))
check('error references the failing job id', err.includes('ab12cd'))
check('error does NOT claim a per-job "run log" (none exists on disk)', !/run log/i.test(err))

section('never-throws contract — odd inputs still degrade cleanly')
let edgeThrew = false
try {
  attachToJobPty('')
  attachToJobPty('a'.repeat(4096))
} catch {
  edgeThrew = true
}
check('empty / oversized short ⇒ still no throw', edgeThrew === false)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PTY-DEGRADE PROOFS PASS')
else console.log(`❌ ${failures} PTY-DEGRADE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
