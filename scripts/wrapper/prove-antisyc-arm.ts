#!/usr/bin/env bun

import { join } from 'node:path'
import { getAntiSycophancyAlwaysOnSection } from '../../src/engine/system-prompt/antiSycophancy.js'
import { lintWeakeners } from '../../src/engine/system-prompt/behaviourContract.js'

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

let fail = 0
const ANTISYC_FAIL_HINT = 'to fix: getAntiSycophancyAlwaysOnSection in src/engine/system-prompt/antiSycophancy.ts (it must return [] unless the version stamp is set and MERCURY_ANTISYC_ALWAYS_ON is exactly 1, re-read on every call, and otherwise return one honesty-discipline clause with the wording checked here); the weakener lint is lintWeakeners in src/engine/system-prompt/behaviourContract.ts'
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ' — ' + (detail ? detail + ' — ' : '') + ANTISYC_FAIL_HINT : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

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
  check('the lever runs under the evidence condition: recorded evidence that still applies is the check; recheck on change, gap or contradiction; memory is not verification', /recorded evidence that still applies to the current state is that check/.test(clause) && /relevant state changed, evidence is missing or stale, or new evidence contradicts it/.test(clause) && /Memory alone is not verification/.test(clause))
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
