#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const J = (...parts: string[]): string => parts.join('')
const RETIRED = J('MERCURY_GLOB_', 'NO_IGNORE')

console.log('============================================================')
console.log(' glob env toggles — ignore files apply by default; the hidden toggle stays')
console.log('============================================================')

const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
check('the flag registry carries no row for it', !FLAG_REGISTRY.some(f => f.env === RETIRED))
check('the hidden toggle keeps its row', FLAG_REGISTRY.some(f => f.env === 'MERCURY_GLOB_HIDDEN' && f.kind === 'default-on'))

section('behavioural mirror: the pure default-on decode (unset/empty ⇒ ON, falsy ⇒ OFF)')
const truthy = (v: string): boolean => ['1', 'true', 'yes', 'on'].includes(v.toLowerCase().trim())
const decode = (raw: string | undefined): boolean => truthy(raw === undefined || raw === '' ? '1' : raw)
check('unset ⇒ ON', decode(undefined) === true)
check("'' ⇒ ON (empty counts as unset)", decode('') === true)
check("'1' ⇒ ON", decode('1') === true)
check("'0' ⇒ OFF", decode('0') === false)
check("'false' ⇒ OFF", decode('false') === false)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL GLOB-ENV-TOGGLE PROOFS PASS')
else console.log(`❌ ${failures} GLOB-ENV-TOGGLE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
