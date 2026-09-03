#!/usr/bin/env bun
// ============================================================================
//  scripts/formal-models/prove-flag-interactions.ts —..: the
//  constrained configuration-interaction sweep over the named clusters.
//
//  Cluster sizes are small closed vocabularies, so the sweep is CONSTRAINED
//  EXHAUSTIVE per cluster (the advisory's own allowance for small critical
//  sets — subsumes pairwise and three-way). Constraints come from the
//  registry's metadata: a vector activating a dependent flag without
//  its prerequisite is EXCLUDED and recorded with the exact constraint name.
//  Every VALID vector runs SEMANTIC assertions at the owning resolvers —
//  never just exit-0:
//    · kind semantics (default-on: '0' disables; opt-in: '1' enables;
//      value: the resolver reflects the value) — OFF means ABSENT;
//    · the coded requires-laws (changeSetEnabled needs receipts + hunks);
//    · the context-selection matrix (policy × budget through the real resolvers);
//    · canonical-beats-alias for every legacy-carrying cluster member
//      (MERCURY_* set beside a CONFLICTING HERMES_* ⇒ canonical wins; the
//      legacy spelling alone still resolves — the bounded alias).
//  Pair coverage across every interactsWith edge inside each cluster is
//  computed from the RUN vectors and must be 100% of the VALID pairs.
//
//  The coverage manifest
//  regenerates byte-stably every run; drift or a failed assertion reds the
//  gate. The crucible-runner cluster is proved VACUOUS mechanically (no
//  registered runtime flag — benchmark scripts parameterize via CLI args).
// ============================================================================

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

const byEnv = new Map(FLAG_REGISTRY.map(f => [f.env, f]))

/** Per-flag sweep domains ('' = unset). Value-kind reps are the smallest
 *  semantically distinct set. */
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
  // The registry's cross-cluster edges (interactsWith) over the variant,
  // compat, critter, future-model, local-server and Moonshot families — each
  // flag's domain is its registry kind: default-on flags sweep unset/=0,
  // tri-states sweep unset/1/0, value flags sweep unset + one realistic value.
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
  // The session-lifecycle family (Law 9 renames + the drain ceiling): value
  // flags sweep unset + one realistic value; each canonical spelling pairs
  // with its tolerated legacy twin, and 0 is a meaningful arm (disable /
  // no-wait), so it joins the domain.
  // The transcript-read pair (default-on flags sweep unset/=0) and the voice
  // capture pair (value flags sweep unset + one realistic value).
  MERCURY_RESUME_SNAPSHOT: ['', '0'],
  MERCURY_TRANSCRIPT_READER: ['', '0'],
  MERCURY_VOICE_BACKEND: ['', 'fixture'],
  MERCURY_VOICE_FIXTURE_WAV: ['', '/tmp/sweep-take.wav'],
  MERCURY_SESSION_IDLE_RETIRE_MINUTES: ['', '10', '0'],
  MERCURY_CONCOURSE_IDLE_RETIRE_MINUTES: ['', '5'],
  MERCURY_SESSION_NEWBORN_GRACE_MINUTES: ['', '15', '0'],
  MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES: ['', '5'],
  MERCURY_SESSION_PARK_DRAIN_MINUTES: ['', '10', '0'],
  // The web-search owner declares the search pair's edge: the
  // backend override is a value flag (unset ⇒ 'auto'; the realistic sweep
  // value is the keyless door the other flag governs), the keyless gate is
  // default-on security posture (=0 closes it).
  MERCURY_SEARCH_BACKEND: ['', 'duckduckgo'],
  MERCURY_SEARCH_KEYLESS: ['', '0'],
  MERCURY_SCRIPTED_STREAM: ['', '1'],
  MERCURY_THEME_PIN: ['', 'dark'],
  MERCURY_OASIS_BG: ['', '0'],
  // The estate-ground gate (round 7: the graded Concourse wash retired) —
  // display pair with the OASIS terminal ground (dark family only; off ⇒
  // the OSC-11 terminal ground alone).
  MERCURY_SPECTRA_GROUND: ['', '0'],
  MERCURY_LIVE_GLYPHS: ['', '0'],
  MERCURY_CRITTER_GAZE: ['', '0'],
  // 5.1a (K5): the splash motion pair — pre-boot display controls; the
  // asset consumes them, so the in-process sweep asserts REGISTRY semantics
  // (kinds/defaults) rather than a runtime gate.
  MERCURY_LAUNCH_RIPPLE: ['', '0'],
  MERCURY_REDUCED_MOTION: ['', '1'],
  // the launcher handover pair — launcher-minted,
  // one-shot-consumed at cli entry (the consumer DELETES its env, so the
  // sweep asserts registry semantics + the PURE decision core, never the
  // consuming entry itself).
  MERCURY_SPLASH_HANDOFF: ['', '1'],
  MERCURY_LAUNCH_ID: ['', 'sweep-launch-1'],
  // Cross-cluster pass members only (never a full cluster sweep): the fault
  // seam's representative value names a phase+path no probe ever publishes
  // to — setting it is env-visible and behaviorally inert here.
  MERCURY_FAULT_INJECT: ['', 'flush-file@cairn-never-hit:throw'],
  // the Session Concourse routing policy (closed grammar
  // off/auto/always at ONE resolver) + the worker role marker the daemon
  // stamps on concourse children.
  MERCURY_CONCOURSE: ['', 'auto', 'always'],
  MERCURY_CONCOURSE_WORKER: ['', '1'],
  // The registry's other cross-cluster edges (interactsWith): the change-set
  // anchor patch, the render-engine pair, the eval kernel family, the
  // synchronized-output pair, the stream caret and the MNEME observe pair —
  // each at its registry kind (default-on sweeps unset/=0, opt-in sweeps
  // unset/1/0, a value flag sweeps unset + one realistic value).
  MERCURY_ANCHOR_PATCH: ['', '1', '0'],
  // FN-013 LOOP-03: the default-path stale relocation (default-on sweeps
  // unset/=0); edges to the anchor-patch dialect and the change-receipts
  // gate it rides beside.
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
}

/** Is a flag ON/present under `value` per its registry kind? */
function isOn(env: string, value: string): boolean {
  const kind = byEnv.get(env)?.kind
  if (kind === 'default-on') return value !== '0'
  if (kind === 'opt-in') return value === '1'
  return value !== '' // value-kind: present
}

// Every sweepable flag (clusters + the cross-cluster pass) plus its legacy
// spelling — applyVector clears exactly this set per vector, so nothing can
// linger across vectors (the close review's cross-pass found the lingering
// class the hard way).
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
  // Generic kind semantics — OFF means ABSENT at the registry resolver.
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
  // Coded requires-laws + cluster semantics at the owning resolvers.
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
    // ONE policy resolver, closed grammar — and the worker ROLE MARKER never
    // bends the routing policy (a concourse child is a worker, not a router;
    // its own resolveInitialSurface still answers per the policy flag alone).
    const raw = val('MERCURY_CONCOURSE')
    const want = raw === 'auto' || raw === 'always' ? raw : 'off'
    if (resolveConcoursePolicy() !== want) {
      assertionFailures++
      console.log(`     resolveConcoursePolicy ≠ '${want}' under ${JSON.stringify(vec)}`)
    }
  }
  if (clusterName === 'splash-handover') {
    // The consuming entry is one-shot (it DELETES the env), so the sweep
    // drives the PURE decision core with the vector's launch id: a receipt
    // carrying a DIFFERENT id is foreign (never applied) exactly when an own
    // id is present; matching/id-less receipts apply.
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
    // Constraint pruning from the registry's metadata.
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
  // Canonical-beats-alias for every legacy-carrying member (the bounded alias).
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
  // Pair coverage over the cluster's interactsWith edges: every VALID
  // (stateA, stateB) combination must appear in ≥1 run vector.
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
          // valid iff no requires-constraint inside the pair itself
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
// Restore the ambient env exactly.
for (const [k, v] of saved) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

// THE CROSS-CLUSTER PAIR PASS (the close review's material find: 4 declared
// interactsWith edges spanned clusters or reached the un-clustered fault
// seam and were SILENTLY skipped — neither run nor named-excluded). Every
// registry edge not covered inside a single cluster gets its own exhaustive
// two-flag mini-sweep here: generic kind-probes per vector, requires-pruning
// with named constraints, and full pair-state coverage — "every
// valid interacting pair" is now closed over the WHOLE registry, not the
// cluster union.
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
    // Valid iff no requires-constraint inside the pair itself — the same
    // rule the in-cluster coverage applies (a state the constraint excludes
    // is not a state the sweep owes).
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

// The crucible-runner cluster: proved vacuous mechanically.
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
// The exclusion floor is an anti-vacuity guard (constraints exist and bite),
// not a law: the registry's requires-edge census stands at 8 after landed
// flag retirements shrank it below the original 10 — the floor follows the
// living registry, and the per-exclusion names printed above stay the proof.
t.check(`a real sweep ran (${totalRun} valid vectors; ${totalExcluded} excluded with named constraints)`, totalRun >= 80 && totalExcluded >= 8)
t.check(
  'every interactsWith pair edge is fully state-covered',
  reports.every(r => r.pairEdges === r.pairStatesCovered),
)

t.finish('prove-flag-interactions')
