#!/usr/bin/env bun
// ============================================================================
//  scripts/router/prove-providers.ts
//  PROOF (the provider/model-registry layer; engines are
//  DEFAULT-ON — availability is
//  credential truth alone). The three RouterProviderAdapters and the
//  modelRegistry snapshot hold their contracts:
//
//    1. ANTHROPIC is available and resolves all three classes (opus/sonnet/
//       fable) to non-Haiku, allowed-seat-family refs with a positive
//       contextWindow.
//    2. WITHOUT credentials: each engine reports a PRECISE stable
//       unavailable code — zai 'no-api-key:zai' · openai 'no-account:openai'
// and
//       offers nothing.
//    3. WITH (fake) credentials: status flips available. The zai SEAT LAW is
//       unchanged (resolveModel null in every posture — GLM never seats).
//       The openai lane is the native runtime: listModels stays EMPTY
//       until a LIVE catalogue is fetched (static pins never activate), then
//       lists the QUALIFIED set; resolveModel('gpt') resolves the
//       highest-priority qualified candidate (decision #6 — explicitly-
//       slotted gpt seats) and buildLaunchPatch echoes it; the DEFAULT
//       topology stays Anthropic (nothing here changes any default seat);
//       registry resolveExact still refuses raw engine ids (seat-pin grammar
//       is Anthropic-family).
//    4. The snapshot's public surface never throws, credentialed or not.
//
//  Run:  ~/.bun/bin/bun run scripts/router/prove-providers.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { anthropicProviderAdapter } from '../../src/utils/router/providers/anthropic.js'
import { openaiProviderAdapter } from '../../src/utils/router/providers/openai.js'
import { zaiProviderAdapter } from '../../src/utils/router/providers/zai.js'
import { buildRouterModelSnapshot } from '../../src/utils/router/modelRegistry.js'
import {
  __resetProviderDiscoveryForTest,
  refreshProviderDiscovery,
} from '../../src/utils/router/providerDiscovery.js'
import { SEAT_ALLOWED_FAMILIES } from '../../src/utils/model/seatSlots.js'
import { getCanonicalName } from '../../src/utils/model/model.js'
import { isHaikuTier } from '../../src/utils/model/modelFloor.js'
import type { RouterModelClass, RouterPosture } from '../../src/utils/router/providers/types.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Router providers — adapter + registry contract proof')
console.log('============================================================')

const ALL_CLASSES: RouterModelClass[] = ['opus', 'sonnet', 'fable', 'gpt', 'glm']
const ALL_POSTURES: RouterPosture[] = ['adaptive', 'quality', 'balanced', 'fast', 'fixed']

// Hermetic env bracket: the proof owns both knobs and restores them. The
// config home pins to a scratch dir so a REAL stored provider secret on the
// developer machine (providerSecrets.ts, S6) can never flip the no-key
// assertions — getMercuryHome's memo keys off this env input.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
const savedZaiKey = process.env.ZAI_API_KEY
const savedOpenaiKey = process.env.OPENAI_API_KEY
const savedConfigDir = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = mkdtempSync(joinPath(tmpdir(), 'prove-providers-home-'))
delete process.env.ZAI_API_KEY
delete process.env.OPENAI_API_KEY
__resetProviderDiscoveryForTest()

function assertLaunchPatchThrows(
  name: 'openai' | 'zai',
  adapter: typeof openaiProviderAdapter,
  mustInclude: string[],
): void {
  let threw = false
  let message = ''
  try {
    adapter.buildLaunchPatch({
      provider: name,
      model: 'placeholder',
      modelClass: name === 'openai' ? 'gpt' : 'glm',
      effort: 'high',
      contextWindow: 200_000,
    })
  } catch (error) {
    threw = true
    message = error instanceof Error ? error.message : String(error)
  }
  check(`${name}: buildLaunchPatch throws`, threw, message)
  check(
    `${name}: throw message names [${mustInclude.join(', ')}]`,
    mustInclude.every(fragment => message.includes(fragment)),
    message,
  )
}

function assertSeatLawHolds(
  context: string,
  opts?: { openaiGptResolves?: boolean },
): void {
  const snapshot = buildRouterModelSnapshot()
  for (const adapter of [openaiProviderAdapter, zaiProviderAdapter]) {
    for (const modelClass of ALL_CLASSES) {
      for (const posture of ALL_POSTURES) {
        // decision #6: a QUALIFIED live catalogue lets the openai
        // adapter resolve the 'gpt' class for explicitly-slotted seats —
        // every other cell stays null (GLM never seats; no cross-class leak).
        const expectedResolvable =
          opts?.openaiGptResolves === true && adapter.id === 'openai' && modelClass === 'gpt'
        const ref = adapter.resolveModel(modelClass, posture)
        if (expectedResolvable ? ref === null : ref !== null) {
          check(
            `${context}: ${adapter.id}.resolveModel('${modelClass}','${posture}') ${expectedResolvable ? 'resolves' : 'is null'}`,
            false,
            JSON.stringify(ref),
          )
        }
      }
    }
  }
  check(`${context}: adapter resolveModel matrix holds (class × posture)`, true)
  const glmRef = snapshot.resolve('glm', 'balanced')
  check(`${context}: registry resolve('glm') is null (GLM never seats)`, glmRef === null)
  const gptRef = snapshot.resolve('gpt', 'balanced')
  check(
    `${context}: registry resolve('gpt') ${opts?.openaiGptResolves ? 'resolves (qualified live catalogue)' : 'is null'}`,
    opts?.openaiGptResolves ? gptRef !== null : gptRef === null,
    JSON.stringify(gptRef),
  )
}

//
section('1 · anthropic — available, resolves all three of ITS classes')
//
{
  const status = anthropicProviderAdapter.status()
  check('status() available: true', status.available === true)

  for (const modelClass of ['opus', 'sonnet', 'fable'] as const) {
    for (const posture of ALL_POSTURES) {
      const ref = anthropicProviderAdapter.resolveModel(modelClass, posture)
      check(
        `resolveModel('${modelClass}', '${posture}') resolves`,
        ref !== null,
        ref ? `${ref.model} @${ref.effort} (${ref.contextWindow} tok)` : 'got null',
      )
      if (!ref) continue
      check(`  provider is 'anthropic'`, ref.provider === 'anthropic')
      check(`  modelClass echoes '${modelClass}'`, ref.modelClass === modelClass)
      check(`  never Haiku`, !isHaikuTier(ref.model))
      check(
        `  allowed seat family`,
        SEAT_ALLOWED_FAMILIES.includes(getCanonicalName(ref.model)),
        getCanonicalName(ref.model),
      )
      check(`  positive contextWindow`, ref.contextWindow > 0, String(ref.contextWindow))
      const patch = anthropicProviderAdapter.buildLaunchPatch(ref)
      check(`  buildLaunchPatch never throws + echoes model/effort`, patch.model === ref.model && patch.effort === ref.effort)
    }
  }

  // gpt/glm are never anthropic's classes
  for (const modelClass of ['gpt', 'glm'] as const) {
    const ref = anthropicProviderAdapter.resolveModel(modelClass, 'adaptive')
    check(`resolveModel('${modelClass}', …) is null (not anthropic's class)`, ref === null)
  }

  const listed = anthropicProviderAdapter.listModels()
  check('listModels() returns exactly 3 (opus/sonnet/fable)', listed.length === 3)
  check(
    'every listed model is non-Haiku + allowed family',
    listed.every(m => !isHaikuTier(m.ref.model) && SEAT_ALLOWED_FAMILIES.includes(getCanonicalName(m.ref.model))),
  )
}

//
section('2 · no credentials — precise stable unavailable codes, nothing offered')
//
{
  __resetProviderDiscoveryForTest()

  const zaiStatus = zaiProviderAdapter.status()
  check(
    "zai (no key): 'no-api-key:zai' (env-primed — no pending state)",
    zaiStatus.available === false && zaiStatus.reason === 'no-api-key:zai',
    zaiStatus.reason,
  )
  check('zai (no key): listModels() empty', zaiProviderAdapter.listModels().length === 0)

  // openai: the account probe is self-served (local file/env — no pending
  // state since). No key, no auth store in the hermetic home ⇒ the
  // stable no-account code.
  const noAccount = openaiProviderAdapter.status()
  check(
    "openai (no account source): 'no-account:openai'",
    noAccount.available === false && noAccount.reason === 'no-account:openai',
    noAccount.reason,
  )
  check('openai (no account): listModels() empty', openaiProviderAdapter.listModels().length === 0)
  assertSeatLawHolds('uncredentialed')

  const snapshot = buildRouterModelSnapshot()
  const byId = new Map(snapshot.providers.map(p => [p.id, p]))
  check('providers: anthropic available', byId.get('anthropic')?.available === true)
  check(
    'providers: openai unavailable + no-account reason',
    byId.get('openai')?.available === false && byId.get('openai')?.reason === 'no-account:openai',
  )
  check(
    'providers: zai unavailable + no-api-key reason',
    byId.get('zai')?.available === false && byId.get('zai')?.reason === 'no-api-key:zai',
  )
  check(
    'listAvailable() returns only anthropic models (3)',
    snapshot.listAvailable().length === 3 &&
      snapshot.listAvailable().every(m => m.ref.provider === 'anthropic'),
  )
}

//
section('3 · credentialed — live status; THE SEAT LAW HOLDS')
//
{
  process.env.ZAI_API_KEY = 'zai-proof-fake-key'
  const zaiStatus = zaiProviderAdapter.status()
  check('zai (key present): available', zaiStatus.available === true, zaiStatus.reason ?? '')
  const zaiModels = zaiProviderAdapter.listModels()
  check(
    'zai listModels: the catalogue pins — glm-5.3 flagship first, glm-5.2 behind it, both @ 1M context',
    zaiModels.length === 2 &&
      zaiModels[0]!.ref.model === 'glm-5.3' &&
      zaiModels[1]!.ref.model === 'glm-5.2' &&
      zaiModels.every(m => m.ref.provider === 'zai' && m.ref.contextWindow === 1_000_000),
    JSON.stringify(zaiModels.map(m => m.ref)),
  )
  check(
    'the key VALUE never enters the status/list surface',
    !JSON.stringify({ zaiStatus, zaiModels }).includes('zai-proof-fake-key'),
  )

  // openai: key present ⇒ available; NOTHING listable/resolvable
  // until a LIVE catalogue exists (static pins never activate).
  process.env.OPENAI_API_KEY = 'sk-proof-fake-key'
  await refreshProviderDiscovery('openai', { force: true })
  const oaiStatus = openaiProviderAdapter.status()
  check('openai (account present): available', oaiStatus.available === true, oaiStatus.reason ?? '')
  check(
    'openai listModels: EMPTY without a live catalogue (static pins never activate)',
    openaiProviderAdapter.listModels().length === 0,
  )
  assertSeatLawHolds('credentialed-unfetched')

  // Seed the LIVE catalogue from a wire fixture (no network) — the qualified
  // set lights up listModels + the explicit gpt seat resolution.
  const { refreshOpenaiCatalogue, __resetOpenaiCatalogueForTest } = await import(
    '../../src/services/providers/openai/openaiCatalogue.js'
  )
  __resetOpenaiCatalogueForTest()
  await refreshOpenaiCatalogue('api-key', {
    force: true,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              slug: 'gpt-5.6-sol',
              display_name: 'GPT-5.6 Sol',
              supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
              // LIVE semantics: ASCENDING rank — 1 is the top model.
              priority: 1,
            },
            {
              slug: 'gpt-5.6-terra',
              display_name: 'GPT-5.6 Terra',
              supported_reasoning_levels: ['low', 'medium', 'high'],
              priority: 2,
            },
            { slug: 'gpt-5.5', display_name: 'GPT-5.5', supported_reasoning_levels: ['high'] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch,
  })
  const oaiModels = openaiProviderAdapter.listModels()
  // MECHANISM: the qualified set is EVERY
  // visible served id — no generation gate (gpt-5.5 rides too) — in live
  // priority order; each row's window derives live-first, falling to the
  // last-observed pin only where one records a window, else the honest 0.
  const { GPT_DISPLAY_PINS } = await import(
    '../../src/services/providers/openai/gptPins.js'
  )
  const pinWindow = (id: string): number =>
    GPT_DISPLAY_PINS.find(p => p.id === id)?.contextWindow ?? 0
  check(
    'openai listModels: EVERY visible served id, priority-ordered, windows pin-derived (never invented)',
    oaiModels.length === 3 &&
      oaiModels[0]!.ref.model === 'gpt-5.6-sol' &&
      oaiModels.map(m => m.ref.model).includes('gpt-5.5') &&
      oaiModels.every(
        m => m.ref.provider === 'openai' && m.ref.contextWindow === pinWindow(m.ref.model),
      ),
    oaiModels.map(m => `${m.ref.model}:${m.ref.contextWindow}`).join(','),
  )
  assertSeatLawHolds('credentialed-live', { openaiGptResolves: true })
  const gptRef = openaiProviderAdapter.resolveModel('gpt', 'balanced')
  check(
    "openai resolveModel('gpt'): the highest-priority QUALIFIED candidate",
    gptRef?.model === 'gpt-5.6-sol' && gptRef.provider === 'openai',
    JSON.stringify(gptRef),
  )
  const patch = openaiProviderAdapter.buildLaunchPatch(gptRef!)
  check(
    'openai buildLaunchPatch echoes the exact id (in-process transport)',
    patch.model === 'gpt-5.6-sol' && typeof patch.effort === 'string',
  )
  assertLaunchPatchThrows('zai', zaiProviderAdapter, ['zai', 'no SEAT runtime'])

  const snapshot = buildRouterModelSnapshot()
  check(
    "resolveExact('glm-5.2') is null (exact SEAT pins stay Anthropic-family)",
    snapshot.resolveExact('glm-5.2') === null,
  )
  check(
    "resolveExact('gpt-5.5') is null (exact SEAT pins stay Anthropic-family)",
    snapshot.resolveExact('gpt-5.5') === null,
  )
  check(
    'listAvailable() now includes the engine catalogues (display truth: 3 anthropic + 3 qualified gpt + 2 glm)',
    snapshot.listAvailable().length === 3 + 3 + 2,
    String(snapshot.listAvailable().length),
  )
  __resetOpenaiCatalogueForTest()
}

//
section('4 · registry — resolveExact + never-throws matrix (credentialed + not)')
//
{
  for (const mode of ['credentialed', 'uncredentialed'] as const) {
    if (mode === 'uncredentialed') {
      delete process.env.ZAI_API_KEY
      delete process.env.OPENAI_API_KEY
      __resetProviderDiscoveryForTest()
    }
    const snapshot = buildRouterModelSnapshot()
    const sonnetExact = snapshot.resolveExact('claude-sonnet-5')
    check(
      `[${mode}] resolveExact('claude-sonnet-5') resolves via anthropic`,
      sonnetExact !== null && sonnetExact.provider === 'anthropic' && sonnetExact.modelClass === 'sonnet',
    )
    const opusExact = snapshot.resolveExact('claude-opus-4-8[1m]')
    check(
      `[${mode}] resolveExact('claude-opus-4-8[1m]') resolves as opus, 1M context`,
      opusExact !== null && opusExact.modelClass === 'opus' && opusExact.contextWindow === 1_000_000,
    )
    check(`[${mode}] resolveExact('claude-haiku-4-5') is null (never Haiku)`, snapshot.resolveExact('claude-haiku-4-5') === null)
    check(`[${mode}] resolveExact('sonnet') is null (bare alias is not a seat family)`, snapshot.resolveExact('sonnet') === null)
    check(`[${mode}] resolveExact('') is null`, snapshot.resolveExact('') === null)

    let matrixThrew = false
    try {
      for (const modelClass of ALL_CLASSES) {
        for (const posture of ALL_POSTURES) {
          snapshot.resolve(modelClass, posture)
        }
      }
      snapshot.listAvailable()
      for (const pin of ['claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5', 'glm-5.2', '', '   ', 'claude-fable-5']) {
        snapshot.resolveExact(pin)
      }
    } catch {
      matrixThrew = true
    }
    check(`[${mode}] resolve/listAvailable/resolveExact never throw across the matrix`, !matrixThrew)
  }
}

// Restore the ambient env exactly.
if (savedZaiKey === undefined) delete process.env.ZAI_API_KEY
else process.env.ZAI_API_KEY = savedZaiKey
if (savedOpenaiKey === undefined) delete process.env.OPENAI_API_KEY
else process.env.OPENAI_API_KEY = savedOpenaiKey
if (savedConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = savedConfigDir
__resetProviderDiscoveryForTest()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL ROUTER PROVIDER PROOFS PASS')
else console.log(`${failures} ROUTER PROVIDER PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
