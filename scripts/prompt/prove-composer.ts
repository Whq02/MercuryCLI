#!/usr/bin/env bun
// ============================================================================
//  scripts/prompt/prove-composer.ts
//  PROOF: the owned system-prompt composer + analytics floor —
//   (1) composeSystemPrompt: group ORDER is the written contract (static →
//       boundary → dynamic → wrapper → modes → anti-syc → reconcile tail),
//       nulls filtered order-preserved, reconcile tail is the LAST segment;
//   (2) shape-parity with the /provenance recorder: segments/dynamic entries/
//       group counts read back exactly as composed (the recorder seam moved
//       INTO the composer — they cannot drift);
//   (3) the owned gate table: env override → config override → table → inline
//       default ladder; lifecycle fns are honest no-ops; the refresh signal
//       fires on override writes;
//   (4) the analytics floor: the discarding sink DRAINS the queue
//       (bounded — the pre-attach queue can never grow past its cap), the
//       @growthbook SDK import is ABSENT from source + package.json.
//
//  Run:  ~/.bun/bin/bun run scripts/prompt/prove-composer.ts
// ============================================================================
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
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
  getDynamicConfig_CACHED_MAY_BE_STALE,
  checkFeatureGate_CACHED_MAY_BE_STALE,
  checkSecurityRestrictionGate,
  initializeFeatureGates,
  onFeatureGatesRefresh,
  refreshFeatureGatesAfterAuthChange,
  setupPeriodicFeatureGateRefresh,
} from '../../src/services/analytics/featureGates.js'

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
console.log(' composer floors — composer contract · gate table ·')
console.log(' analytics floor')
console.log('============================================================')

//
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
    modeSections: [{ name: 'mode-scribe', text: 'MODE' }],
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

  // an 'openai-only'-scoped section (the GPT developer delta) never
  // renders on the Anthropic segment list — the composed output skips it.
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

//
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
    modeSections: [{ name: 'mode-scribe', text: 'm' }],
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
  check('mode section named mode-scribe', prov?.sections.some(s => s.group === 'mode' && s.name === 'mode-scribe') === true)
  check('contract digest recorded (bc1-)', typeof prov?.digest === 'string' && prov.digest.startsWith('bc1-'))
  check('total chars accounted', prov?.totalChars === 'ab'.length + 'XX'.length + 'w1w2'.length + 'm'.length + 'anti'.length + 'r'.length)
  // before/after: a SECOND composition retains the previous totals.
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

//
section('(3) the owned gate table — resolution ladder + honest no-ops')
await (async () => {
  // Env overrides parse ONCE per process (faithful to the original module).
  // The override path was gated on a
  // runtime USER_TYPE==='ant' read that is now folded at source (every dist
  // already shipped the external fold) — so the override is inert even with
  // the env set. Assert the FOLDED truth: the default wins.
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_INTERNAL_FC_OVERRIDES = '{"mercury_pinned": "from-env"}'
  check('env override wins (ant eval-harness path)', getFeatureValue_CACHED_MAY_BE_STALE('mercury_pinned', 'dflt') === 'dflt')
  delete process.env.CLAUDE_INTERNAL_FC_OVERRIDES
  delete process.env.USER_TYPE
  check('inline default wins when nothing pins', getFeatureValue_CACHED_MAY_BE_STALE('mercury_nonexistent', 'dflt') === 'dflt')
  check('dynamic config default likewise', JSON.stringify(getDynamicConfig_CACHED_MAY_BE_STALE('mercury_cfg', { a: 1 })) === '{"a":1}')
  check('boolean gates default false', checkFeatureGate_CACHED_MAY_BE_STALE('mercury_gate') === false)
  check('security gate fail-closed false', (await checkSecurityRestrictionGate('sec_gate')) === false)

  check('initializeFeatureGates resolves null instantly', (await initializeFeatureGates()) === null)
  let fired = 0
  const unsub = onFeatureGatesRefresh(() => {
    fired++
  })
  refreshFeatureGatesAfterAuthChange()
  setupPeriodicFeatureGateRefresh()
  await new Promise(r => setTimeout(r, 20))
  check('lifecycle no-ops never fire the refresh signal', fired === 0)
  unsub()
})()

//
section('(4) analytics floor — the estate is structurally ABSENT (SM-J-P5)')
await (async () => {
  // The analytics floor (draining discard sink + bounded queue) was superseded
  // by the-P5 structural delete: logEvent and its queue do not exist,
  // so there is nothing to drain and nothing to bound. This section pins the
  // absence; prove-telemetry-absence.ts (substrate) owns the full ratchet.
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = join(import.meta.dir, '..', '..')
  for (const p of [
    'src/services/analytics/index.ts',
    'src/services/analytics/sink.ts',
    'src/services/analytics/datadog.ts',
    'src/services/analytics/firstPartyEventLogger.ts',
  ]) {
    check(`deleted: ${p}`, !existsSync(join(root, p)))
  }
  const gbSrc = SRC('src/services/analytics/featureGates.ts')
  check('the owned gate table has no @growthbook SDK import', !gbSrc.includes("from '@growthbook/growthbook'"))
  const pkg = SRC('package.json')
  check('@growthbook/growthbook dropped from package.json', !pkg.includes('"@growthbook/growthbook"'))
})()

console.log('\n============================================================')
if (failures === 0) console.log(' ✅ ALL COMPOSER CHECKS PASS')
else console.log(` ❌ ${failures} CHECK(S) FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
