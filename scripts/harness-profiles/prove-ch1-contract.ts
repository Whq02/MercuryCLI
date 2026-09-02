#!/usr/bin/env bun
// ============================================================================
//  scripts/harness-profiles/prove-ch1-contract.ts — the CH-1 contract proofs:
//  catalogue completeness (CH-07), digest canon + FROZEN accepted-default
//  digests (CH-06 / the byte-identity pin at the contract level), decoder
//  totality (CH-06), resolver determinism + bounded cache (CH-12/CH-28),
//  precedence with named fallthroughs (CH-11), the CH-14 conservative
//  default, history inertness at the opening state (CH-13), and the CH-40
//  epoch composition against the LIVE architecture-epoch constant.
//
//  Pure module proofs — no fs writes, no env reads, no ambient state.
// ============================================================================
import {
  HARNESS_PROFILE_IDS,
  HARNESS_PROFILES,
  HARNESS_ACCEPTED_DEFAULT_BY_FAMILY,
  HARNESS_MAX_QUALIFIED_POSTURES,
  HARNESS_REASON_CODES,
  harnessProfileById,
  harnessProfileDigest,
  harnessProfileSetDigest,
  harnessEvidenceEpoch,
  harnessFactsDigest,
  decodeHarnessProfile,
  resolveHarnessProfile,
  resolveHarnessProfileCached,
  _harnessResolveComputeCount,
  CONTINUUM_ARCHITECTURE_IDENTITY,
  type HarnessProfile,
  type HarnessResolutionInputs,
} from '../../src/services/mission/harnessProfiles.js'
import { APEX_ARCHITECTURE_EPOCH } from '../../src/services/providers/openai/openaiCatalogue.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// The frozen accepted-default digests: any semantic change to an accepted
// default MUST arrive as a deliberate version bump + a new pin here (the
// CH-2 equivalence proof re-runs), never as a silent drift.
// The accepted defaults' digests cover their operator-facing descriptions,
// which speak their plain names
// ("byte-identical to the unarmed behaviour"); the axes — the selection
// semantics the CH-2 equivalence proof certifies — did not move.
const FROZEN_DIGESTS: Record<string, string> = {
  'anthropic-default': 'hpr1-59e36b86b0d539b1',
  'openai-default': 'hpr1-be54a985fb6f5828',
  'zai-default': 'hpr1-271d7ce47867256e',
  // The shared chat-completions lanes' accepted
  // identity default (Moonshot · DeepSeek · compat) — minted
  // (hpr1-d27bb34fbeaa04cb); v2 widened its compatibility row to
  // the Hugging Face router and the local servers (a deliberate version
  // bump — the axes stayed the identity posture); its evidence anchor then
  // repointed to the accepted policy at bind (hpr1-57e930f9d57dc69d → the
  // value below; the axes unchanged).
  'chat-engine-default': 'hpr1-da9e2a1d79e85440',
  // The CH-4 H1a candidate — RETIRED on the first batch's evidence (v2;
  // outcome 'tie': paired walls indistinguishable, the mechanism inert
  // without a selection budget). The three accepted digests above never
  // moved through mint, retirement, OR the evidenceRef repoint — the
  // byte-identity pins held; the candidate digest and the SET digest below
  // moved at each deliberate semantic event (mint hpr1-974920d0… → retire
  // hpr1-c5a9d519… → the bundle-purity repoint of evidenceRef
  // off the benchmark-machinery path hpr1-0ab13c71… — every set change
  // retires prior history via the he1- epoch, the pe1- law).
  'anthropic-context-bounded': 'hpr1-7c977cfe16708267',
}
// Set digest moved when chat-engine-default was MINTED
// (a deliberate semantic event — the set gains one accepted identity row;
// the four prior digests held byte-identical); moved again with
// that row's v2 (two more families on the same identity posture); moved
// with the descriptions above; moved again with the chat-engine evidence
// anchor (the accepted policy at bind).
const FROZEN_SET_DIGEST = 'hprs1-fa61a9739feb5ba3'

console.log('§A catalogue completeness (CH-07)')
check('§A ids tuple matches the catalogue in order', JSON.stringify(HARNESS_PROFILE_IDS) === JSON.stringify(HARNESS_PROFILES.map(p => p.id)))
check('§A ids unique', new Set(HARNESS_PROFILES.map(p => p.id)).size === HARNESS_PROFILES.length)
for (const p of HARNESS_PROFILES) {
  check(
    `§A ${p.id}: schema/version/status/description/compatibility/taskEnvelope/axes/rollback complete`,
    p.schema === 1 &&
      Number.isInteger(p.version) &&
      p.version >= 1 &&
      ['candidate', 'qualified', 'accepted', 'retired'].includes(p.status) &&
      p.description.length > 0 &&
      Array.isArray(p.compatibility.providerFamilies) &&
      p.compatibility.providerFamilies.length > 0 &&
      Array.isArray(p.compatibility.modelFamilies) &&
      Array.isArray(p.compatibility.effortLevels) &&
      Array.isArray(p.compatibility.requiredCapabilities) &&
      Array.isArray(p.taskEnvelope.families) &&
      Array.isArray(p.taskEnvelope.complexityBands) &&
      harnessProfileById(p.rollbackProfileId) !== null,
  )
  check(
    `§A ${p.id}: axes carry exactly the six bounded axes`,
    JSON.stringify(Object.keys(p.axes).sort()) ===
      JSON.stringify(['context', 'delegationTopology', 'editingPosture', 'toolPresentation', 'turnRecovery', 'verificationPosture']),
  )
}
check(
  '§A estate cap: qualified+accepted ≤ ' + String(HARNESS_MAX_QUALIFIED_POSTURES),
  HARNESS_PROFILES.filter(p => p.status === 'qualified' || p.status === 'accepted').length <= HARNESS_MAX_QUALIFIED_POSTURES,
)
for (const [family, id] of Object.entries(HARNESS_ACCEPTED_DEFAULT_BY_FAMILY)) {
  const p = harnessProfileById(id)
  check(
    `§A family default ${family} → ${id}: accepted, family-compatible, rolls back to itself`,
    p !== null && p.status === 'accepted' && p.compatibility.providerFamilies.includes(family as never) && p.rollbackProfileId === p.id,
  )
}
const IDENTITY_STATES: Array<[string, (p: HarnessProfile) => boolean]> = [
  ['context is preserve-all/standard', p => p.axes.context.selectionPolicy === 'preserve-all' && p.axes.context.allocationBand === 'standard'],
  ['toolPresentation is standard/provider-default', p => p.axes.toolPresentation.catalogue === 'standard' && p.axes.toolPresentation.parallelCalls === 'provider-default'],
  ['editingPosture is owner-default', p => p.axes.editingPosture.preference === 'owner-default'],
  ['verificationPosture is standard/mission-owned', p => p.axes.verificationPosture.focusedCadence === 'standard' && p.axes.verificationPosture.reviewerBand === 'mission-owned'],
  ['turnRecovery is standard/standard', p => p.axes.turnRecovery.timeoutClass === 'standard' && p.axes.turnRecovery.heartbeat === 'standard'],
]
for (const p of HARNESS_PROFILES.filter(x => x.status === 'accepted')) {
  for (const [label, ok] of IDENTITY_STATES) {
    check(`§A accepted default ${p.id}: ${label} (identity by construction)`, ok(p))
  }
}

console.log('§B digest canon (CH-06)')
for (const p of HARNESS_PROFILES) {
  check(`§B ${p.id}: digest frozen ${FROZEN_DIGESTS[p.id]}`, harnessProfileDigest(p) === FROZEN_DIGESTS[p.id], harnessProfileDigest(p))
}
check('§B set digest frozen', harnessProfileSetDigest() === FROZEN_SET_DIGEST, harnessProfileSetDigest())
const base = HARNESS_PROFILES[0]!
const copyEdited = { ...base, description: 'a completely different display string' }
check('§B display copy is OUTSIDE the digest', harnessProfileDigest(copyEdited) === harnessProfileDigest(base))
const axisEdited: HarnessProfile = {
  ...base,
  axes: { ...base.axes, context: { ...base.axes.context, allocationBand: 'lean' } },
}
check('§B a semantic (axis) change MOVES the digest', harnessProfileDigest(axisEdited) !== harnessProfileDigest(base))
const reordered = JSON.parse(
  JSON.stringify({
    rollbackProfileId: base.rollbackProfileId,
    axes: base.axes,
    taskEnvelope: base.taskEnvelope,
    compatibility: base.compatibility,
    description: base.description,
    status: base.status,
    version: base.version,
    id: base.id,
    schema: base.schema,
    evidenceRef: base.evidenceRef,
  }),
) as HarnessProfile
check('§B key order cannot move the digest (canonical stringify)', harnessProfileDigest(reordered) === harnessProfileDigest(base))

console.log('§C decoder totality (CH-06)')
const roundTrip = decodeHarnessProfile(JSON.parse(JSON.stringify(base)))
check('§C catalogue entry round-trips', roundTrip.ok && harnessProfileDigest(roundTrip.profile) === harnessProfileDigest(base))
const withUnknown = decodeHarnessProfile({ ...JSON.parse(JSON.stringify(base)), futureField: 42, axes: { ...JSON.parse(JSON.stringify(base.axes)), futureAxis: {} } })
check(
  '§C unknown top-level + axis fields tolerated AND reported',
  withUnknown.ok && withUnknown.unknownFields.includes('futureField') && withUnknown.unknownFields.includes('axes.futureAxis'),
  withUnknown.ok ? withUnknown.unknownFields.join(',') : withUnknown.error,
)
const wrongSchema = decodeHarnessProfile({ ...JSON.parse(JSON.stringify(base)), schema: 2 })
check('§C a different schema is a TYPED error (decoder precedes schema change)', !wrongSchema.ok && wrongSchema.error === 'unsupported-schema:2')
for (const garbage of [null, 42, 'x', [], {}, { schema: 1 }, { ...JSON.parse(JSON.stringify(base)), compatibility: 'nope' }]) {
  const r = decodeHarnessProfile(garbage)
  check(`§C total on ${JSON.stringify(garbage)?.slice(0, 40) ?? 'undefined'}`, !r.ok && typeof r.error === 'string' && r.error.length > 0, r.ok ? 'decoded' : r.error)
}

console.log('§D determinism + bounded cache (CH-12 / CH-28)')
const factsAnthropic: HarnessResolutionInputs = {
  sessionPin: null,
  persistedPin: null,
  facts: { providerFamily: 'anthropic', modelId: 'claude-fable-5', modelFamily: 'fable', effortLevel: 'xhigh', modelKnown: true, capabilities: [] },
  taskFactsDigest: 'tf-1',
  evidenceEpoch: 'he1-testepoch0000000',
  history: [],
}
const r1 = resolveHarnessProfile(factsAnthropic)
const r2 = resolveHarnessProfile(factsAnthropic)
check('§D identical inputs → identical resolution', JSON.stringify(r1) === JSON.stringify(r2))
check('§D resolution is deep-frozen', Object.isFrozen(r1) && Object.isFrozen(r1.reasonCodes) && Object.isFrozen(r1.declined))
check('§D factsDigest is stable + hf1- shaped', r1.factsDigest === harnessFactsDigest(factsAnthropic) && r1.factsDigest.startsWith('hf1-'))
const before = _harnessResolveComputeCount()
const c1 = resolveHarnessProfileCached(factsAnthropic)
const c2 = resolveHarnessProfileCached(factsAnthropic)
check('§D cache: two identical cached calls compute ONCE', _harnessResolveComputeCount() === before + 1 && c1 === c2)
check('§D cache ≡ pure', JSON.stringify(c1) === JSON.stringify(r1))
const c3 = resolveHarnessProfileCached({ ...factsAnthropic, sessionPin: 'anthropic-default' })
check('§D a pin change re-computes (new key)', _harnessResolveComputeCount() === before + 2 && c3.origin === 'session-pin')

console.log('§E precedence + named fallthroughs (CH-11)')
check('§E null pins → the selector path → the accepted family default', r1.origin === 'accepted-default' && r1.profileId === 'anthropic-default' && r1.reasonCodes[0] === 'no-qualified-candidate')
const sessionPinned = resolveHarnessProfile({ ...factsAnthropic, sessionPin: 'anthropic-default', persistedPin: 'zai-default' })
check('§E session pin wins over persisted pin', sessionPinned.origin === 'session-pin' && sessionPinned.profileId === 'anthropic-default' && sessionPinned.reasonCodes[0] === 'session-pin-wins')
const persistedOnly = resolveHarnessProfile({ ...factsAnthropic, persistedPin: 'anthropic-default' })
check('§E persisted pin wins when no session pin', persistedOnly.origin === 'persisted-pin' && persistedOnly.reasonCodes[0] === 'persisted-pin-wins')
const unknownPin = resolveHarnessProfile({ ...factsAnthropic, sessionPin: 'no-such-profile', persistedPin: 'anthropic-default' })
check(
  '§E unknown session pin falls through NAMED to the persisted pin',
  unknownPin.origin === 'persisted-pin' && unknownPin.declined.some(d => d.profileId === 'no-such-profile' && d.reason === 'pin-unknown-fallthrough'),
)
const incompatiblePin = resolveHarnessProfile({ ...factsAnthropic, sessionPin: 'openai-default' })
check(
  '§E family-incompatible pin falls through NAMED (never a silent substitute)',
  incompatiblePin.origin === 'accepted-default' &&
    incompatiblePin.profileId === 'anthropic-default' &&
    incompatiblePin.declined.some(d => d.profileId === 'openai-default' && d.reason === 'pin-incompatible-fallthrough'),
)
const factsOpenai: HarnessResolutionInputs = {
  ...factsAnthropic,
  facts: { providerFamily: 'openai', modelId: 'gpt-5.6-sol', modelFamily: 'gpt', effortLevel: 'high', modelKnown: true, capabilities: [] },
}
const openaiRes = resolveHarnessProfile(factsOpenai)
check('§E the openai family resolves its own accepted default', openaiRes.profileId === 'openai-default')
const zaiRes = resolveHarnessProfile({ ...factsAnthropic, facts: { ...factsAnthropic.facts, providerFamily: 'zai', modelId: 'glm-5', modelFamily: 'glm' } })
check('§E the zai family resolves its own accepted default', zaiRes.profileId === 'zai-default')
// The CH-4 candidate paths (exercisable since the minting):
const candidate = harnessProfileById('anthropic-context-bounded')!
const defaultProfile = harnessProfileById('anthropic-default')!
const axisDiffs = (Object.keys(candidate.axes) as Array<keyof typeof candidate.axes>).filter(
  k => JSON.stringify(candidate.axes[k]) !== JSON.stringify(defaultProfile.axes[k]),
)
check(
  '§E the retired candidate changed exactly ONE mechanism (the context axis)',
  candidate.status === 'retired' &&
    JSON.stringify(axisDiffs) === JSON.stringify(['context']) &&
    candidate.axes.context.selectionPolicy === 'bounded-optional' &&
    candidate.axes.context.allocationBand === 'standard' &&
    candidate.rollbackProfileId === 'anthropic-default',
)
// RETIRED (the first batch's tie): BOTH pin tiers now decline the retired profile
// NAMED — retirement is visible and total (CH-34), never a silent substitute.
const sessionPinnedRetired = resolveHarnessProfile({ ...factsAnthropic, sessionPin: 'anthropic-context-bounded' })
check(
  '§E a SESSION pin on the RETIRED profile falls through NAMED to the default',
  sessionPinnedRetired.origin === 'accepted-default' &&
    sessionPinnedRetired.profileId === 'anthropic-default' &&
    sessionPinnedRetired.declined.some(d => d.profileId === 'anthropic-context-bounded' && d.reason === 'pin-unavailable-fallthrough'),
)
const persistedPinnedRetired = resolveHarnessProfile({ ...factsAnthropic, persistedPin: 'anthropic-context-bounded' })
check(
  '§E a PERSISTED pin on the RETIRED profile falls through NAMED',
  persistedPinnedRetired.profileId === 'anthropic-default' &&
    persistedPinnedRetired.declined.some(d => d.profileId === 'anthropic-context-bounded' && d.reason === 'pin-unavailable-fallthrough'),
)
check(
  '§E the selector never auto-picks a candidate (status-not-selectable in the trail)',
  r1.declined.some(d => d.profileId === 'anthropic-context-bounded' && d.reason === 'status-not-selectable') ||
    resolveHarnessProfile(factsAnthropic).declined.some(
      d => d.profileId === 'anthropic-context-bounded' && d.reason === 'status-not-selectable',
    ),
)

console.log('§F the CH-14 conservative default')
const unknownModel = resolveHarnessProfile({ ...factsAnthropic, facts: { ...factsAnthropic.facts, modelId: 'claude-nova-9', modelFamily: 'nova', modelKnown: false } })
check(
  '§F an unknown model takes the family default with the NAMED conservative reason',
  unknownModel.origin === 'accepted-default' && unknownModel.profileId === 'anthropic-default' && unknownModel.reasonCodes[0] === 'unknown-model-conservative-default',
)

console.log('§G history inertness at the opening state (CH-13)')
const noisyHistory = resolveHarnessProfile({
  ...factsAnthropic,
  history: [
    { profileId: 'anthropic-default', epoch: 'he1-WRONG', sampleCount: 999, acceptedRate: 0.01 },
    { profileId: 'openai-default', epoch: 'he1-testepoch0000000', sampleCount: 999, acceptedRate: 1.0 },
  ],
})
check(
  '§G accepted-only catalogue: history rows cannot move the resolution (no qualified candidates exist)',
  noisyHistory.profileId === 'anthropic-default' && noisyHistory.origin === 'accepted-default',
)
check('§G reason codes are a closed tuple (every emitted code registered)', [r1, sessionPinned, unknownPin, incompatiblePin, unknownModel, noisyHistory].every(r => r.reasonCodes.every(c => (HARNESS_REASON_CODES as readonly string[]).includes(c)) && r.declined.every(d => (HARNESS_REASON_CODES as readonly string[]).includes(d.reason))))

console.log('§H epoch composition (CH-40)')
check("§H the LIVE architecture-epoch constant is 'apex-1' (composed, never bumped)", APEX_ARCHITECTURE_EPOCH === 'apex-1')
check("§H the architecture identity binds once, at this owner", CONTINUUM_ARCHITECTURE_IDENTITY === 'continuum-close-3955d8ea')
const e0 = harnessEvidenceEpoch({ architectureEpoch: APEX_ARCHITECTURE_EPOCH, corpusDigest: 'corpus-a', graderDigest: 'grader-a' })
check('§H he1- shaped', /^he1-[0-9a-f]{16}$/.test(e0), e0)
check('§H architecture change moves the epoch', harnessEvidenceEpoch({ architectureEpoch: 'apex-2', corpusDigest: 'corpus-a', graderDigest: 'grader-a' }) !== e0)
check('§H corpus change moves the epoch', harnessEvidenceEpoch({ architectureEpoch: APEX_ARCHITECTURE_EPOCH, corpusDigest: 'corpus-b', graderDigest: 'grader-a' }) !== e0)
check('§H grader change moves the epoch', harnessEvidenceEpoch({ architectureEpoch: APEX_ARCHITECTURE_EPOCH, corpusDigest: 'corpus-a', graderDigest: 'grader-b' }) !== e0)
check('§H deterministic', harnessEvidenceEpoch({ architectureEpoch: APEX_ARCHITECTURE_EPOCH, corpusDigest: 'corpus-a', graderDigest: 'grader-a' }) === e0)

console.log(failures === 0 ? '\nprove-ch1-contract: green' : `\nprove-ch1-contract: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
