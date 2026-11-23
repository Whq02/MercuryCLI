#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'spelling-fold-proof-'))
delete process.env.MERCURY_MODEL
delete process.env.MERCURY_DEFAULT_SONNET_MODEL
delete process.env.MERCURY_DEFAULT_OPUS_MODEL

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}

const { foldModelSpelling, resolveCatalogueSpelling, catalogueSpellingExamples } = await import(
  '../../src/models/catalogue/modelSpellingFold.ts'
)
const { parseUserSpecifiedModel, parseUserSpecifiedModelRaw } = await import('../../src/models/catalogue/engineModel.ts')
import type { ModelOption } from '../../src/models/catalogue/modelOptions.ts'
const { GPT_CONNECT_OPTION_VALUE } = await import('../../src/models/catalogue/modelOptions.ts')

console.log('§1 the fold over an injected provider-equal catalogue')
const cat: ModelOption[] = [
  { value: 'sonnet', label: 'Sonnet 5', description: '' },
  { value: 'sonnet[1m]', label: 'Sonnet 5 (1M context)', description: 'the suffixed twin collapses' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', description: 'dots meet hyphens' },
  { value: 'gpt-5', label: 'GPT-5', description: '', group: 'GPT' },
  { value: 'glm-4.7', label: 'GLM-4.7', description: '', group: 'Z.AI' },
  { value: GPT_CONNECT_OPTION_VALUE, label: 'Connect GPT', description: 'a door, not a model', group: 'GPT' },
  { value: '__router_mode__', label: 'Router', description: 'a mode, not a model', group: 'Modes' },
]
const sonnetTarget = parseUserSpecifiedModelRaw('sonnet')
check("'sonnet 5' resolves where 'sonnet5' does (label fold)", resolveCatalogueSpelling('sonnet 5', cat) === sonnetTarget, String(resolveCatalogueSpelling('sonnet 5', cat)), 'fix the label and case fold in resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts')
check("'Sonnet-5' resolves (case + hyphen fold)", resolveCatalogueSpelling('Sonnet-5', cat) === sonnetTarget, '', 'fold case and hyphens in foldModelSpelling in src/models/catalogue/modelSpellingFold.ts')
check("'SONNET5' resolves (case fold)", resolveCatalogueSpelling('SONNET5', cat) === sonnetTarget, '', 'fold case in foldModelSpelling in src/models/catalogue/modelSpellingFold.ts')
check("'opus 4.6' meets claude-opus-4-6 (dot ↔ hyphen, via the label)", resolveCatalogueSpelling('opus 4.6', cat) === 'claude-opus-4-6', '', 'make the fold treat dot and hyphen alike in src/models/catalogue/modelSpellingFold.ts')
check("'opus-4-6' meets claude-opus-4-6 too", resolveCatalogueSpelling('opus-4-6', cat) === 'claude-opus-4-6', '', 'make the fold match the bare id in resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts')
check("'gpt 5' resolves in the gpt rows the SAME way (provider-equal)", resolveCatalogueSpelling('gpt 5', cat) === 'gpt-5', '', 'resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts must not special-case a provider group')
check("'GPT5' resolves", resolveCatalogueSpelling('GPT5', cat) === 'gpt-5', '', 'resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts must not special-case a provider group')
check("'glm 4.7' resolves in the Z.AI rows", resolveCatalogueSpelling('glm 4.7', cat) === 'glm-4.7', '', 'resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts must not special-case a provider group')
check("the suffixed twin collapsed onto the bare id (no [1m] leak)", resolveCatalogueSpelling('sonnet 5 (1m context)', cat) === sonnetTarget, '', 'collapse the suffixed twin onto the bare id in resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts')
check("an unknown name answers null", resolveCatalogueSpelling('flurble 9000', cat) === null, '', 'resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts must return null for a name the catalogue lacks')
check("a connect sentinel never matches", resolveCatalogueSpelling('connect gpt', cat) === null, '', 'skip the connect sentinel row in resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts')
check("a mode row never matches", resolveCatalogueSpelling('router', cat) === null, '', 'skip mode rows in resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts')
const ambiguous: ModelOption[] = [
  { value: 'vendor-a/thing-1', label: 'Thing 1', description: '' },
  { value: 'vendor-b/thing1', label: 'Thing 1', description: '' },
]
check('an ambiguous fold (two distinct targets, one key) refuses with null', resolveCatalogueSpelling('thing 1', ambiguous) === null, '', 'return null when one key reaches two targets in resolveCatalogueSpelling in src/models/catalogue/modelSpellingFold.ts')
check('foldModelSpelling never touches brackets (a rider stays distinct)', foldModelSpelling('sonnet[1m]') === 'sonnet[1m]', '', 'leave brackets untouched in foldModelSpelling in src/models/catalogue/modelSpellingFold.ts')
const examples = catalogueSpellingExamples(3, cat)
check('examples derive from the catalogue in its own order, distinct by target', examples.length === 3 && examples[0] === 'Sonnet 5' && examples[1] === 'Opus 4.6' && examples[2] === 'GPT-5', examples.join(' · '), 'catalogueSpellingExamples in src/models/catalogue/modelSpellingFold.ts must list names in catalogue order, one per distinct target')

console.log('\n§2 the normalizer (live catalogue)')
const spoken = parseUserSpecifiedModel('sonnet 5')
check("'sonnet 5' resolves at parseUserSpecifiedModel (never a pass-through)", spoken === parseUserSpecifiedModel('sonnet5') && spoken !== 'sonnet 5', spoken, 'apply the fold inside parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
check("'Sonnet-5' resolves identically", parseUserSpecifiedModel('Sonnet-5') === spoken, '', 'apply the fold inside parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
check("the [1m] rider survives the fold", parseUserSpecifiedModel('sonnet 5[1m]') === parseUserSpecifiedModel('sonnet5[1m]'), parseUserSpecifiedModel('sonnet 5[1m]'), 'keep the [1m] rider through the fold in parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
check("…including with a space before the rider", parseUserSpecifiedModel('Sonnet 5 [1m]') === parseUserSpecifiedModel('sonnet5[1m]'), '', 'accept a space before the rider in parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
check('a genuinely unknown name still passes through (the route law refuses downstream)', parseUserSpecifiedModel('flurble-9000') === 'flurble-9000', '', 'pass an unknown name through unchanged in parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
check('canonical parity: a first-party id is byte-identical', parseUserSpecifiedModel('claude-sonnet-5') === 'claude-sonnet-5', '', 'the fold must not rewrite a canonical id in parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
check('canonical parity: a declared engine id is byte-identical', parseUserSpecifiedModel('gpt-5.2') === 'gpt-5.2', '', 'the fold must not rewrite a canonical id in parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
check('canonical parity: a carrier id is byte-identical', parseUserSpecifiedModel('openrouter/anthropic/claude-opus-5') === 'openrouter/anthropic/claude-opus-5', '', 'the fold must not rewrite a canonical id in parseUserSpecifiedModel in src/models/catalogue/engineModel.ts')
check("the alias switch is untouched ('sonnet5' → its row)", parseUserSpecifiedModel('sonnet5') === parseUserSpecifiedModelRaw('sonnet5'), '', 'leave the alias switch alone in src/models/catalogue/engineModel.ts')


console.log('\n§3 the launch door')
const { canonicalWorkerModelId, validateWorkerModelChoice } = await import(
  '../../src/screen/concourse-model/workerModels.ts'
)
const { declaredRouteOf } = await import('../../src/models/roads/routeLaw.ts')
const doorId = await canonicalWorkerModelId('sonnet 5')
check("canonicalWorkerModelId('sonnet 5') lands on the canonical row id", doorId === (await canonicalWorkerModelId('sonnet5')), doorId, 'fold the spelling inside canonicalWorkerModelId in src/screen/concourse-model/workerModels.ts')
check('…and the route law declares it (never unrecognised at the arms)', declaredRouteOf(doorId) === 'anthropic', String(declaredRouteOf(doorId)), 'canonicalWorkerModelId in src/screen/concourse-model/workerModels.ts must return an id that declaredRouteOf in src/models/roads/routeLaw.ts declares')
check("'Sonnet-5' lands identically at the door", (await canonicalWorkerModelId('Sonnet-5')) === doorId, '', 'fold case and hyphens inside canonicalWorkerModelId in src/screen/concourse-model/workerModels.ts')
check('the [1m] context tag strips at the door (a call-time flavour, not an identity)', (await canonicalWorkerModelId(`${doorId}[1m]`)) === doorId, await canonicalWorkerModelId(`${doorId}[1m]`), 'strip the [1m] tag inside canonicalWorkerModelId in src/screen/concourse-model/workerModels.ts')
const refusal = await validateWorkerModelChoice('flurble-9000', 'session')
check('a genuinely unknown launch still refuses, typed', refusal.ok === false && refusal.reason === 'not-runnable:unrecognised', '', 'validateWorkerModelChoice in src/screen/concourse-model/workerModels.ts must refuse an unknown id with reason not-runnable:unrecognised')
const liveExamples = catalogueSpellingExamples(3)
check(
  'the refusal action names DERIVED example spellings exactly when the catalogue offers rows',
  refusal.ok === false &&
    (refusal.action ?? '').startsWith('pick a listed row from the model picker') &&
    (liveExamples.length === 0 || ((refusal.action ?? '').includes('spellings like') && (refusal.action ?? '').includes(`'${liveExamples[0]}'`))),
  refusal.ok === false ? (refusal.action ?? '(no action)') : '(unexpected ok)',
  'build the refusal action in validateWorkerModelChoice in src/screen/concourse-model/workerModels.ts from catalogueSpellingExamples',
)

{
  console.log('\n§4 the run road takes the fold too (FC-073)')
  const { FIXTURE_MODEL, liveFactsOf, withFixtureRunner } = await import('../lib/builtProduct.ts')
  const SPOKEN = 'Sonnet 5'
  const folded = parseUserSpecifiedModel(SPOKEN)
  const SEAT_DEFS = JSON.stringify({ folder: { description: 'a seat whose model is spoken', prompt: 'You answer.', model: SPOKEN } })
  const seeded = await withFixtureRunner([], liveFactsOf, { model: null, argv: ['--agent-defs', SEAT_DEFS, '--agent', 'folder'] }).then(facts => facts.model.effective, () => null)
  const switched = await withFixtureRunner([], async host => ({
    spoken: await host.request('session/set_model', { model: SPOKEN }).catch(() => null),
    byDefault: await host.request('session/set_model', { model: 'default' }).catch(() => null),
    absent: await host.request('session/set_model', {}).catch(() => null),
  }))
  const claimed = await withFixtureRunner([], async host => {
    await host.request('session/claim', { session_id: crypto.randomUUID(), model: SPOKEN })
    return (await liveFactsOf(host)).model.effective
  }, { env: { MERCURY_CONCOURSE_WORKER: '1' } }).catch(() => null)
  check(
    'the entry seed folds through the headless resolver (call-shaped)',
    seeded === folded,
    '',
    'resolve the --agent-defs seat model through parseUserSpecifiedModel on the headless entry road',
  )
  check(
    'the set_model control folds through the headless resolver (call-shaped)',
    JSON.stringify(switched.spoken) === JSON.stringify({ model: folded, at: 'now' }) && switched.byDefault !== null && switched.byDefault.model === switched.absent?.model && ![folded, FIXTURE_MODEL].includes(switched.byDefault.model),
    '',
    'resolve the model of session/set_model through parseUserSpecifiedModel in src/daemon/runner-wire/sessionVerbs.ts',
  )
  check(
    'the warm-claim write folds through the headless resolver (call-shaped)',
    claimed === folded,
    '',
    'resolve the model of session/claim through parseUserSpecifiedModel on the warm-claim write',
  )
  const { existsSync } = await import('node:fs')
  const { spawn } = await import('node:child_process')
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(DIST)) {
    check('dist/mercury.mjs exists (build first — the live leg drives the artifact)', false, '', 'run bun run build.ts to write dist/mercury.mjs')
  } else {
    const home = mkdtempSync(join(tmpdir(), 'fold-p-home-'))
    const refused = { kind: 'error', status: 401, errorType: 'authentication_error', message: 'invalid x-api-key' } as const
    const fixture = await startFixtureApi(Array.from({ length: 8 }, () => refused), { messageHeaders: { 'x-should-retry': 'false' } })
    const run = await new Promise<{ exit: number | null; stdout: string; stderr: string }>(resolvePromise => {
      const child = spawn('node', [DIST, 'run', '--model', 'Sonnet 5', 'hi'], {
        env: {
          ...process.env,
          MERCURY_CONFIG_DIR: home,
          NODE_ENV: undefined,
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_AUTH_TOKEN: 'invalid-fixture-token',
          ANTHROPIC_API_KEY: undefined,
          MERCURY_OAUTH_TOKEN: undefined,
        } as NodeJS.ProcessEnv,
      })
      child.stdin.end()
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', d => (stdout += d))
      child.stderr.on('data', d => (stderr += d))
      const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
      child.on('close', exit => {
        clearTimeout(killer)
        resolvePromise({ exit, stdout, stderr })
      })
    })
    await fixture.close()
    const err = `${run.stderr}${run.stdout}`
    check(
      "run --model 'Sonnet 5' resolves through the fold (reaches auth; never 'no family declares')",
      !err.includes('not a model id any provider family declares') && /Authentication|401|Not logged in|Invalid (API key|credential)/i.test(err),
      err.slice(0, 140).replace(/\s+/g, ' '),
      'let the run road resolve --model through parseUserSpecifiedModel before it checks provider families',
    )
    const wireModels = fixture.messageRequests().map(q => String((q.body as { model?: unknown } | null)?.model ?? ''))
    check(
      "the folded request reached the loopback 401 fixture carrying the resolved id (claude-sonnet-5 on the wire, never the spelling)",
      wireModels.length >= 1 && wireModels.includes('claude-sonnet-5') && !wireModels.includes('Sonnet 5'),
      wireModels.length === 0 ? `no message request reached the fixture (exit=${String(run.exit)})` : wireModels.join(','),
      'send the id parseUserSpecifiedModel returns, never the spoken spelling, on the request',
    )
  }
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} spelling-fold check(s) failed`)
  process.exit(1)
}
console.log(' ALL SPELLING-FOLD PROOFS PASS')
