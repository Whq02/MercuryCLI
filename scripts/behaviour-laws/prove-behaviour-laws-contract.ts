#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' behaviour law 1 — repository-owned contract')
console.log('============================================================')

section('§1 ownership — one repository owner')
{
  const mod = readFileSync(join(ROOT, 'src/prompt/mercuryContract.ts'), 'utf8')
  check('mercuryContract.ts owns floor + doctrine + reconcile',
    mod.includes('MERCURY_IDENTITY_FLOOR') && mod.includes('MERCURY_DOCTRINE') && mod.includes('MERCURY_IDENTITY_RECONCILE'))
  check('no external text import (repository-owned bytes only)', !/require\(|from '[^']*\.txt'/.test(mod))
}

section('§2 gate — the doctrine opt-out never drops the floor')
{
  delete process.env.MERCURY_WRAPPER_APPEND
  const contract = await import('../../src/prompt/mercuryContract.ts')
  const on = contract.getMercuryContractSections()
  check('doctrine ON by default', on.some(s => s.name === 'mercury-doctrine'))
  process.env.MERCURY_WRAPPER_APPEND = '0'
  const off = contract.getMercuryContractSections()
  check('=0 drops exactly the doctrine section', !off.some(s => s.name === 'mercury-doctrine') && off.length === on.length - 1)
  check('the identity floor survives the opt-out', off[0]?.name === 'identity-floor')
  delete process.env.MERCURY_WRAPPER_APPEND
}

section('§3 byte-stability — identical stable inputs ⇒ identical bytes + digest')
{
  const { composeSystemPrompt } = await import('../../src/prompt/composer.ts')
  const { buildBehaviourContract } = await import('../../src/prompt/behaviourContract.ts')
  const { getMercuryContractSections } = await import('../../src/prompt/mercuryContract.ts')
  const parts = () => ({
    staticSections: ['intro', 'system'],
    dynamicBoundary: [],
    dynamicSpecs: [{ name: 'memory', cacheBreak: false }],
    dynamicResolved: ['MEM'],
    wrapperSections: getMercuryContractSections(),
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
  })
  const a = composeSystemPrompt(parts())
  const b = composeSystemPrompt(parts())
  check('composed bytes identical across rebuilds', JSON.stringify(a) === JSON.stringify(b))
  const da = buildBehaviourContract(parts()).digest
  const db = buildBehaviourContract(parts()).digest
  check('contract digest identical across rebuilds', da === db && da.startsWith('bc1-'))
  const names = buildBehaviourContract(parts()).sections.map(s => s.name)
  check('every section name is semantic (no positional ids)', names.every(n => !/^(wrapper|mode|static|dynamic)-\d+$/.test(n)), names.join(','))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ BEHAVIOUR LAW 1 (repository-owned contract) PASSES')
else console.log(`❌ ${failures} LAW-1 CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
