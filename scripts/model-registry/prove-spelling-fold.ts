#!/usr/bin/env bun
// ============================================================================
//  scripts/model-registry/prove-spelling-fold.ts — THE HUMAN-SPELLING FOLD
//  (AGENTDIALS C2): "sonnet 5" burned a whole coordinator round-trip while
//  the coordinator itself knew claude-sonnet-5. The fold resolves
//  case/whitespace/hyphen/dot variants against the CATALOGUE's ids AND
//  display names — derived, provider-equal, zero alias tables, exact after
//  the fold, no fuzzy-distance guessing — and ONLY where the road already
//  refused (recognizeModelId 'unrecognised'), so every working spelling is
//  byte-identical by construction.
//
//   §1 the fold, injected (hermetic, provider-equal — anthropic/gpt/glm
//      rows treated by ONE mechanism; sentinels and modes never match;
//      ambiguity refuses).
//   §2 the one normalizer, live (spaced/cased/hyphened spellings resolve;
//      the [1m] rider survives; unknown still refuses; recognised ids
//      pass through byte-identical — the canonical-parity controls).
//   §3 the coordinator door, driven (canonicalWorkerModelId resolves the
//      spoken spelling; the unrecognised refusal names DERIVED example
//      spellings, never a hardcoded family list).
//
//  Run:  ~/.bun/bin/bun run scripts/model-registry/prove-spelling-fold.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'spelling-fold-proof-'))
delete process.env.ANTHROPIC_MODEL
delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { foldModelSpelling, resolveCatalogueSpelling, catalogueSpellingExamples } = await import(
  '../../src/utils/model/modelSpellingFold.ts'
)
const { parseUserSpecifiedModel, parseUserSpecifiedModelRaw } = await import('../../src/utils/model/model.ts')
import type { ModelOption } from '../../src/utils/model/modelOptions.ts'

// ── §1 the fold, injected ───────────────────────────────────────────────────
console.log('§1 the fold over an injected provider-equal catalogue')
const cat: ModelOption[] = [
  { value: null, label: 'Recommended', description: 'the default row never folds' },
  { value: 'sonnet', label: 'Sonnet 5', description: '' },
  { value: 'sonnet[1m]', label: 'Sonnet 5 (1M context)', description: 'the suffixed twin collapses' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', description: 'dots meet hyphens' },
  { value: 'gpt-5', label: 'GPT-5', description: '', group: 'GPT' },
  { value: 'glm-4.7', label: 'GLM-4.7', description: '', group: 'Z.AI' },
  { value: '__hermes_gpt_connect__', label: 'Connect GPT', description: 'a door, not a model', group: 'GPT' },
  { value: '__router_mode__', label: 'Router', description: 'a mode, not a model', group: 'Modes' },
]
const sonnetTarget = parseUserSpecifiedModelRaw('sonnet')
check("'sonnet 5' resolves where 'sonnet5' does (label fold)", resolveCatalogueSpelling('sonnet 5', cat) === sonnetTarget, String(resolveCatalogueSpelling('sonnet 5', cat)))
check("'Sonnet-5' resolves (case + hyphen fold)", resolveCatalogueSpelling('Sonnet-5', cat) === sonnetTarget)
check("'SONNET5' resolves (case fold)", resolveCatalogueSpelling('SONNET5', cat) === sonnetTarget)
check("'opus 4.6' meets claude-opus-4-6 (dot ↔ hyphen, via the label)", resolveCatalogueSpelling('opus 4.6', cat) === 'claude-opus-4-6')
check("'opus-4-6' meets claude-opus-4-6 too", resolveCatalogueSpelling('opus-4-6', cat) === 'claude-opus-4-6')
check("'gpt 5' resolves in the gpt rows the SAME way (provider-equal)", resolveCatalogueSpelling('gpt 5', cat) === 'gpt-5')
check("'GPT5' resolves", resolveCatalogueSpelling('GPT5', cat) === 'gpt-5')
check("'glm 4.7' resolves in the Z.AI rows", resolveCatalogueSpelling('glm 4.7', cat) === 'glm-4.7')
check("the suffixed twin collapsed onto the bare id (no [1m] leak)", resolveCatalogueSpelling('sonnet 5 (1m context)', cat) === sonnetTarget)
check("an unknown name answers null", resolveCatalogueSpelling('flurble 9000', cat) === null)
check("a connect sentinel never matches", resolveCatalogueSpelling('connect gpt', cat) === null)
check("a mode row never matches", resolveCatalogueSpelling('router', cat) === null)
const ambiguous: ModelOption[] = [
  { value: 'vendor-a/thing-1', label: 'Thing 1', description: '' },
  { value: 'vendor-b/thing1', label: 'Thing 1', description: '' },
]
check('an ambiguous fold (two distinct targets, one key) refuses with null', resolveCatalogueSpelling('thing 1', ambiguous) === null)
check('foldModelSpelling never touches brackets (a rider stays distinct)', foldModelSpelling('sonnet[1m]') === 'sonnet[1m]')
const examples = catalogueSpellingExamples(3, cat)
check('examples derive from the catalogue in its own order, distinct by target', examples.length === 3 && examples[0] === 'Sonnet 5' && examples[1] === 'Opus 4.6' && examples[2] === 'GPT-5', examples.join(' · '))

// ── §2 the one normalizer, live ─────────────────────────────────────────────
console.log('\n§2 the normalizer (live catalogue)')
const spoken = parseUserSpecifiedModel('sonnet 5')
check("'sonnet 5' resolves at parseUserSpecifiedModel (never a pass-through)", spoken === parseUserSpecifiedModel('sonnet5') && spoken !== 'sonnet 5', spoken)
check("'Sonnet-5' resolves identically", parseUserSpecifiedModel('Sonnet-5') === spoken)
check("the [1m] rider survives the fold", parseUserSpecifiedModel('sonnet 5[1m]') === parseUserSpecifiedModel('sonnet[1m]'), parseUserSpecifiedModel('sonnet 5[1m]'))
check("…including with a space before the rider", parseUserSpecifiedModel('Sonnet 5 [1m]') === parseUserSpecifiedModel('sonnet[1m]'))
check('a genuinely unknown name still passes through (the route law refuses downstream)', parseUserSpecifiedModel('flurble-9000') === 'flurble-9000')
check('canonical parity: a first-party id is byte-identical', parseUserSpecifiedModel('claude-sonnet-5') === 'claude-sonnet-5')
check('canonical parity: a declared engine id is byte-identical', parseUserSpecifiedModel('gpt-5.2') === 'gpt-5.2')
check('canonical parity: a carrier id is byte-identical', parseUserSpecifiedModel('openrouter/anthropic/claude-opus-5') === 'openrouter/anthropic/claude-opus-5')
check("the alias switch is untouched ('opusplan' → the mid model)", parseUserSpecifiedModel('opusplan') === parseUserSpecifiedModelRaw('opusplan'))

// §2b the source law: the rung is GATED on recognizeModelId — the
// zero-regression construction, pinned as source truth.
const modelSrc = readFileSync('src/utils/model/model.ts', 'utf8')
check(
  "the fold rung is gated on recognizeModelId 'unrecognised' AND the catalogueFold arm",
  modelSrc.includes("catalogueFold && recognizeModelId(bare).kind === 'unrecognised'"),
)
const foldSrc = readFileSync('src/utils/model/modelSpellingFold.ts', 'utf8')
const foldCode = foldSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
check(
  'the fold module carries ZERO family literals in code (catalogue-derived, provider-equal)',
  !/['"`](claude-|gpt-|glm-|sonnet|opus|haiku|fable|mythos)/i.test(foldCode),
)

// ── §3 the coordinator door, driven ─────────────────────────────────────────
console.log('\n§3 the coordinator door')
const { canonicalWorkerModelId, validateWorkerModelChoice } = await import(
  '../../src/services/concourse/workerModels.ts'
)
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const doorId = await canonicalWorkerModelId('sonnet 5')
check("canonicalWorkerModelId('sonnet 5') lands on the canonical row id", doorId === (await canonicalWorkerModelId('sonnet5')), doorId)
check('…and the route law declares it (never unrecognised at the arms)', declaredRouteOf(doorId) === 'anthropic', String(declaredRouteOf(doorId)))
check("'Sonnet-5' lands identically at the door", (await canonicalWorkerModelId('Sonnet-5')) === doorId)
const refusal = await validateWorkerModelChoice('flurble-9000', 'session')
check('a genuinely unknown launch still refuses, typed', refusal.ok === false && refusal.reason === 'not-runnable:unrecognised')
const liveExamples = catalogueSpellingExamples(3)
check(
  'the refusal action names DERIVED example spellings exactly when the catalogue offers rows',
  refusal.ok === false &&
    (refusal.action ?? '').startsWith('pick a listed row from the model picker') &&
    (liveExamples.length === 0 || ((refusal.action ?? '').includes('spellings like') && (refusal.action ?? '').includes(`'${liveExamples[0]}'`))),
  refusal.ok === false ? (refusal.action ?? '(no action)') : '(unexpected ok)',
)

// ── §4 the -p road takes the fold too (FC-073) ─────────────────────────────
// print.ts's activeModel slot short-circuits every `activeModel ??
// getMainLoopModel()` read, so a RAW flag value there skipped the fold the
// saved-setting road gets: `-p --model "Sonnet 5"` was refused as an id no
// family declares while `settings.model = "Sonnet 5"` ran the turn (both
// legs driven on the built artifact — the differential this section pins
// dead). Every activeModel write now rides the ONE resolver.
{
  console.log('\n§4 the -p road takes the fold too (FC-073)')
  const printSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'print.ts'), 'utf8')
  check(
    'the entry seed folds (call-shaped)',
    /activeModel: string \| undefined =\s*\n\s*options\.userSpecifiedModel === undefined\s*\n\s*\? undefined\s*\n\s*: parseUserSpecifiedModel\(options\.userSpecifiedModel\)/.test(printSrc),
  )
  check(
    'the set_model control folds (call-shaped)',
    /: parseUserSpecifiedModel\(requested\)/.test(printSrc),
  )
  check(
    'the warm-claim write folds (call-shaped)',
    /activeModel = parseUserSpecifiedModel\(claimedModel\)/.test(printSrc),
  )
  const { existsSync } = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — the live leg drives the artifact)', false)
  } else {
    // The card's own repro, live: a picker label on the flag must resolve
    // (reaching AUTH with the fixture token), never refuse as undeclared.
    const home = mkdtempSync(join(tmpdir(), 'fold-p-home-'))
    const run = spawnSync('node', [DIST, '-p', '--model', 'Sonnet 5', 'hi'], {
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: home,
        NODE_ENV: undefined,
        ANTHROPIC_AUTH_TOKEN: 'invalid-fixture-token',
        ANTHROPIC_API_KEY: undefined,
        MERCURY_OAUTH_TOKEN: undefined,
      } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 90000,
    })
    const err = `${run.stderr ?? ''}${run.stdout ?? ''}`
    check(
      "-p --model 'Sonnet 5' resolves through the fold (reaches auth; never 'no family declares')",
      !err.includes('not a model id any provider family declares') && /Authentication|401/i.test(err),
      err.slice(0, 140).replace(/\s+/g, ' '),
    )
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} spelling-fold check(s) failed`)
  process.exit(1)
}
console.log(' ALL SPELLING-FOLD PROOFS PASS')
