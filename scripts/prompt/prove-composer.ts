#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'composer-home-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { composeSystemPrompt } from '../../src/prompt/composer.js'
import {
  readPromptProvenance,
  __resetPromptProvenanceForTest,
} from '../../src/utils/cockpit/promptProvenance.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const SRC = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

console.log('============================================================')
console.log(' composer contract and configuration absence')
console.log('============================================================')

section('(1) composer — group order, null filtering, reconcile-last')
{
  __resetPromptProvenanceForTest()
  const out = composeSystemPrompt({
    staticSections: ['intro', null, 'tone'],
    dynamicBoundary: [],
    dynamicSpecs: [
      { name: 'memory', cacheBreak: false },
      { name: 'mcp', cacheBreak: true },
      { name: 'absent', cacheBreak: false },
    ],
    dynamicResolved: ['MEM', 'MCP', null],
    wrapperSections: [{ name: 'identity-floor', text: 'WRAP' }],
    modeSections: [{ name: 'mode-autopilot', text: 'MODE' }],
    antiSycSections: [],
    reconcileTailSections: ['RECONCILE'],
  })
  check('null static + null dynamic filtered, order preserved',
    JSON.stringify(out) === JSON.stringify(['intro', 'tone', 'MEM', 'MCP', 'WRAP', 'MODE', 'RECONCILE']))
  check('reconcile tail is the LAST segment (#9 contract)', out[out.length - 1] === 'RECONCILE')

  const boundary = composeSystemPrompt({
    staticSections: ['s'],
    dynamicBoundary: ['<<BOUNDARY>>'],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [],
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
  })
  check('boundary marker sits between static and dynamic', boundary[1] === '<<BOUNDARY>>')

  __resetPromptProvenanceForTest()
  const scoped = composeSystemPrompt({
    staticSections: ['s'],
    dynamicBoundary: [],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [
      { name: 'identity-floor', text: 'FLOOR' },
      { name: 'mercury-doctrine', text: 'DOCTRINE' },
    ],
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
  })
  check('the one-content law: every wrapper section rides the composition',
    JSON.stringify(scoped) === JSON.stringify(['s', 'FLOOR', 'DOCTRINE']))
}

section('(2) provenance shape-parity — the recorder cannot drift')
{
  __resetPromptProvenanceForTest()
  composeSystemPrompt({
    staticSections: ['a', 'b'],
    dynamicBoundary: [],
    dynamicSpecs: [
      { name: 'x', cacheBreak: true },
      { name: 'gone', cacheBreak: false },
    ],
    dynamicResolved: ['XX', null],
    wrapperSections: [
      { name: 'identity-floor', text: 'w1' },
      { name: 'mercury-doctrine', text: 'w2' },
    ],
    modeSections: [{ name: 'mode-autopilot', text: 'm' }],
    antiSycSections: ['anti'],
    reconcileTailSections: ['r'],
  })
  const prov = readPromptProvenance()
  check('provenance recorded', prov !== null)
  check('segment count matches composition', prov?.segmentCount === 8)
  check('typed sections carry semantic names (no positional ids)',
    prov?.sections.every(s => !/^wrapper-\d+$|^mode-\d+$/.test(s.name)) === true)
  const dyn = prov?.sections.find(s => s.name === 'x')
  check('dynamic entry carries scope/owner/cacheClass/chars/sha8',
    dyn?.group === 'dynamic' && dyn.chars === 2 && dyn.cacheClass === 'turn' && typeof dyn.owner === 'string' && /^[0-9a-f]{8}$/.test(dyn.sha8))
  check('absent dynamic section recorded with a reason',
    prov?.absent.some(a => a.name === 'gone' && a.reason.length > 0) === true)
  check('wrapper sections named identity-floor + mercury-doctrine',
    prov?.sections.filter(s => s.group === 'wrapper').map(s => s.name).join(',') === 'identity-floor,mercury-doctrine')
  check('mode section named mode-autopilot', prov?.sections.some(s => s.group === 'mode' && s.name === 'mode-autopilot') === true)
  check('contract digest recorded (bc1-)', typeof prov?.digest === 'string' && prov.digest.startsWith('bc1-'))
  check('total chars accounted', prov?.totalChars === 'ab'.length + 'XX'.length + 'w1w2'.length + 'm'.length + 'anti'.length + 'r'.length)
  composeSystemPrompt({
    staticSections: ['a'],
    dynamicBoundary: [],
    dynamicSpecs: [],
    dynamicResolved: [],
    wrapperSections: [],
    modeSections: [],
    antiSycSections: [],
    reconcileTailSections: [],
  })
  const prov2 = readPromptProvenance()
  check('previous composition totals retained (before/after)',
    prov2?.previous?.totalChars === prov?.totalChars && prov2?.previous?.digest === prov?.digest)
  const prompts = SRC('src/constants/prompts.ts')
  check('prompts.ts composes via the owned composer (no inline recorder)',
    prompts.includes('composeSystemPrompt({') && !prompts.includes('recordPromptComposition({'))
}

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL COMPOSER CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
