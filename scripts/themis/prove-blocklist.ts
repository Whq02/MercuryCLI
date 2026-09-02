#!/usr/bin/env bun
// prove-blocklist — the attack-shape regex set, positively AND negatively.
//
//   §1 POSITIVE conformance: every BLOCKLIST entry has a POSITIVE_SAMPLES
//      fixture that fires it — and fires *that exact id* (first-match).
//   §2 NEGATIVE conformance: every documented benign near-miss stays clear
//      (a false positive would silently break a legitimate operator command).
//   §3 PURITY: checkBlocklist never throws on hostile input shapes and never
//      touches the filesystem (no .claude/themis creation from a pure check).
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { BLOCKLIST, NEGATIVE_SAMPLES, POSITIVE_SAMPLES, checkBlocklist } = await import(
  '../../src/substrate/themis/blocklist.ts'
)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section('§1 positive conformance: every entry fires on its documented sample')
check('every BLOCKLIST id has a positive sample', BLOCKLIST.every(e => POSITIVE_SAMPLES.some(s => s.id === e.id)),
  `entries=${BLOCKLIST.length} samples=${POSITIVE_SAMPLES.length}`)
for (const s of POSITIVE_SAMPLES) {
  const hit = checkBlocklist(s.toolName, s.input)
  check(`${s.id} fires`, hit !== null && hit.id === s.id, hit ? `hit ${hit.id}` : 'no hit')
}

section('§2 negative conformance: benign near-misses stay clear')
for (const s of NEGATIVE_SAMPLES) {
  const hit = checkBlocklist(s.toolName, s.input)
  const label = String((s.input as { command?: string; file_path?: string }).command ?? (s.input as { file_path?: string }).file_path)
  check(`clear: ${label.slice(0, 56)}`, hit === null, hit ? `FALSE POSITIVE ${hit.id}` : '')
}

section('§3 purity: hostile shapes, no fs writes')
const scratch = mkdtempSync(join(tmpdir(), 'themis-bl-'))
process.chdir(scratch)
process.env.MERCURY_THEMIS = 'enforce'
check('null input', checkBlocklist('Bash', null) === null)
check('undefined input', checkBlocklist('Bash', undefined) === null)
check('non-string command', checkBlocklist('Bash', { command: 42 as unknown as string }) === null)
check('huge input does not throw', (() => {
  try {
    checkBlocklist('Bash', { command: 'a'.repeat(1_000_000) })
    return true
  } catch {
    return false
  }
})())
check('pure check created no themis dir in ANY home', !['.mercury', '.claude'].some(h => existsSync(join(scratch, h, 'themis'))))
delete process.env.MERCURY_THEMIS

console.log('\n' + '═'.repeat(76))
if (failures) {
  console.log(`❌ ${failures} BLOCKLIST PROOF FAILURE(S)`)
  process.exit(1)
}
console.log('✅ ALL BLOCKLIST PROOFS PASS')
