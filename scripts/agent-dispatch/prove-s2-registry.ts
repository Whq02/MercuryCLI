#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveryIo } from '../../src/models/roads/providerDiscovery.js'

const savedConfigDir = process.env.MERCURY_CONFIG_DIR
const savedOpenaiKey = process.env.OPENAI_API_KEY
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-s2-home-'))
delete process.env.OPENAI_API_KEY

const { buildProviderSnapshot } = await import('../../src/models/roads/modelRegistry.js')
const {
  __resetProviderDiscoveryForTest,
  getCachedProviderDiscovery,
  PROVIDER_DISCOVERY_TTL_MS,
  refreshProviderDiscovery,
} = await import('../../src/models/roads/providerDiscovery.js')
const { anthropicProviderAdapter } = await import('../../src/models/roads/anthropic/anthropicAdapter.js')
const { openaiProviderAdapter } = await import('../../src/models/roads/openai/openaiAdapter.js')
const { zaiProviderAdapter } = await import('../../src/models/roads/zai/zaiAdapter.js')
const { SPECIALIST_ROLES } = await import('../../src/models/roads/providerAdapter.js')
const { GPT_DISPLAY_PINS } = await import('../../src/models/facts/pins/gptPins.js')

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  const shown = !cond && fixHint ? (detail ? `${detail} | ${fixHint}` : fixHint) : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function fakeIo(env: Record<string, string | undefined>, startClock = 1_000_000): {
  io: DiscoveryIo
  calls: string[]
  tick: (ms: number) => void
} {
  const calls: string[] = []
  let now = startClock
  return {
    io: {
      env,
      now: () => {
        calls.push('now')
        return now
      },
    },
    calls,
    tick: ms => {
      now += ms
    },
  }
}

console.log('============================================================')
console.log(' S2 — evolved registry + discovery-owner proof')
console.log('============================================================')

section('1 · uncredentialed — precise stable codes, self-served probes')
{
  __resetProviderDiscoveryForTest()
  check('cache read is null before any probe', getCachedProviderDiscovery('openai') === null, '', 'getCachedProviderDiscovery in src/models/roads/providerDiscovery.ts must return null until refreshProviderDiscovery has probed; check __resetProviderDiscoveryForTest clears the cache')
  check(
    "openai status 'no-account:openai' (hermetic home, no key)",
    openaiProviderAdapter.status().available === false &&
      openaiProviderAdapter.status().reason === 'no-account:openai',
    '',
    'status() in src/models/roads/openai/openaiAdapter.ts must report available false with reason no-account:openai when no key or login exists',
  )
  check(
    "zai status 'no-api-key:zai' (no env key)",
    zaiProviderAdapter.status().available === false &&
      zaiProviderAdapter.status().reason === 'no-api-key:zai',
    '',
    'status() in src/models/roads/zai/zaiAdapter.ts must report available false with reason no-api-key:zai when ZAI_API_KEY is unset',
  )
  __resetProviderDiscoveryForTest()
}

section('2 · describe() — present, honest, secret-free, catalogue-verified')
{
  const anth = anthropicProviderAdapter.describe()
  const oai = openaiProviderAdapter.describe()
  const zai = zaiProviderAdapter.describe()

  check("anthropic transport 'anthropic-messages'", anth.transport === 'anthropic-messages')
  check(
    "openai transport 'openai-responses' (native)",
    oai.transport === 'openai-responses',
  )
  check("zai transport 'zai-chat-completions'", zai.transport === 'zai-chat-completions')

  check(
    'anthropic catalogue mirrors the seat table (3 entries, all with context windows)',
    anth.catalogue.length === 3 && anth.catalogue.every(e => (e.contextWindow ?? 0) > 0),
    anth.catalogue.map(e => e.id).join(','),
    'describe() in src/models/roads/anthropic/anthropicAdapter.ts must list the three seat table entries, each with a context window',
  )
  check(
    'openai static catalogue mirrors the last-observed pin table 1:1 (ids, in order)',
    JSON.stringify(oai.catalogue.map(e => e.id)) ===
      JSON.stringify(GPT_DISPLAY_PINS.map(p => p.id)),
    oai.catalogue.map(e => e.id).join(','),
    'describe() in src/models/roads/openai/openaiAdapter.ts must list the ids of GPT_DISPLAY_PINS (src/models/facts/pins/gptPins.ts) in order; change the pin table or the adapter so they agree',
  )
  check(
    'openai catalogue NEVER carries deprecated/retired ids',
    oai.catalogue.every(e => !/gpt-5\.1|gpt-5\.2$|gpt-5\.3-codex$/.test(e.id)),
    '',
    'remove the retired id from GPT_DISPLAY_PINS in src/models/facts/pins/gptPins.ts',
  )
  check(
    'catalogue windows DERIVE from the pins: stated exactly where a pin records one, absent otherwise',
    oai.catalogue.every(e => {
      const pin = GPT_DISPLAY_PINS.find(p => p.id === e.id)
      return pin?.contextWindow === undefined
        ? e.contextWindow === undefined
        : e.contextWindow === pin.contextWindow
    }),
    '',
    'describe() in src/models/roads/openai/openaiAdapter.ts must take each contextWindow from the matching pin in src/models/facts/pins/gptPins.ts and leave it undefined when the pin has none',
  )
  check(
    'every pin is a DATED observation (observedAt present)',
    GPT_DISPLAY_PINS.every(p => typeof p.observedAt === 'string' && p.observedAt.length > 0),
    '',
    'give every entry of GPT_DISPLAY_PINS in src/models/facts/pins/gptPins.ts an observedAt date string',
  )
  check(
    'openai static pins never invent an effort vocabulary (efforts are live truth)',
    oai.catalogue.every(e => e.efforts.length === 0),
    '',
    'the static catalogue built in src/models/roads/openai/openaiAdapter.ts must leave efforts empty until a live read supplies them',
  )
  check(
    "zai catalogue with no list read = the dated floor ['glm-5.3', 'glm-5.3-flash', 'glm-5.2'] (docs read 2026-10-05), 1M ctx each",
    zai.catalogue.length === 3 &&
      zai.catalogue[0]!.id === 'glm-5.3' &&
      zai.catalogue[1]!.id === 'glm-5.3-flash' &&
      zai.catalogue[2]!.id === 'glm-5.2' &&
      zai.catalogue.every(e => e.contextWindow === 1_000_000),
    '',
    'the static floor catalogue in src/models/roads/zai/zaiAdapter.ts must be glm-5.3, glm-5.3-flash, glm-5.2 at 1000000 context each',
  )
  check('no invented glm-5.5* anywhere', zai.catalogue.every(e => !e.id.includes('5.5')), '', 'remove the glm-5.5 id from the catalogue in src/models/roads/zai/zaiAdapter.ts')
  check(
    'glm-5.3 and glm-5.3-flash efforts = the documented low|high|max vocabulary (2026-10-05)',
    JSON.stringify(zai.catalogue[0]!.efforts) === JSON.stringify(['low', 'high', 'max']) &&
      JSON.stringify(zai.catalogue[1]!.efforts) === JSON.stringify(['low', 'high', 'max']),
    '',
    'set efforts of glm-5.3 and glm-5.3-flash to low, high, max in the catalogue of src/models/roads/zai/zaiAdapter.ts',
  )
  check(
    'glm-5.2 efforts = the documented reasoning_effort vocabulary (max first)',
    JSON.stringify(zai.catalogue[2]!.efforts) ===
      JSON.stringify(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']),
    '',
    'set efforts of glm-5.2 to max, xhigh, high, medium, low, minimal, none in the catalogue of src/models/roads/zai/zaiAdapter.ts',
  )
  for (const [name, d] of [['anthropic', anth], ['openai', oai], ['zai', zai]] as const) {
    check(`${name}: provenance is 'static-pin' (no live discovery ran)`, d.catalogueSource === 'static-pin', '', `describe() of the ${name} adapter under src/models/roads/ must report catalogueSource static-pin while no live discovery has run`)
    check(
      `${name}: roles are the ONE specialist vocabulary`,
      JSON.stringify(d.roles) === JSON.stringify(SPECIALIST_ROLES),
      '',
      `describe() of the ${name} adapter must return SPECIALIST_ROLES from src/models/roads/providerAdapter.ts`,
    )
    check(
      `${name}: account view carries no secret-looking value`,
      !/sk-|key-|token|bearer/i.test(d.account.label) || d.account.label.includes('API key'),
      d.account.label,
      `the account label from describe() of the ${name} adapter must not carry a key, token or bearer value`,
    )
  }
  check(
    'openai/zai accounts read none while nothing is discovered',
    oai.account.kind === 'none' && zai.account.kind === 'none',
    '',
    'describe() in the openai and zai adapters under src/models/roads/ must report account kind none until discovery finds a key',
  )
  check(
    'openai claims tool-calls + reasoning-deltas (in-process), never own-agent-loop',
    oai.capabilities.includes('tool-calls') &&
      oai.capabilities.includes('reasoning-deltas') &&
      !oai.capabilities.includes('own-agent-loop'),
    '',
    'fix the capabilities list in describe() of src/models/roads/openai/openaiAdapter.ts',
  )
}

section('3 · discovery — account presence, key sources, TTL/force')
{
  __resetProviderDiscoveryForTest()

  {
    const { io } = fakeIo({ OPENAI_API_KEY: 'sk-proof-fake-key' })
    const rec = await refreshProviderDiscovery('openai', { io })
    check(
      "openai key present via env → api-key account (source 'env')",
      rec?.provider === 'openai' &&
        rec.account?.kind === 'api-key' &&
        rec.account.keySource === 'env',
      JSON.stringify(rec),
      'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts must return an api-key account with keySource env when the env carries OPENAI_API_KEY',
    )
    check(
      'the key VALUE never appears in the record',
      !JSON.stringify(rec).includes('sk-proof-fake-key'),
      '',
      'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts must store only the key source, never the key value',
    )
    const savedOpenaiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-proof-fake-key'
    try {
      const oaiDesc = openaiProviderAdapter.describe()
      check("describe() reflects account presence: kind 'api-key'", oaiDesc.account.kind === 'api-key', oaiDesc.account.label, 'describe() in src/models/roads/openai/openaiAdapter.ts must read the account from the env key')
      check(
        'openai status flips available on account presence',
        openaiProviderAdapter.status().available === true,
        '',
        'status() in src/models/roads/openai/openaiAdapter.ts must report available true once an account exists',
      )
    } finally {
      if (savedOpenaiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedOpenaiKey
    }
  }

  __resetProviderDiscoveryForTest()
  {
    const { io } = fakeIo({})
    const rec = await refreshProviderDiscovery('openai', { io })
    check(
      'no account source → record without an account ref',
      rec?.provider === 'openai' && rec.account === undefined,
      '',
      'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts must leave account unset when no source is connected',
    )
    const status = openaiProviderAdapter.status()
    check(
      "openai status 'no-account:openai' with no source connected",
      status.available === false && status.reason === 'no-account:openai',
      status.reason,
      'status() in src/models/roads/openai/openaiAdapter.ts must report no-account:openai when discovery found no source',
    )
  }

  {
    const { io } = fakeIo({ ZAI_API_KEY: 'not-a-real-key' })
    const rec = await refreshProviderDiscovery('zai', { io })
    check(
      "zai key present via env → keySource 'env'",
      rec?.provider === 'zai' && rec.keyPresent && rec.keySource === 'env',
      '',
      'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts must report keyPresent with keySource env for ZAI_API_KEY',
    )
    const zaiDesc = zaiProviderAdapter.describe()
    check('describe() account flips to api-key', zaiDesc.account.kind === 'api-key', '', 'describe() in src/models/roads/zai/zaiAdapter.ts must report an api-key account once discovery found the key')
    check(
      'the key VALUE never appears in the record or the description',
      !JSON.stringify(rec).includes('not-a-real-key') &&
        !JSON.stringify(zaiDesc).includes('not-a-real-key'),
      '',
      'keep the key value out of the record (src/models/roads/providerDiscovery.ts) and out of describe() (src/models/roads/zai/zaiAdapter.ts)',
    )
  }

  __resetProviderDiscoveryForTest()
  {
    const { io, tick } = fakeIo({ OPENAI_API_KEY: 'sk-proof-fake-key' }, 5_000_000)
    const first = await refreshProviderDiscovery('openai', { io })
    tick(PROVIDER_DISCOVERY_TTL_MS - 1_000)
    const second = await refreshProviderDiscovery('openai', { io })
    check('within TTL: the cached record is served (same stamp)', first === second, '', 'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts must serve the cached record while younger than PROVIDER_DISCOVERY_TTL_MS')
    tick(2_000)
    const third = await refreshProviderDiscovery('openai', { io })
    check(
      'past TTL: re-probed (new stamp)',
      third !== null && third !== second && third.probedAtMs > second!.probedAtMs,
      '',
      'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts must probe again once the record is older than PROVIDER_DISCOVERY_TTL_MS',
    )
    const forced = await refreshProviderDiscovery('openai', { io, force: true })
    check('force: re-probed again', forced !== third, '', 'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts must skip the cache when force is true')
  }

  check(
    'anthropic refresh resolves null (no discovery needed)',
    (await refreshProviderDiscovery('anthropic')) === null,
    '',
    'refreshProviderDiscovery in src/models/roads/providerDiscovery.ts must return null for anthropic',
  )

  __resetProviderDiscoveryForTest()
}

section('4 · snapshot — additive surface; uncredentialed never resolves an engine')
{
  const snap = buildProviderSnapshot()
  check(
    'providers[] carries twenty-four families (Anthropic and twenty-three engine spaces)',
    snap.providers.length === 24 && ['xai', 'meta', 'mistral', 'nous', 'zen', 'minimax', 'together', 'cohere', 'groq', 'melious', 'orcarouter', 'cerebras', 'fireworks', 'qwen'].every(id => snap.providers.some(provider => provider.id === id)),
    '',
    'buildProviderSnapshot in src/models/roads/modelRegistry.ts must list 24 providers including the named ids; update the count here if a family was added on purpose',
  )
  for (const p of snap.providers) {
    check(
      `${p.id}: availability + transport + description present`,
      typeof p.available === 'boolean' &&
        typeof p.transport === 'string' &&
        p.description !== undefined &&
        p.description.transport === p.transport,
      '',
      `the ${p.id} adapter under src/models/roads/ must report available, transport and a description whose transport matches`,
    )
  }
  check("resolve('gpt') null uncredentialed (never a fallthrough)", snap.resolve('gpt') === null, '', 'resolve in buildProviderSnapshot (src/models/roads/modelRegistry.ts) must return null when no provider is credentialed')
  check("resolve('glm') null (GLM never seats)", snap.resolve('glm') === null, '', 'resolve in buildProviderSnapshot (src/models/roads/modelRegistry.ts) must return null for glm')
  check("resolveExact('gpt-5.6-sol') refuses uncredentialed (no available provider lists it)", snap.resolveExact('gpt-5.6-sol') === null, '', 'resolveExact in src/models/roads/modelRegistry.ts must refuse a pin no available provider lists')
  check("resolveExact('glm-5.2') refuses uncredentialed (no available provider lists it)", snap.resolveExact('glm-5.2') === null, '', 'resolveExact in src/models/roads/modelRegistry.ts must refuse a pin no available provider lists')
}

if (savedConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
else process.env.MERCURY_CONFIG_DIR = savedConfigDir
if (savedOpenaiKey === undefined) delete process.env.OPENAI_API_KEY
else process.env.OPENAI_API_KEY = savedOpenaiKey
__resetProviderDiscoveryForTest()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL S2 REGISTRY PROOFS PASS')
else console.log(`${failures} S2 REGISTRY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
