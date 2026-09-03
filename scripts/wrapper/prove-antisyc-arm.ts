#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAntiSycophancyAlwaysOnSection } from '../../src/utils/antiSycophancy.js'
import { lintWeakeners } from '../../src/prompt/behaviourContract.js'

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const src = (...p: string[]): string =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Always-on anti-sycophancy arm — default-OFF flag-gated ship')
console.log('============================================================')

section('(a) default-OFF ⇒ [] — no behavioral default changed')
{
  setStamp(false)
  delete process.env.MERCURY_ANTISYC_ALWAYS_ON
  check('bare-stamp ⇒ []', getAntiSycophancyAlwaysOnSection().length === 0)
  setStamp(true)
  check('fork + env unset ⇒ []', getAntiSycophancyAlwaysOnSection().length === 0)
  process.env.MERCURY_ANTISYC_ALWAYS_ON = '0'
  check('fork + env "0" ⇒ []', getAntiSycophancyAlwaysOnSection().length === 0)
  process.env.MERCURY_ANTISYC_ALWAYS_ON = 'true'
  check('fork + env "true" (only "1" opts in) ⇒ []', getAntiSycophancyAlwaysOnSection().length === 0)
  delete process.env.MERCURY_ANTISYC_ALWAYS_ON
}

section('(b) opt-in (MERCURY_ANTISYC_ALWAYS_ON=1) ⇒ the mechanistic clause')
{
  setStamp(true)
  process.env.MERCURY_ANTISYC_ALWAYS_ON = '1'
  const s = getAntiSycophancyAlwaysOnSection()
  check('returns exactly one section', s.length === 1)
  const clause = s[0] ?? ''
  check('it is the mechanistic convert-to-verify lever (not a bare "be honest")', /convert it into a verifying check/i.test(clause) && /earned by evidence, not offered as a reflex/i.test(clause))
  check('it is positioned as ADDITIVE — sharpens, never softens, disagreement', /sharpens — never softens/i.test(clause) && /honest disagreement/i.test(clause))
  check('it carries an <honesty-discipline> tag (a distinct, greppable section)', clause.includes('<honesty-discipline>'))
}

section('(c) live env re-read — toggling off mid-session truly disengages')
{
  setStamp(true)
  process.env.MERCURY_ANTISYC_ALWAYS_ON = '1'
  check('ON now', getAntiSycophancyAlwaysOnSection().length === 1)
  process.env.MERCURY_ANTISYC_ALWAYS_ON = '0'
  check('flip to "0" same process ⇒ [] (gate is not a cached const)', getAntiSycophancyAlwaysOnSection().length === 0)
  delete process.env.MERCURY_ANTISYC_ALWAYS_ON
}

section('(d) weakener-lint — the clause STRENGTHENS, never weakens, the honesty floor')
{
  setStamp(true)
  process.env.MERCURY_ANTISYC_ALWAYS_ON = '1'
  const clause = getAntiSycophancyAlwaysOnSection()[0] ?? ''
  const weak = lintWeakeners(clause)
  check('lintWeakeners finds NO floor-weakener in the clause', weak.length === 0, weak.join('; '))
  const SOFTENERS = [/skip (the )?verif/i, /don.?t bother (checking|verifying)/i, /no need to (test|verify)/i, /bypass the gate/i, /assume it works/i, /just agree/i]
  check('no softener phrase present (the ab-honesty WEAKENERS shape)', !SOFTENERS.some(re => re.test(clause)))
  delete process.env.MERCURY_ANTISYC_ALWAYS_ON
}

section('(e) getSystemPrompt wiring — spliced after the wrapper, reconcile-tail aware, OFF []-safe')
{
  const p = src('constants', 'prompts.ts')
  check('imports the section function', p.includes("import { getAntiSycophancyAlwaysOnSection } from '../utils/antiSycophancy.js'"))
  check('computes antiSycSections ONCE, frozen per conversation through the section cache (splice + reconcile agree)', p.includes("systemPromptSection('anti-sycophancy', () => {") && p.includes("const antiSycSections = typeof antiSycFrozen === 'string' ? [antiSycFrozen] : []"))
  const composer = src('prompt', 'composer.ts')
  check(
    'prompts.ts hands modeSections + antiSycSections to the owned composer',
    /composeSystemPrompt\(\{[\s\S]{0,900}modeSections,[\s\S]{0,200}antiSycSections,/.test(p),
  )
  const behaviourContract = src('prompt', 'behaviourContract.ts')
  check(
    'composer orders ...modeSections → ...antiSycSections → ...reconcileTail',
    /parts\.modeSections\)[\s\S]{0,600}parts\.antiSycSections\.forEach[\s\S]{0,600}parts\.reconcileTailSections\.forEach/.test(
      behaviourContract,
    ) && /renderAnthropicSections\(contract\)/.test(composer),
  )
  check('reconcile-tail re-emits identity when the arm (or a mode) is engaged', /modeSections\.length > 0 \|\| antiSycSections\.length > 0/.test(p))
  const md = src('utils', 'antiSycophancy.ts')
  check('the section module does NOT read/import the bridge .txt (pure constant + gate)', !md.includes('readFileSync') && !md.includes('require(') && !/import[^\n]*append/.test(md))
}

section('(f) sole carrier — the arm answers on its own gate alone')
{
  setStamp(true)
  process.env.MERCURY_ANTISYC_ALWAYS_ON = '1'
  check('armed ⇒ the clause is present', getAntiSycophancyAlwaysOnSection().length === 1)
  delete process.env.MERCURY_ANTISYC_ALWAYS_ON
}

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL ANTI-SYCOPHANCY-ARM PROOFS PASS')
else console.log(`❌ ${fail} ANTI-SYCOPHANCY-ARM PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)
