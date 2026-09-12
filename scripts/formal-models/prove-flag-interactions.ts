#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

scratchRoot('cairn-flag-interactions')
const t = checker()
const ROOT = join(import.meta.dir, '..', '..')

const { FLAG_REGISTRY, flagEnabled, flagEnv } = await import('../../src/substrate/flagRegistry.ts')
const { changeSetEnabled } = await import('../../src/services/changeTransaction/changeSetContracts.ts')
const { resolveSelectionBudget, resolveSelectionPolicy } = await import('../../src/services/run/contextSelection.ts')
const { liveGlyphsEnabled } = await import('../../src/utils/cockpit/liveGlyphs.ts')
const { fsyncEnabled } = await import('../../src/substrate/durablePublish.ts')
const { decideSplashReceipt } = await import('../../src/substrate/splashHandover.ts')
const { resolveConcoursePolicy } = await import('../../src/context/surfaceRoute.ts')
const { bornSpawnSwitch } = await import('../../src/services/switchboard/spawnSwitches.ts')
const { resolveComputerAccess } = await import('../../src/substrate/startupMenu.ts')

const byEnv = new Map(FLAG_REGISTRY.map(f => [f.env, f]))

const DOMAINS: Record<string, string[]> = {
  MERCURY_GROUP_COMMIT: ['', '0'],
  MERCURY_DURABLE_FSYNC: ['', '0'],
  MERCURY_CHANGESET: ['', '0'],
  MERCURY_CHANGE_RECEIPTS: ['', '0'],
  MERCURY_EDIT_HUNKS: ['', '0'],
  MERCURY_LINE_ANCHORS: ['', '0'],
  MERCURY_LSP: ['', '0'],
  MERCURY_HARNESS_PROFILE: ['', '1'],
  MERCURY_HARNESS_PROFILE_PIN: ['', 'anthropic-default'],
  MERCURY_CONTEXT_SELECTION: ['', 'preserve-all', 'bounded-optional'],
  MERCURY_COMPACT: ['', '0'],
  MERCURY_AUTO_COMPACT: ['', '0'],
  MERCURY_PROMPT_CACHING: ['', '0'],
  MERCURY_PROMPT_CACHING_HAIKU: ['', '0'],
  MERCURY_PROMPT_CACHING_SONNET: ['', '0'],
  MERCURY_PROMPT_CACHING_OPUS: ['', '0'],
  MERCURY_AUGUR: ['', '1', '0'],
  MERCURY_AUGUR_TOOL: ['', '1', '0'],
  MERCURY_AUGUR_BRIEF: ['', '1', '0'],
  MERCURY_AUGUR_MODEL: ['', 'fable'],
  MERCURY_COMPAT_API_KEY: ['', 'sk-sweep'],
  MERCURY_COMPAT_BASE_URL: ['', 'http://127.0.0.1:9/v1'],
  MERCURY_COMPAT_LABEL: ['', 'sweep'],
  MERCURY_COMPAT_MODELS: ['', 'sweep-a,sweep-b'],
  MERCURY_CRITTER_IDLE: ['', '0'],
  MERCURY_CRITTER_SLEEP: ['', '0', '1'],
  MERCURY_LOCAL_BASE_URL: ['', 'http://127.0.0.1:9/v1'],
  MERCURY_LOCAL_PROBE_TARGETS: ['', 'http://127.0.0.1:9'],
  MERCURY_MOONSHOT_API_BASE: ['', 'https://sweep.example/v1'],
  MERCURY_MOONSHOT_OAUTH_BASE: ['', 'https://sweep.example'],
  MERCURY_MOONSHOT_OAUTH_CLIENT_ID: ['', 'client-sweep'],
  MERCURY_MOONSHOT_CODING_BASE: ['', 'https://sweep.example/coding/v1'],
  MERCURY_SELECTION_BUDGET: ['', '3'],
  MERCURY_CAP_FAILOVER: ['', 'auto'],
  MERCURY_MOCK_LIMITS: ['', '1'],
  MERCURY_MOCK_USAGE_PAYLOAD: ['', '{"limit":1}'],
  MERCURY_RESUME_SNAPSHOT: ['', '0'],
  MERCURY_TRANSCRIPT_READER: ['', '0'],
  MERCURY_VOICE_BACKEND: ['', 'fixture'],
  MERCURY_VOICE_FIXTURE_WAV: ['', '/tmp/sweep-take.wav'],
  MERCURY_SESSION_IDLE_RETIRE_MINUTES: ['', '10', '0'],
  MERCURY_CONCOURSE_IDLE_RETIRE_MINUTES: ['', '5'],
  MERCURY_SESSION_NEWBORN_GRACE_MINUTES: ['', '15', '0'],
  MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES: ['', '5'],
  MERCURY_SESSION_PARK_DRAIN_MINUTES: ['', '10', '0'],
  MERCURY_SEARCH_BACKEND: ['', 'duckduckgo'],
  MERCURY_SEARCH_KEYLESS: ['', '0'],
  MERCURY_SCRIPTED_STREAM: ['', '1'],
  MERCURY_THEME_PIN: ['', 'dark'],
  MERCURY_OASIS_BG: ['', '0'],
  MERCURY_SPECTRA_GROUND: ['', '0'],
  MERCURY_LIVE_GLYPHS: ['', '0'],
  MERCURY_CRITTER_GAZE: ['', '0'],
  MERCURY_LAUNCH_RIPPLE: ['', '0'],
  MERCURY_REDUCED_MOTION: ['', '1'],
  MERCURY_SPLASH_HANDOFF: ['', '1'],
  MERCURY_LAUNCH_ID: ['', 'sweep-launch-1'],
  MERCURY_FAULT_INJECT: ['', 'flush-file@cairn-never-hit:throw'],
  MERCURY_CONCOURSE: ['', 'auto', 'always'],
  MERCURY_CONCOURSE_WORKER: ['', '1'],
  MERCURY_SEATS: ['', '3'],
  MERCURY_MODEL_LANES: ['', '2'],
  MERCURY_ANCHOR_PATCH: ['', '1', '0'],
  MERCURY_EDIT_STALE_RECOVERY: ['', '0'],
  MERCURY_ENGINE_ASSERT: ['', '1', '0'],
  MERCURY_RENDER_ENGINE: ['', '1', '0'],
  MERCURY_EVAL: ['', '0'],
  MERCURY_EVAL_PY: ['', '0'],
  MERCURY_EVAL_JS: ['', '0'],
  MERCURY_EVAL_PYTHON: ['', '/usr/bin/python3'],
  MERCURY_FORCE_SYNC_OUTPUT: ['', '1', '0'],
  MERCURY_NO_SYNC_OUTPUT: ['', '1', '0'],
  MERCURY_STREAM_CARET: ['', '0'],
  MERCURY_MEMORY_OBSERVE: ['', '1', '0'],
  MERCURY_MNEME: ['', '1', '0'],
  MERCURY_SESSION_SUBAGENTS: ['', '0'],
  MERCURY_SESSION_WORKFLOWS: ['', '0'],
  MERCURY_COMPUTER_USE: ['', '0'],
  MERCURY_COMPUTER_ACCESS: ['', 'asks', 'permissive', 'full'],
  MERCURY_SKIP_PERMISSIONS: ['', '1'],
  MERCURY_DESKTOP_DRIVER: ['', 'fake'],
  MERCURY_DESKTOP_FAKE_SCENE: ['', '/tmp/sweep-scene.json'],
  MERCURY_DESKTOP_FAKE_LOG: ['', '/tmp/sweep-acts.jsonl'],
  MERCURY_DESKTOP_PACK_DIR: ['', '/tmp/sweep-desktop-pack'],
}

const CLUSTERS: Record<string, string[]> = {
  'durable-kernel': ['MERCURY_GROUP_COMMIT', 'MERCURY_DURABLE_FSYNC'],
  changeset: ['MERCURY_CHANGESET', 'MERCURY_CHANGE_RECEIPTS', 'MERCURY_EDIT_HUNKS', 'MERCURY_LSP'],
  'model-harness': ['MERCURY_HARNESS_PROFILE', 'MERCURY_HARNESS_PROFILE_PIN'],
  continuum: ['MERCURY_CONTEXT_SELECTION', 'MERCURY_SELECTION_BUDGET', 'MERCURY_CAP_FAILOVER', 'MERCURY_MOCK_LIMITS', 'MERCURY_SCRIPTED_STREAM'],
  'terminal-appearance': ['MERCURY_THEME_PIN', 'MERCURY_OASIS_BG', 'MERCURY_LIVE_GLYPHS', 'MERCURY_CRITTER_GAZE'],
  'splash-motion': ['MERCURY_LAUNCH_RIPPLE', 'MERCURY_REDUCED_MOTION'],
  'splash-handover': ['MERCURY_SPLASH_HANDOFF', 'MERCURY_LAUNCH_ID'],
  concourse: ['MERCURY_CONCOURSE', 'MERCURY_CONCOURSE_WORKER'],
  'spawn-switches': ['MERCURY_SESSION_SUBAGENTS', 'MERCURY_SESSION_WORKFLOWS'],
}

function isOn(env: string, value: string): boolean {
  const kind = byEnv.get(env)?.kind
  if (kind === 'default-on') return value !== '0'
  if (kind === 'opt-in') return value === '1'
  return value !== ''
}

const touched = new Set<string>()
for (const e of Object.keys(DOMAINS)) {
  touched.add(e)
  const legacy = byEnv.get(e)?.legacy
  if (legacy) touched.add(legacy)
}
const saved = new Map<string, string | undefined>()
for (const k of touched) saved.set(k, process.env[k])
function applyVector(cluster: string[], vec: string[]): void {
  for (const k of touched) delete process.env[k]
  for (let i = 0; i < cluster.length; i++) {
    if (vec[i] !== '') process.env[cluster[i]!] = vec[i]
  }
}

interface Excluded {
  vector: Record<string, string>
  constraint: string
}
interface ClusterReport {
  name: string
  flags: string[]
  vectorsRun: number
  excluded: Excluded[]
  pairEdges: number
  pairStatesCovered: number
  vacuous?: string
}

let assertionFailures = 0
function probeVector(clusterName: string, cluster: string[], vec: string[]): void {
  const val = (env: string): string => vec[cluster.indexOf(env)] ?? ''
  const expectOn = (env: string): boolean => isOn(env, val(env))
  for (const env of cluster) {
    const spec = byEnv.get(env)!
    if (spec.kind === 'default-on' || spec.kind === 'opt-in') {
      if (flagEnabled(env) !== expectOn(env)) {
        assertionFailures++
        console.log(`     [${clusterName}] flagEnabled(${env}) ≠ expected under ${JSON.stringify(vec)}`)
      }
    } else {
      const got = flagEnv(env) ?? ''
      if (got !== val(env)) {
        assertionFailures++
        console.log(`     [${clusterName}] flagEnv(${env})='${got}' ≠ '${val(env)}'`)
      }
    }
  }
  if (clusterName === 'changeset') {
    const want = expectOn('MERCURY_CHANGESET') && expectOn('MERCURY_CHANGE_RECEIPTS') && expectOn('MERCURY_EDIT_HUNKS')
    if (changeSetEnabled() !== want) {
      assertionFailures++
      console.log(`     changeSetEnabled ≠ composes-law under ${JSON.stringify(vec)}`)
    }
  }
  if (clusterName === 'continuum') {
    const policy = resolveSelectionPolicy(null)
    const wantPolicy = val('MERCURY_CONTEXT_SELECTION') === 'bounded-optional' ? 'bounded-optional' : 'preserve-all'
    if (policy !== wantPolicy) {
      assertionFailures++
      console.log(`     selection policy '${policy}' ≠ '${wantPolicy}' under ${JSON.stringify(vec)}`)
    }
    const budget = resolveSelectionBudget(undefined)
    const wantBudget = val('MERCURY_SELECTION_BUDGET') !== ''
    if ((budget.budget !== null) !== wantBudget) {
      assertionFailures++
      console.log(`     selection budget presence diverged under ${JSON.stringify(vec)}`)
    }
  }
  if (clusterName === 'terminal-appearance') {
    if (liveGlyphsEnabled() !== expectOn('MERCURY_LIVE_GLYPHS')) {
      assertionFailures++
      console.log(`     liveGlyphsEnabled diverged under ${JSON.stringify(vec)}`)
    }
  }
  if (clusterName === 'durable-kernel') {
    if (fsyncEnabled() !== (val('MERCURY_DURABLE_FSYNC') !== '0')) {
      assertionFailures++
      console.log(`     fsyncEnabled diverged under ${JSON.stringify(vec)}`)
    }
  }
  if (clusterName === 'concourse') {
    const raw = val('MERCURY_CONCOURSE')
    const want = raw === 'auto' || raw === 'always' ? raw : 'off'
    if (resolveConcoursePolicy() !== want) {
      assertionFailures++
      console.log(`     resolveConcoursePolicy ≠ '${want}' under ${JSON.stringify(vec)}`)
    }
  }
  if (clusterName === 'spawn-switches') {
    for (const [kind, env] of [
      ['subagents', 'MERCURY_SESSION_SUBAGENTS'],
      ['workflows', 'MERCURY_SESSION_WORKFLOWS'],
    ] as const) {
      const born = bornSpawnSwitch(kind)
      const wantSource = val(env) === '' ? 'default' : 'env'
      if (born.on !== expectOn(env) || born.source !== wantSource) {
        assertionFailures++
        console.log(`     bornSpawnSwitch(${kind}) = ${JSON.stringify(born)} ≠ on:${expectOn(env)} source:${wantSource} under ${JSON.stringify(vec)}`)
      }
    }
  }
  if (clusterName === 'cross:MERCURY_COMPUTER_ACCESS×MERCURY_SKIP_PERMISSIONS' || clusterName === 'cross:MERCURY_COMPUTER_ACCESS×MERCURY_COMPUTER_USE') {
    const savedAccess = val('MERCURY_COMPUTER_ACCESS')
    const sovereign = flagEnabled('MERCURY_SKIP_PERMISSIONS')
    const got = resolveComputerAccess(flagEnv('MERCURY_COMPUTER_ACCESS'), sovereign)
    const want = savedAccess !== '' ? { value: savedAccess, source: 'saved' } : sovereign ? { value: 'full', source: 'sovereign mode' } : { value: 'asks', source: 'default' }
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      assertionFailures++
      console.log(`     resolveComputerAccess = ${JSON.stringify(got)} ≠ ${JSON.stringify(want)} under ${JSON.stringify(vec)}`)
    }
  }
  if (clusterName === 'splash-handover') {
    const own = flagEnv('MERCURY_LAUNCH_ID') || null
    const receipt = (id?: string): string =>
      JSON.stringify({ version: 1, ts: 1_000, action: 'continue', ...(id ? { launchId: id } : {}) })
    const foreign = decideSplashReceipt(receipt('someone-else'), 1_000, () => true, own)
    const wantForeign = own !== null
    if ((foreign.reason === 'foreign-launch') !== wantForeign) {
      assertionFailures++
      console.log(`     foreign-id gating diverged under ${JSON.stringify(vec)}`)
    }
    const matching = decideSplashReceipt(receipt(own ?? undefined), 1_000, () => true, own)
    if (matching.apply?.spliceArg !== '--continue') {
      assertionFailures++
      console.log(`     matching-id application diverged under ${JSON.stringify(vec)}`)
    }
  }
}

const reports: ClusterReport[] = []
for (const [name, cluster] of Object.entries(CLUSTERS)) {
  const domains = cluster.map(e => DOMAINS[e]!)
  const vectors: string[][] = domains.reduce<string[][]>(
    (acc, dom) => acc.flatMap(v => dom.map(d => [...v, d])),
    [[]],
  )
  const excluded: Excluded[] = []
  const run: string[][] = []
  for (const vec of vectors) {
    let constraint: string | null = null
    for (let i = 0; i < cluster.length && !constraint; i++) {
      const env = cluster[i]!
      if (!isOn(env, vec[i]!)) continue
      for (const req of byEnv.get(env)?.requires ?? []) {
        const j = cluster.indexOf(req)
        const reqOn = j >= 0 ? isOn(req, vec[j]!) : isOn(req, '')
        if (!reqOn) {
          constraint = `${env} requires ${req}`
          break
        }
      }
    }
    if (constraint) {
      excluded.push({ vector: Object.fromEntries(cluster.map((e, i) => [e, vec[i]! || '(unset)'])), constraint })
      continue
    }
    applyVector(cluster, vec)
    probeVector(name, cluster, vec)
    run.push(vec)
  }
  for (const env of cluster) {
    const spec = byEnv.get(env)!
    if (!spec.legacy) continue
    for (const k of touched) delete process.env[k]
    process.env[env] = 'canonical-value'
    process.env[spec.legacy] = 'legacy-value'
    if (flagEnv(env) !== 'canonical-value') {
      assertionFailures++
      console.log(`     canonical did NOT beat alias for ${env}`)
    }
    delete process.env[env]
    if (flagEnv(env) !== 'legacy-value') {
      assertionFailures++
      console.log(`     the bounded alias did not resolve for ${env} (${spec.legacy})`)
    }
  }
  let pairEdges = 0
  let statesCovered = 0
  for (const a of cluster) {
    for (const b of byEnv.get(a)?.interactsWith ?? []) {
      if (cluster.indexOf(b) <= cluster.indexOf(a)) continue
      pairEdges++
      const ai = cluster.indexOf(a)
      const bi = cluster.indexOf(b)
      const seen = new Set(run.map(v => `${isOn(a, v[ai]!)}·${isOn(b, v[bi]!)}`))
      const validStates = new Set<string>()
      for (const av of DOMAINS[a]!) {
        for (const bv of DOMAINS[b]!) {
          const aOn = isOn(a, av)
          const bOn = isOn(b, bv)
          const reqA = byEnv.get(a)?.requires ?? []
          const reqB = byEnv.get(b)?.requires ?? []
          if (aOn && reqA.includes(b) && !bOn) continue
          if (bOn && reqB.includes(a) && !aOn) continue
          validStates.add(`${aOn}·${bOn}`)
        }
      }
      const covered = [...validStates].every(s => seen.has(s))
      if (covered) statesCovered++
      else {
        assertionFailures++
        console.log(`     pair ${a}×${b}: valid states not fully covered`)
      }
    }
  }
  reports.push({ name, flags: cluster, vectorsRun: run.length, excluded, pairEdges, pairStatesCovered: statesCovered })
}
for (const [k, v] of saved) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

{
  const clusterSets = Object.values(CLUSTERS).map(c => new Set(c))
  const crossEdges: Array<[string, string]> = []
  const seenEdge = new Set<string>()
  for (const f of FLAG_REGISTRY) {
    for (const b of f.interactsWith ?? []) {
      const key = [f.env, b].sort().join('×')
      if (seenEdge.has(key)) continue
      seenEdge.add(key)
      if (clusterSets.some(s => s.has(f.env) && s.has(b))) continue
      crossEdges.push([f.env, b].sort() as [string, string])
    }
  }
  crossEdges.sort((x, y) => x.join().localeCompare(y.join()))
  let pairStatesCovered = 0
  const excluded: Excluded[] = []
  let vectorsRun = 0
  for (const [a, b] of crossEdges) {
    const domA = DOMAINS[a]
    const domB = DOMAINS[b]
    if (!domA || !domB) {
      assertionFailures++
      console.log(`     cross-cluster edge ${a}×${b}: missing sweep domain — extend DOMAINS`)
      continue
    }
    const pair = [a, b]
    const seenStates = new Set<string>()
    for (const av of domA) {
      for (const bv of domB) {
        const vec = [av, bv]
        let constraint: string | null = null
        for (let i = 0; i < 2 && !constraint; i++) {
          const env = pair[i]!
          if (!isOn(env, vec[i]!)) continue
          for (const req of byEnv.get(env)?.requires ?? []) {
            const j = pair.indexOf(req)
            const reqOn = j >= 0 ? isOn(req, vec[j]!) : isOn(req, '')
            if (!reqOn) {
              constraint = `${env} requires ${req}`
              break
            }
          }
        }
        if (constraint) {
          excluded.push({ vector: Object.fromEntries(pair.map((e, i) => [e, vec[i]! || '(unset)'])), constraint })
          continue
        }
        applyVector(pair, vec)
        probeVector(`cross:${a}×${b}`, pair, vec)
        vectorsRun++
        seenStates.add(`${isOn(a, av)}·${isOn(b, bv)}`)
      }
    }
    const validStates = new Set<string>()
    for (const av of domA) {
      for (const bv of domB) {
        const aOn = isOn(a, av)
        const bOn = isOn(b, bv)
        const reqA = byEnv.get(a)?.requires ?? []
        const reqB = byEnv.get(b)?.requires ?? []
        if (aOn && reqA.includes(b) && !bOn) continue
        if (bOn && reqB.includes(a) && !aOn) continue
        validStates.add(`${aOn}·${bOn}`)
      }
    }
    if ([...validStates].every(s => seenStates.has(s))) pairStatesCovered++
    else {
      assertionFailures++
      console.log(`     cross-cluster pair ${a}×${b}: valid states not fully covered`)
    }
  }
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  reports.push({
    name: 'cross-cluster-pairs',
    flags: crossEdges.map(e => e.join('×')),
    vectorsRun,
    excluded,
    pairEdges: crossEdges.length,
    pairStatesCovered,
  })
}

const crucibleFlags = FLAG_REGISTRY.filter(f => /crucible|glassbird/i.test(f.env))
reports.push({
  name: 'crucible-runner',
  flags: [],
  vectorsRun: 0,
  excluded: [],
  pairEdges: 0,
  pairStatesCovered: 0,
  vacuous: `no registered runtime flag matches /crucible|glassbird/ (${crucibleFlags.length} hits) — the benchmark runner parameterizes via CLI arguments, not env`,
})

t.section('§1 — the constrained exhaustive sweep with semantic assertions')
t.check('every semantic assertion held across every valid vector', assertionFailures === 0, `${assertionFailures} failure(s)`)
t.check(
  'the crucible-runner cluster is vacuous by inspection',
  crucibleFlags.length === 0,
  crucibleFlags.map(f => f.env).join(','),
)
const totalRun = reports.reduce((n, r) => n + r.vectorsRun, 0)
const totalExcluded = reports.reduce((n, r) => n + r.excluded.length, 0)
t.check(`a real sweep ran (${totalRun} valid vectors; ${totalExcluded} excluded with named constraints)`, totalRun >= 80 && totalExcluded >= 8)
t.check(
  'every interactsWith pair edge is fully state-covered',
  reports.every(r => r.pairEdges === r.pairStatesCovered),
)

t.finish('prove-flag-interactions')
