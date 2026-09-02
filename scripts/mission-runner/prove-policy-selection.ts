// ============================================================================
//  prove-policy-selection.ts — the H3 bounded-policy laws (pure + one store
//  roundtrip under a scratch MERCURY_ROUTER_STATE_DIR).
//
//  §7 selection rules, mechanically:
//    profiles: ≤6, named, digest-stable, nothing below the model floor;
//    pin wins + recorded; unavailable pinned combos decline by availability;
//    task facts dominate; width follows separability, never size;
//    low-sample / wrong-epoch history IGNORED and NAMED; history adjusts
//    only between adjacent solo profiles; contradiction ⇒ named fallback;
//    epoch shifts when the catalogue/profile-set shifts; the mission store
//    lane never leaks into the route-kernel priors.
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MISSION_PROFILES,
  missionPolicyEpoch,
  missionProfileDigest,
  selectMissionPolicy,
  type MissionTaskFingerprint,
} from '../../src/services/mission/policyProfiles.js'
import { OUTCOME_MAX_WEIGHT } from '../../src/utils/router/routeCompiler.js'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log('  ok  ' + label)
  else {
    failures += 1
    console.log('  FAIL ' + label + (detail ? ' — ' + detail : ''))
  }
}

const fp = (partial: Partial<MissionTaskFingerprint> = {}): MissionTaskFingerprint => ({
  shape: 'bounded',
  separableLanes: 1,
  couplingBand: 1,
  ambiguityBand: 1,
  mechanical: false,
  investigation: false,
  ...partial,
})

const EPOCH = missionPolicyEpoch({ architectureEpoch: 'apex-1', frontierDefaultModel: 'claude-opus-4-8' })
const base = { epoch: EPOCH, pin: null, solEngineQualified: true, history: [] as never[] }

// ── profiles ────────────────────────────────────────────────────────────────
check('at most six profiles', MISSION_PROFILES.length <= 6, String(MISSION_PROFILES.length))
const digests = MISSION_PROFILES.map(missionProfileDigest)
check('profile digests distinct + shaped', new Set(digests).size === digests.length && digests.every(d => /^mp1-[0-9a-f]{16}$/.test(d)))
check('digest is stable', missionProfileDigest(MISSION_PROFILES[0]) === digests[0])
check('nothing below the model floor', !JSON.stringify(MISSION_PROFILES).toLowerCase().includes('haiku'))

// ── pin law ─────────────────────────────────────────────────────────────────
const pinned = selectMissionPolicy({ ...base, fingerprint: fp(), pin: 'routed-wide' })
check('pin wins and is recorded', pinned.profile.id === 'routed-wide' && pinned.source === 'operator-pin' && pinned.reasonCodes.includes('pin-wins'))
const pinnedUnavailable = selectMissionPolicy({ ...base, fingerprint: fp(), pin: 'specialist-sol', solEngineQualified: false })
check('unavailable pin declines by availability', pinnedUnavailable.profile.id === 'solo-default' && pinnedUnavailable.source === 'fallback')
check('the decline is named', pinnedUnavailable.declined.some(d => d.profileId === 'specialist-sol' && d.reason === 'engine-unqualified-fallback'))

// ── facts dominate ──────────────────────────────────────────────────────────
check('investigation ⇒ solo-default', selectMissionPolicy({ ...base, fingerprint: fp({ shape: 'research', investigation: true }) }).profile.id === 'solo-default')
const mech = selectMissionPolicy({ ...base, fingerprint: fp({ shape: 'mechanical', mechanical: true }) })
check('mechanical + qualified ⇒ specialist-sol', mech.profile.id === 'specialist-sol' && mech.reasonCodes.includes('mechanical-shape'))
const mechNoSol = selectMissionPolicy({ ...base, fingerprint: fp({ shape: 'mechanical', mechanical: true }), solEngineQualified: false })
check('mechanical + unqualified ⇒ named fallback', mechNoSol.profile.id === 'solo-default' && mechNoSol.reasonCodes.includes('engine-unqualified-fallback'))
const wide = selectMissionPolicy({ ...base, fingerprint: fp({ separableLanes: 3, couplingBand: 0 }) })
check('three disjoint lanes ⇒ routed-wide', wide.profile.id === 'routed-wide' && wide.reasonCodes.includes('separable-lanes'))
const lite = selectMissionPolicy({ ...base, fingerprint: fp({ separableLanes: 2, couplingBand: 1 }) })
check('two lanes ⇒ routed-lite (width capped)', lite.profile.id === 'routed-lite' && lite.reasonCodes.includes('width-capped-by-separability'))
// H5 candidate expectations: the
// auto-reviewer selections are RETIRED — coupled work serializes to solo,
// ambiguity keeps the frontier model solo; the reviewer profile remains
// pinnable and history-re-armable.
const coupled = selectMissionPolicy({ ...base, fingerprint: fp({ separableLanes: 2, couplingBand: 2 }) })
check('hidden shared owner serializes to SOLO', coupled.profile.id === 'solo-default' && coupled.reasonCodes.includes('coupling-serializes'))
const longHorizon = selectMissionPolicy({ ...base, fingerprint: fp({ shape: 'cross-cutting', separableLanes: 2, couplingBand: 1 }) })
check('long separable work ⇒ workflow-deep', longHorizon.profile.id === 'workflow-deep')
const ambiguous = selectMissionPolicy({ ...base, fingerprint: fp({ ambiguityBand: 2 }) })
check('ambiguity keeps the strongest planner SOLO', ambiguous.profile.id === 'solo-default' && ambiguous.reasonCodes.includes('ambiguity-strong-planner'))
check('the reviewer profile stays pinnable', selectMissionPolicy({ ...base, fingerprint: fp(), pin: 'solo-reviewer' }).profile.id === 'solo-reviewer')
check('plain bounded work stays solo', selectMissionPolicy({ ...base, fingerprint: fp() }).profile.id === 'solo-default')

// ── width follows separability, never size ──────────────────────────────────
for (const shape of ['bounded', 'diagnostic', 'architectural'] as const) {
  const single = selectMissionPolicy({ ...base, fingerprint: fp({ shape, separableLanes: 1 }) })
  check('lanes=1 never routes (' + shape + ')', single.profile.execution !== 'routed' && single.profile.execution !== 'workflow')
}

// ── history laws ────────────────────────────────────────────────────────────
const lowSample = selectMissionPolicy({
  ...base,
  fingerprint: fp(),
  history: [{ profileId: 'solo-default', epoch: EPOCH, sampleCount: 2, acceptedRate: 0 }],
})
check('low-sample history ignored + named', lowSample.profile.id === 'solo-default' && lowSample.reasonCodes.includes('history-low-sample-ignored'))
const wrongEpoch = selectMissionPolicy({
  ...base,
  fingerprint: fp(),
  history: [{ profileId: 'solo-default', epoch: 'pe1-stale', sampleCount: 50, acceptedRate: 0 }],
})
check('wrong-epoch history ignored + named', wrongEpoch.profile.id === 'solo-default' && wrongEpoch.reasonCodes.includes('history-epoch-mismatch-ignored'))
const adjusted = selectMissionPolicy({
  ...base,
  fingerprint: fp(),
  history: [{ profileId: 'solo-default', epoch: EPOCH, sampleCount: 8, acceptedRate: 0.3 }],
})
check('rich poor history adjusts to the ADJACENT profile', adjusted.profile.id === 'solo-reviewer' && adjusted.source === 'history-adjusted')
check('history weight rides the router cap', adjusted.history?.weight === OUTCOME_MAX_WEIGHT)
check('history can never route on its own', adjusted.profile.execution === 'solo')

// ── contradiction fallback ──────────────────────────────────────────────────
const conflicted = selectMissionPolicy({ ...base, fingerprint: fp({ mechanical: true, ambiguityBand: 2 }) })
check('contradictory facts fall back, named', conflicted.profile.id === 'solo-default' && conflicted.reasonCodes.includes('insufficient-confidence-fallback'))

// ── epoch derivation ────────────────────────────────────────────────────────
check('epoch is input-stable', EPOCH === missionPolicyEpoch({ architectureEpoch: 'apex-1', frontierDefaultModel: 'claude-opus-4-8' }))
check('a catalogue change shifts the epoch', EPOCH !== missionPolicyEpoch({ architectureEpoch: 'apex-1', frontierDefaultModel: 'gpt-6' }))
check('an engine-estate change shifts the epoch', EPOCH !== missionPolicyEpoch({ architectureEpoch: 'apex-2', frontierDefaultModel: 'claude-opus-4-8' }))

// ── the store lane (scratch dir; mission rows invisible to router priors) ───
const scratch = mkdtempSync(join(tmpdir(), 'helix-policy-store-'))
process.env.MERCURY_ROUTER_STATE_DIR = scratch
{
  const { recordMissionOutcome, readMissionOutcomeStats, readOutcomeSnapshot } = await import(
    '../../src/substrate/routerOutcomeStore.js'
  )
  const now = Date.now()
  await recordMissionOutcome({ profileId: 'solo-default', taskShape: 'bounded', ambiguity: 1, coupling: 1, accepted: true, epoch: EPOCH, modelClass: 'opus', now })
  await recordMissionOutcome({ profileId: 'solo-default', taskShape: 'bounded', ambiguity: 1, coupling: 1, accepted: false, epoch: 'pe1-stale', modelClass: 'opus', now })
  const stats = await readMissionOutcomeStats({ taskShape: 'bounded', epoch: EPOCH, now })
  check('mission stats scope to the epoch', stats.perProfile.length === 1 && stats.perProfile[0].sampleCount === 1 && stats.perProfile[0].acceptedRate === 1)
  check('out-of-epoch rows are counted, not consumed', stats.outOfEpochRows === 1)
  const kernelPrior = await readOutcomeSnapshot({ mode: 'sequential', taskShape: 'bounded', ambiguity: 1, coupling: 1, now })
  check('mission rows never leak into the route-kernel priors', kernelPrior === undefined)
}
delete process.env.MERCURY_ROUTER_STATE_DIR
rmSync(scratch, { recursive: true, force: true })

// ── the selected-arm fingerprint mapping (ground truth from the corpus) ─────
{
  const { taskFingerprint } = await import('./live/selectedPolicy.js')
  const { taskById } = await import('./corpus/tasks.js')
  check('T20 fingerprints as three disjoint lanes', taskFingerprint(taskById('T20')).separableLanes === 3)
  check('T01 fingerprints as investigation', taskFingerprint(taskById('T01')).investigation === true)
  check('T24 fingerprints as mechanical', taskFingerprint(taskById('T24')).mechanical === true)
  check('T22 fingerprints as coupled', taskFingerprint(taskById('T22')).couplingBand === 2)
}

if (failures > 0) {
  console.error('prove-policy-selection: ' + failures + ' failure(s)')
  process.exit(1)
}
console.log('prove-policy-selection: green')
