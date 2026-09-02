#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-dispatch/prove-s2-registry.ts
//  PROOF (registry laws ·-rewritten openai lane; engines are
//  DEFAULT-ON):
//
//    1. UNCREDENTIALED law: with no account source and no keys the adapters
//       report the precise stable codes ('no-account:openai' ·
//       'no-api-key:zai') — self-served local probes, no pending state.
//    2. describe() is present on all three adapters, cheap+sync, and honest:
//       transports are the three declared wires (openai = the NATIVE
//       'openai-responses' since — the codex-app-server transport is
//       retired); catalogues carry ONLY catalogue-verified ids (deprecated/
//       retired GPT ids and invented glm ids must never appear); provenance =
//       'static-pin' before any live fetch; static GPT pins mirror the
//       last-observed pin table (windows only where a pin records one) and
//       NEVER invent an effort vocabulary (efforts are live truth); account
//       views carry no secrets.
//    3. Discovery laws (fake io env): openai account presence maps
//       OPENAI_API_KEY → an api-key account ref (value never recorded); zai
//       key presence maps env → 'env' source; TTL + force hold; the cache is
//       provider-bounded.
//    4. The snapshot surfaces transport + description additively — legacy
//       consumers' fields (id/available/reason) are unchanged, and gpt/glm
//       classes never resolve uncredentialed (no cross-provider fallback);
//       exact engine ids never resolve as SEAT pins (Anthropic-family
//       grammar).
//
//  Run:  ~/.bun/bin/bun run scripts/agent-dispatch/prove-s2-registry.ts
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveryIo } from '../../src/utils/router/providerDiscovery.js'

const savedConfigDir = process.env.MERCURY_CONFIG_DIR
const savedOpenaiKey = process.env.OPENAI_API_KEY
// Hermetic auth scope: the openai account probe reads the auth-scoped store
// (.openai-auth.json / .provider-secrets.json) — a real operator credential
// must never flip these assertions.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-s2-home-'))
delete process.env.OPENAI_API_KEY

const { buildRouterModelSnapshot } = await import('../../src/utils/router/modelRegistry.js')
const {
  __resetProviderDiscoveryForTest,
  getCachedProviderDiscovery,
  PROVIDER_DISCOVERY_TTL_MS,
  refreshProviderDiscovery,
} = await import('../../src/utils/router/providerDiscovery.js')
const { anthropicProviderAdapter } = await import('../../src/utils/router/providers/anthropic.js')
const { openaiProviderAdapter } = await import('../../src/utils/router/providers/openai.js')
const { zaiProviderAdapter } = await import('../../src/utils/router/providers/zai.js')
const { SPECIALIST_ROLES } = await import('../../src/utils/router/providers/types.js')
const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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

//
section('1 · uncredentialed — precise stable codes, self-served probes')
//
{
  __resetProviderDiscoveryForTest()
  check('cache read is null before any probe', getCachedProviderDiscovery('openai') === null)
  check(
    "openai status 'no-account:openai' (hermetic home, no key)",
    openaiProviderAdapter.status().available === false &&
      openaiProviderAdapter.status().reason === 'no-account:openai',
  )
  check(
    "zai status 'no-api-key:zai' (no env key)",
    zaiProviderAdapter.status().available === false &&
      zaiProviderAdapter.status().reason === 'no-api-key:zai',
  )
  __resetProviderDiscoveryForTest()
}

//
section('2 · describe() — present, honest, secret-free, catalogue-verified')
//
{
  const anth = anthropicProviderAdapter.describe()
  const oai = openaiProviderAdapter.describe()
  const zai = zaiProviderAdapter.describe()

  check("anthropic transport 'anthropic-messages'", anth.transport === 'anthropic-messages')
  check(
    "openai transport 'openai-responses' (native — codex-app-server retired)",
    oai.transport === 'openai-responses',
  )
  check("zai transport 'zai-chat-completions'", zai.transport === 'zai-chat-completions')

  check(
    'anthropic catalogue mirrors the seat table (3 entries, all with context windows)',
    anth.catalogue.length === 3 && anth.catalogue.every(e => (e.contextWindow ?? 0) > 0),
    anth.catalogue.map(e => e.id).join(','),
  )
  // MECHANISM, not a number (model-truth lane — pinning literal ids or a
  // literal window as eternal facts breaks the moment the lineup widens):
  // the static catalogue must MIRROR the one last-observed pin table, id for
  // id, and state a window exactly where the pin records one — never invent.
  check(
    'openai static catalogue mirrors the last-observed pin table 1:1 (ids, in order)',
    JSON.stringify(oai.catalogue.map(e => e.id)) ===
      JSON.stringify(GPT_DISPLAY_PINS.map(p => p.id)),
    oai.catalogue.map(e => e.id).join(','),
  )
  check(
    'openai catalogue NEVER carries deprecated/retired ids',
    oai.catalogue.every(e => !/gpt-5\.1|gpt-5\.2$|gpt-5\.3-codex$/.test(e.id)),
  )
  check(
    'catalogue windows DERIVE from the pins: stated exactly where a pin records one, absent otherwise',
    oai.catalogue.every(e => {
      const pin = GPT_DISPLAY_PINS.find(p => p.id === e.id)
      return pin?.contextWindow === undefined
        ? e.contextWindow === undefined
        : e.contextWindow === pin.contextWindow
    }),
  )
  check(
    'every pin is a DATED observation (observedAt present)',
    GPT_DISPLAY_PINS.every(p => typeof p.observedAt === 'string' && p.observedAt.length > 0),
  )
  check(
    'openai static pins never invent an effort vocabulary (efforts are live truth)',
    oai.catalogue.every(e => e.efforts.length === 0),
  )
  check(
    "zai catalogue = ['glm-5.3', 'glm-5.2'] (5.3 the flagship, docs fetched 2026-08-21), 1M ctx each",
    zai.catalogue.length === 2 &&
      zai.catalogue[0]!.id === 'glm-5.3' &&
      zai.catalogue[1]!.id === 'glm-5.2' &&
      zai.catalogue.every(e => e.contextWindow === 1_000_000),
  )
  check('no invented glm-5.5* anywhere', zai.catalogue.every(e => !e.id.includes('5.5')))
  check(
    'glm-5.3 efforts = the documented low|high|max vocabulary (2026-08-21)',
    JSON.stringify(zai.catalogue[0]!.efforts) === JSON.stringify(['low', 'high', 'max']),
  )
  check(
    'glm-5.2 efforts = the documented reasoning_effort vocabulary (max first)',
    JSON.stringify(zai.catalogue[1]!.efforts) ===
      JSON.stringify(['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']),
  )
  for (const [name, d] of [['anthropic', anth], ['openai', oai], ['zai', zai]] as const) {
    check(`${name}: provenance is 'static-pin' (no live discovery ran)`, d.catalogueSource === 'static-pin')
    check(
      `${name}: roles are the ONE specialist vocabulary`,
      JSON.stringify(d.roles) === JSON.stringify(SPECIALIST_ROLES),
    )
    check(
      `${name}: account view carries no secret-looking value`,
      !/sk-|key-|token|bearer/i.test(d.account.label) || d.account.label.includes('API key'),
      d.account.label,
    )
  }
  check(
    'openai/zai accounts read none while nothing is discovered',
    oai.account.kind === 'none' && zai.account.kind === 'none',
  )
  check(
    'openai claims tool-calls + reasoning-deltas (in-process), never own-agent-loop',
    oai.capabilities.includes('tool-calls') &&
      oai.capabilities.includes('reasoning-deltas') &&
      !oai.capabilities.includes('own-agent-loop'),
  )
}

//
section('3 · discovery — account presence, key sources, TTL/force')
//
{
  __resetProviderDiscoveryForTest()

  // openai: API-key presence via the io env → an api-key account ref.
  {
    const { io } = fakeIo({ OPENAI_API_KEY: 'sk-proof-fake-key' })
    const rec = await refreshProviderDiscovery('openai', { io })
    check(
      "openai key present via env → api-key account (source 'env')",
      rec?.provider === 'openai' &&
        rec.account?.kind === 'api-key' &&
        rec.account.keySource === 'env',
      JSON.stringify(rec),
    )
    check(
      'the key VALUE never appears in the record',
      !JSON.stringify(rec).includes('sk-proof-fake-key'),
    )
    // describe()/status() resolve the account from the REAL process env
    // (activeAccount), not the injected io — pin the same key there for the
    // adapter-side assertions so the run is hermetic on a home with no
    // ambient OpenAI account.
    const savedOpenaiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-proof-fake-key'
    try {
      const oaiDesc = openaiProviderAdapter.describe()
      check("describe() reflects account presence: kind 'api-key'", oaiDesc.account.kind === 'api-key', oaiDesc.account.label)
      check(
        'openai status flips available on account presence',
        openaiProviderAdapter.status().available === true,
      )
    } finally {
      if (savedOpenaiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = savedOpenaiKey
    }
  }

  // openai: no account source ⇒ honest reason code.
  __resetProviderDiscoveryForTest()
  {
    const { io } = fakeIo({})
    const rec = await refreshProviderDiscovery('openai', { io })
    check(
      'no account source → record without an account ref',
      rec?.provider === 'openai' && rec.account === undefined,
    )
    // status() self-serves a CURRENT probe from process.env (no key there
    // either — the bracket cleared it), so the reason is deterministic.
    const status = openaiProviderAdapter.status()
    check(
      "openai status 'no-account:openai' with no source connected",
      status.available === false && status.reason === 'no-account:openai',
      status.reason,
    )
  }

  // zai key presence.
  {
    const { io } = fakeIo({ ZAI_API_KEY: 'not-a-real-key' })
    const rec = await refreshProviderDiscovery('zai', { io })
    check(
      "zai key present via env → keySource 'env'",
      rec?.provider === 'zai' && rec.keyPresent && rec.keySource === 'env',
    )
    const zaiDesc = zaiProviderAdapter.describe()
    check('describe() account flips to api-key', zaiDesc.account.kind === 'api-key')
    check(
      'the key VALUE never appears in the record or the description',
      !JSON.stringify(rec).includes('not-a-real-key') &&
        !JSON.stringify(zaiDesc).includes('not-a-real-key'),
    )
  }

  // TTL: within TTL a refresh serves the cached record; past TTL and force
  // re-probe (observed via probedAtMs — the probe is local-sync now).
  __resetProviderDiscoveryForTest()
  {
    const { io, tick } = fakeIo({ OPENAI_API_KEY: 'sk-proof-fake-key' }, 5_000_000)
    const first = await refreshProviderDiscovery('openai', { io })
    tick(PROVIDER_DISCOVERY_TTL_MS - 1_000)
    const second = await refreshProviderDiscovery('openai', { io })
    check('within TTL: the cached record is served (same stamp)', first === second)
    tick(2_000)
    const third = await refreshProviderDiscovery('openai', { io })
    check(
      'past TTL: re-probed (new stamp)',
      third !== null && third !== second && third.probedAtMs > second!.probedAtMs,
    )
    const forced = await refreshProviderDiscovery('openai', { io, force: true })
    check('force: re-probed again', forced !== third)
  }

  // anthropic needs no discovery.
  check(
    'anthropic refresh resolves null (no discovery needed)',
    (await refreshProviderDiscovery('anthropic')) === null,
  )

  __resetProviderDiscoveryForTest()
}

//
section('4 · snapshot — additive surface; uncredentialed never resolves an engine')
//
{
  const snap = buildRouterModelSnapshot()
  check(
    'providers[] carries the ten families (the Hugging Face router and the local servers included)',
    snap.providers.length === 10,
  )
  for (const p of snap.providers) {
    check(
      `${p.id}: legacy fields intact + transport + description present`,
      typeof p.available === 'boolean' &&
        typeof p.transport === 'string' &&
        p.description !== undefined &&
        p.description.transport === p.transport,
    )
  }
  check("resolve('gpt') null uncredentialed (never a fallthrough)", snap.resolve('gpt', 'balanced') === null)
  check("resolve('glm') null (GLM never seats)", snap.resolve('glm', 'balanced') === null)
  check("resolveExact('gpt-5.6-sol') refuses (SEAT pins stay Anthropic-family)", snap.resolveExact('gpt-5.6-sol') === null)
  check("resolveExact('glm-5.2') refuses (SEAT pins stay Anthropic-family)", snap.resolveExact('glm-5.2') === null)
}

// Restore the ambient env exactly.
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
