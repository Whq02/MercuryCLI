#!/usr/bin/env bun
import { join } from 'node:path'
const J = (...parts: string[]): string => parts.join('')

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} · ` : ''}fix getMercuryContractSections and MERCURY_CONSTITUTION in src/engine/system-prompt/mercuryContract.ts, composeSystemPrompt in src/engine/system-prompt/composer.ts, or buildBehaviourContract in src/engine/system-prompt/behaviourContract.ts` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' behaviour law 1 — repository-owned contract')
console.log('============================================================')


section('§2 ungated — no flag drops the constitution; the contract sections carry no identity or doctrine')
{
  const contract = await import('../../src/engine/system-prompt/mercuryContract.ts')
  const sections = contract.getMercuryContractSections()
  check('the contract sections carry no identity or doctrine section', sections.every(s => s.name !== J('identity', '-floor') && s.name !== J('mercury', '-doctrine') && !/You are/.test(s.text)))
  check('the constitution is one constant, byte-stable across reads', contract.MERCURY_CONSTITUTION === (await import('../../src/engine/system-prompt/mercuryContract.ts')).MERCURY_CONSTITUTION && contract.MERCURY_CONSTITUTION.length > 0)
}

section('§3 byte-stability — identical stable inputs ⇒ identical bytes + digest')
{
  const { composeSystemPrompt } = await import('../../src/engine/system-prompt/composer.ts')
  const { buildBehaviourContract } = await import('../../src/engine/system-prompt/behaviourContract.ts')
  const { getMercuryContractSections } = await import('../../src/engine/system-prompt/mercuryContract.ts')
  const parts = () => ({
    staticSections: ['head', 'law'],
    dynamicBoundary: [],
    dynamicSpecs: [{ name: 'memory', cacheBreak: false }],
    dynamicResolved: ['MEM'],
    wrapperSections: getMercuryContractSections(),
    modeSections: [],
    antiSycSections: [],
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
