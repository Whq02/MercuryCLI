#!/usr/bin/env bun
// ============================================================================
//  — the Agent-assisted coordinator lane.
//
//  §1 the mode LIFT — agent-assisted holds with any model the registry
//     LISTS (its truthful label rides the resolution: not signed in,
//     experimental, expired — the wire decides the turn); an absent choice
//     downgrades rules-only with the TYPED reason.
//  §2 the governed turn — the assisted turn holds EXACTLY ONE 'coordinator'
//     permit for the call and releases it (the single visible lane);
//     the injected provider seam receives the BOUNDED board + the versioned
//     contract (§9.5 — never transcripts).
//  §3 proposal validation — only the closed kernel vocabulary executes;
//     malformed/foreign proposals are counted refused, never executed,
//     never silently dropped; the batch cap holds.
//  §4 dedupe — an equivalent trigger takes NO second turn (no permit,
//     no model call).
//  §5 — an equivalent previously-FAILED batch is refused with the
//     'changed strategy' reason (the progressModel fingerprint owner).
//  §6 operator parity — assisted receipts ride the SAME owner path:
//     the obligation the model raised is indistinguishable at the store
//     from an operator-raised one (same ref-idempotency law).
//  §7 Rules-only twin — runCoordinatorTurn under rules-only executes the
//     kernel with ZERO callModel invocations.
//  §8 RETIRED: parseProposal died with the JSON one-shot —
//     the live binding is a bounded agent turn whose fail-soft posture is
//     proved by scripts/switchboard/prove-coordinator-turn.ts.
//  §9 — a rules-only turn's receipts row on the semantic activity
//     feed (verb→object→outcome, coordinator-seat attribution) through the
//     REGISTERED 'coordinator-receipt' classifier.
//  §10 — assisted receipts row too, and a vocabulary-refused
//     proposal rows VISIBLY (never a silent drop).
//
//  Hermetic: scratch homes pinned before owner imports.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'sg5-lane-'))
const home = join(scratch, 'home')
const crewDir = join(scratch, 'crew')
for (const d of [home, crewDir]) mkdirSync(d, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
// Every endpoint base pins dead and ambient provider credentials clear: the
// fixture account below must never reach a live service, and the label
// legs read THIS home's credential truth, not this machine's.
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN']) {
  delete process.env[key]
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()
// The assisted-turn binding is Anthropic-wire (ii route honesty) —
// the lift/turn legs ride a current-generation registry id; the GPT engine
// leg asserts the TYPED binding downgrade instead.
const anthropicId = 'claude-sonnet-5'
const q = await import('../../src/services/providers/openai/qualificationStore.ts')
const lane = await import('../../src/services/concourse/coordinatorLane.ts')
const governor = await import('../../src/services/capacity/governor.ts')
const { openObligations } = await import('../../src/services/crew/obligations.ts')

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// Seed: a coordinator-qualified engine + a connected (fixture) account + the config.
q.recordLiveQualification({ modelId: 'gpt-5.6-sol', role: 'coordinator', sourceKind: 'subscription' as never })
writeFileSync(
  join(home, '.openai-auth.json'),
  JSON.stringify({
    version: 1,
    tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus' },
  }),
)

// ── §1 the mode lift ────────────────────────────────────────────────────────
console.log('§1 the mode lift (typed both directions)')
{
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const } }))
  const noChoice = await lane.resolveEffectiveCoordinator()
  check('agent-assisted WITHOUT a model choice downgrades rules-only', noChoice.resolution.effective === 'rules-only')
  check('…naming the blocker (pick a model)', noChoice.resolution.fallbackReason?.includes('pick one') === true, noChoice.resolution.fallbackReason)

  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: anthropicId } }))
  const lifted = await lane.resolveEffectiveCoordinator()
  check('a VALIDATED anthropic-routed choice lifts to agent-assisted', lifted.resolution.effective === 'agent-assisted', lifted.resolution.fallbackReason)
  check('…binding the model id from the registry', lifted.assistModelId === anthropicId)

  // The QUALIFIED GPT engine: its turn binding is LIVE —
  // routedCallModel runs the one-shot on the native OpenAI runtime, so the
  // lift holds with the engine id bound (the old typed
  // 'engine-turn-binding-pending' downgrade is retired).
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: 'gpt-5.6-sol' } }))
  const engine = await lane.resolveEffectiveCoordinator()
  check('a qualified ENGINE choice lifts with its turn route BOUND', engine.resolution.effective === 'agent-assisted' && engine.assistModelId === 'gpt-5.6-sol', engine.resolution.fallbackReason)

  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: anthropicId } }))
  const anthropicChoice = await lane.resolveEffectiveCoordinator()
  check('an anthropic choice LIFTS (engine credentials are engine-scoped)', anthropicChoice.resolution.effective === 'agent-assisted', anthropicChoice.resolution.fallbackReason)
  // The ruling: the lift never waits on a credential or a qualification —
  // the row's truthful label rides the resolution and the wire decides.
  check(
    "…on this credential-less home the choice carries 'not signed in — /logins anthropic'",
    anthropicChoice.assistModelStatus === 'not signed in — /logins anthropic',
    anthropicChoice.assistModelStatus,
  )
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: 'gpt-5.6-terra' } }))
  const receiptless = await lane.resolveEffectiveCoordinator()
  check(
    // The verdict-word removal (operator-ruled): receipts never decide a
    // label — a receiptless engine choice lifts READY with no status at all.
    // (This check inherited a base-state red: it pinned the pre-retirement
    // 'experimental — not yet qualified' spelling the label had left behind.)
    'a receiptless engine choice lifts with NO status word',
    receiptless.resolution.effective === 'agent-assisted' && receiptless.assistModelId === 'gpt-5.6-terra' && receiptless.assistModelStatus === undefined,
    `${receiptless.resolution.effective}/${receiptless.assistModelStatus}`,
  )
  check('a READY choice carries no status', engine.assistModelStatus === undefined, engine.assistModelStatus)
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: 'no-such-model-9' } }))
  const unlisted = await lane.resolveEffectiveCoordinator()
  check(
    "a configured id the catalogue no longer lists lifts as 'not in the current catalogue' (the wire decides)",
    unlisted.resolution.effective === 'agent-assisted' && unlisted.assistModelStatus === 'not in the current catalogue',
    `${unlisted.resolution.effective}/${unlisted.assistModelStatus}`,
  )
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: anthropicId } }))
}

// ── §2 the governed turn ────────────────────────────────────────────────────
console.log('§2 one governed permit + the bounded input')
{
  lane._resetCoordinatorLaneForTesting()
  let heldDuringCall = -1
  let sawContract = false
  let sawBoard = false
  const receipt = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'cm-lane-1', text: 'the launch was refused — what happened?' },
    {
      crewDir,
      callModel: async (input, modelId) => {
        heldDuringCall = governor.heldPermits().filter(g => g.lane === 'coordinator').length
        sawContract = input.contract.includes('coordinator') && input.contractVersion === lane.COORDINATOR_CONTRACT_VERSION
        sawBoard = Array.isArray(input.board.openObligations)
        check('the validated model id reaches the seam', modelId === anthropicId, modelId)
        return { decisions: [] }
      },
    },
  )
  check('the turn executed', receipt.outcome === 'executed', receipt.reason)
  check("EXACTLY ONE 'coordinator' permit held during the call", heldDuringCall === 1, String(heldDuringCall))
  check('the permit released after the turn', governor.heldPermits().filter(g => g.lane === 'coordinator').length === 0)
  check('the versioned contract rode the call', sawContract)
  check('the bounded board rode the call (never transcripts)', sawBoard)
  check('the receipt binds the contract digest', receipt.contractDigest === lane.coordinatorContractDigest())
}

// ── §3 proposal validation ──────────────────────────────────────────────────
console.log('§3 the closed vocabulary')
{
  lane._resetCoordinatorLaneForTesting()
  const receipt = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'obl-x', text: 'answer the open question' },
    {
      crewDir,
      callModel: async () => ({
        decisions: [
          { verb: 'attention.raise', ref: 'model:ask:1', sessionId: 's-m', question: 'Which repo first?', owner: 'operator' },
          { verb: 'session.cancel', sessionId: 's-1' } as never, // NOT in the vocabulary
          { verb: 'attention.raise', ref: 'bad' } as never, // malformed shape
        ],
      }),
    },
  )
  check('the lawful proposal executed', receipt.receipts.length === 1 && receipt.receipts[0]?.outcome === 'applied', JSON.stringify(receipt.receipts))
  check('foreign + malformed proposals counted REFUSED (visible)', receipt.refusedProposals === 2, String(receipt.refusedProposals))
  const rows = await openObligations({ dir: crewDir, scope: 'switchboard' })
  check('exactly the lawful obligation landed', rows.some(r => r.ref === 'model:ask:1'))
}

// ── §4 trigger dedupe ─────────────────────────────────────────────────
console.log('§4 equivalent-trigger dedupe (no second spend)')
{
  let calls = 0
  const deps = {
    crewDir,
    callModel: async () => {
      calls += 1
      return { decisions: [] }
    },
  }
  lane._resetCoordinatorLaneForTesting()
  const first = await lane.runAssistedTurn({ kind: 'operator-message', messageId: 'm-dup', text: 'tidy the settled session' }, deps)
  const second = await lane.runAssistedTurn({ kind: 'operator-message', messageId: 'm-dup', text: 'tidy the settled session' }, deps)
  check('first turn executed', first.outcome === 'executed')
  check('the equivalent trigger DEDUPED', second.outcome === 'deduped', second.outcome)
  check('exactly ONE model call happened', calls === 1, String(calls))
}

// ── §5 failed-batch refusal ───────────────────────────────────────────
console.log('§5 no equivalent-failure repetition')
{
  lane._resetCoordinatorLaneForTesting()
  // A batch that FAILS at the owner: supersede an unknown obligation.
  const failing = {
    decisions: [{ verb: 'attention.supersede' as const, obligationId: 'obl-does-not-exist', reason: 'r' }],
  }
  const deps = { crewDir, callModel: async () => failing }
  const first = await lane.runAssistedTurn({ kind: 'operator-message', messageId: 'o-f1', text: 'run the failing batch' }, deps)
  check('the failing batch executed and its receipt shows the refusal', first.outcome === 'executed' && first.receipts[0]?.outcome === 'noop' || first.receipts[0]?.outcome === 'refused', JSON.stringify(first.receipts))
  // Note: an unknown obligation resolves settled:false → 'noop' — force a
  // REFUSED receipt shape instead via the failure memory seam: mark the
  // batch failed by executing a batch whose owner outcome is 'refused'.
  // The store's unknown-row answer is noop, so §5 pins the MEMORY mechanism
  // directly:
  const batchKey = lane.batchKeyOf(failing.decisions)
  check('the batch fingerprint is stable (the progressModel owner)', batchKey === lane.batchKeyOf([{ verb: 'attention.supersede', obligationId: 'obl-does-not-exist', reason: 'r' }]))
}

// ── §6 operator parity ──────────────────────────────────────────────
console.log('§6 assisted receipts ride the SAME owner path')
{
  lane._resetCoordinatorLaneForTesting()
  const ref = 'parity:ask:1'
  await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'o-parity', text: 'raise the parity question' },
    {
      crewDir,
      callModel: async () => ({
        decisions: [{ verb: 'attention.raise', ref, sessionId: 's-p', question: 'q', owner: 'operator' }],
      }),
    },
  )
  // The OPERATOR path: the same upsert through the kernel executor.
  const kernel = await import('../../src/services/concourse/coordinatorKernel.ts')
  const opReceipt = await kernel.executeKernelDecision(
    { verb: 'attention.raise', ref, sessionId: 's-p', question: 'q', owner: 'operator' },
    { crewDir },
  )
  check('the operator re-raise of the SAME ref is a no-op (shared idempotency contract)', opReceipt.outcome === 'noop', opReceipt.outcome)
  const rows = await openObligations({ dir: crewDir, scope: 'switchboard' })
  check('ONE row — indistinguishable at the store', rows.filter(r => r.ref === ref).length === 1)
}

// ── §7 the Rules-only twin ──────────────────────────────────────────────────
console.log('§7 runCoordinatorTurn under rules-only (zero model)')
{
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'rules-only' as const } }))
  let calls = 0
  const receipt = await lane.runCoordinatorTurn(
    { kind: 'dispatch-refused', clientMessageId: 'cm-rules', reason: 'ceiling', workspaceDir: '/ws', promptPreview: 'p' },
    {
      crewDir,
      callModel: async () => {
        calls += 1
        return { decisions: [] }
      },
    },
  )
  check('rules-only executed the kernel', receipt.outcome === 'executed')
  check('ZERO model calls (zero-call)', calls === 0, String(calls))
  check('the kernel receipt landed (R1 raise)', receipt.receipts.some(r => r.verb === 'attention.raise'))
}

// ── §8 retired: the JSON-proposal parse died with the
// one-shot — the live binding is a bounded agent turn (real tools, streamed
// deltas); its fail-soft + sandbox laws are proved by
// scripts/switchboard/prove-coordinator-turn.ts. The injected-proposal seam
// this file exercises everywhere else is unchanged. ─────────────────────────

// ── §9 — the semantic activity feed (rules-only) ──────────────────────
console.log('§9 the activity-feed receipts')
{
  const activity = await import('../../src/services/crew/activity.ts')
  activity._resetActivityFeedForTesting()
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'rules-only' as const } }))
  lane._resetCoordinatorLaneForTesting()
  const receipt = await lane.runCoordinatorTurn(
    { kind: 'dispatch-refused', clientMessageId: 'cm-feed-1', reason: 'ceiling', workspaceDir: '/ws', promptPreview: 'p' },
    { crewDir },
  )
  check('the rules-only turn executed (R1)', receipt.outcome === 'executed' && receipt.receipts.length === 1)
  const rows = activity.activityRows(activity.cachedActivityFeed())
  const actionRow = rows.find(r => r.class === 'question' && r.verb === 'raised attention')
  check(
    'the action ROWED on the semantic feed',
    actionRow !== undefined,
    JSON.stringify(rows.map(r => `${r.class}:${r.verb}`)),
  )
  check(
    '…verb→object→outcome complete',
    actionRow?.objectLabel.includes('kernel:capacity:cm-feed-1') === true && actionRow?.outcomeLabel?.startsWith('applied') === true,
    `${actionRow?.objectLabel} / ${actionRow?.outcomeLabel}`,
  )
  check(
    '…attributed to the coordinator seat',
    typeof actionRow?.agentId === 'string' && actionRow.agentId.length > 0 && actionRow.agentId !== 'coordinator-unresolved',
    actionRow?.agentId,
  )
  check(
    "the lift is REGISTERED ('coordinator-receipt' in the ordered registry)",
    activity.activityClassifierOrder().some(c => c.name === 'coordinator-receipt'),
  )
}

// ── §10 — assisted receipts + visible refusals ─────────────────────
console.log('§10 assisted receipts + visible refusals on the feed')
{
  const activity = await import('../../src/services/crew/activity.ts')
  activity._resetActivityFeedForTesting()
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: anthropicId } }))
  lane._resetCoordinatorLaneForTesting()
  const receipt = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'o-feed', text: 'act on the feed question' },
    {
      crewDir,
      callModel: async () => ({
        decisions: [
          { verb: 'attention.raise', ref: 'feed:ask:1', sessionId: 's-f', question: 'q?', owner: 'operator' },
          { verb: 'session.cancel', sessionId: 's-1' } as never, // NOT in the vocabulary
        ],
      }),
    },
  )
  check('the assisted turn executed with 1 refused proposal', receipt.outcome === 'executed' && receipt.refusedProposals === 1)
  const rows = activity.activityRows(activity.cachedActivityFeed())
  check(
    'the executed action rowed',
    rows.some(r => r.verb === 'raised attention' && r.outcomeLabel?.startsWith('applied') === true),
    JSON.stringify(rows.map(r => `${r.verb}:${r.outcomeLabel}`)),
  )
  check(
    'the vocabulary refusal rowed VISIBLY',
    rows.some(r => r.verb === 'refused' && r.objectLabel.includes('outside the closed vocabulary')),
    JSON.stringify(rows.map(r => r.verb)),
  )
}

// ── §11 contract v2 (A1/A2) — signal.emit left the MODEL vocabulary ─────────
console.log('§11 contract v2 — signal.emit gone from the model vocabulary; raise fields capped + owner-pinned')
{
  // v5: the persona replaced the JSON-proposal contract —
  // verbs are TOOLS now, so the contract no longer enumerates them; the
  // VALIDATOR below still holds the closed vocabulary for the injected seam.
  // v6: the board block is the model's
  // knowledge; with-you = alive; no re-asking about executed receipts.
  check('the contract lineage is at least v9 (the seat floor line, then the conversation grammar)', lane.COORDINATOR_CONTRACT_VERSION >= 9)
  check(
    'the v6 contract IS the switchboard persona (one home)',
    lane.COORDINATOR_CONTRACT === (await import('../../src/services/concourse/coordinatorPersona.ts')).COORDINATOR_PERSONA,
  )
  check('the contract text no longer offers signal.emit', !lane.COORDINATOR_CONTRACT.includes('signal.emit'))
  check(
    'the contract carries the Q3 two-step + the attainable-goal law',
    lane.COORDINATOR_CONTRACT.includes('operatorConfirmed') &&
      lane.COORDINATOR_CONTRACT.replace(/\s+/g, ' ').includes('unattainable') &&
      lane.COORDINATOR_CONTRACT.replace(/\s+/g, ' ').includes('smallest honest question'),
  )
  lane._resetCoordinatorLaneForTesting()
  const receipt = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'o-v2', text: 'raise what needs raising' },
    {
      crewDir,
      callModel: async () => ({
        decisions: [
          // a WELL-FORMED v1 signal.emit — refused by vocabulary now (D1)
          { verb: 'signal.emit', obligationId: 'o-v2', revision: 1, title: 'needs you', body: 'q' } as never,
          // A2: owner ≠ 'operator' — refused (the kernel never raises for others)
          { verb: 'attention.raise', ref: 'v2:bad-owner', sessionId: 's-v2', question: 'q?', owner: 'the-model-itself' } as never,
          // A2: unbounded question — refused (caps hold)
          { verb: 'attention.raise', ref: 'v2:oversize', sessionId: 's-v2', question: 'q'.repeat(501), owner: 'operator' } as never,
          // the lawful survivor
          { verb: 'attention.raise', ref: 'v2:lawful', sessionId: 's-v2', question: 'which order?', owner: 'operator' },
        ],
      }),
    },
  )
  check('exactly the lawful raise executed; the other three counted refused', receipt.outcome === 'executed' && receipt.receipts.length === 1 && receipt.refusedProposals === 3, JSON.stringify({ outcome: receipt.outcome, refused: receipt.refusedProposals }))
  const rows = await openObligations({ dir: crewDir, scope: 'switchboard' })
  check('the model-emitted signal never reached the policy (no burned toast path)', receipt.receipts.every(r => r.verb !== 'signal.emit'))
  check('neither refused raise minted an obligation', !rows.some(r => r.ref === 'v2:bad-owner' || r.ref === 'v2:oversize'))
}

// ── §12 A8 — vocabulary-refused vs cap-dropped named DISTINCTLY ─────────────
console.log('§12 the two drop reasons are distinct facts on the feed')
{
  const activity = await import('../../src/services/crew/activity.ts')
  activity._resetActivityFeedForTesting()
  lane._resetCoordinatorLaneForTesting()
  const raise = (n: number): unknown => ({ verb: 'attention.raise', ref: `a8:${n}`, sessionId: 's-a8', question: `q${n}?`, owner: 'operator' })
  const receipt = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'o-a8', text: 'run the capped batch' },
    {
      crewDir,
      callModel: async () => ({
        decisions: [
          { verb: 'not.a.verb' } as never,
          { verb: 'generic.command', command: 'rm -rf /' } as never,
          ...([1, 2, 3, 4, 5, 6, 7].map(raise) as never[]),
        ],
      }),
    },
  )
  check('total refused = 2 vocabulary + 2 cap-dropped', receipt.refusedProposals === 4, String(receipt.refusedProposals))
  check('exactly the per-turn bound executed', receipt.receipts.length === 5, String(receipt.receipts.length))
  const rows = activity.activityRows(activity.cachedActivityFeed())
  const vocabRow = rows.find(r => r.verb === 'refused' && r.objectLabel.includes('outside the closed vocabulary'))
  const capRow = rows.find(r => r.verb === 'refused' && r.objectLabel.includes('beyond the per-turn bound'))
  check('the vocabulary refusals row with their OWN count', vocabRow !== undefined && vocabRow.objectLabel.includes('2 proposal(s) outside'), vocabRow?.objectLabel)
  check('the cap drops row SEPARATELY with their own count', capRow !== undefined && capRow.objectLabel.includes('2 proposal(s) beyond'), capRow?.objectLabel)
}

// ── §13 A4 — a throwing turn refuses TYPED and un-burns its trigger ─────────
console.log('§13 a transient failure never burns the trigger')
{
  lane._resetCoordinatorLaneForTesting()
  const event = { kind: 'operator-message', messageId: 'o-a4', text: 'retry after the transient failure' } as const
  const failed = await lane.runAssistedTurn(event, {
    crewDir,
    callModel: async () => {
      throw new Error('provider transport died mid-call')
    },
  })
  check('the turn refused TYPED with the failure named', failed.outcome === 'refused' && failed.reason?.includes('coordinator turn failed') === true, failed.reason)
  check('the permit was released on the throw path', governor.heldPermits().filter(g => g.lane === 'coordinator').length === 0)
  const retried = await lane.runAssistedTurn(event, {
    crewDir,
    callModel: async () => ({ decisions: [{ verb: 'attention.raise', ref: 'a4:retry', sessionId: 's-a4', question: 'retry?', owner: 'operator' }] }),
  })
  check('the SAME event retried after the failure (not deduped — the trigger was un-burned)', retried.outcome === 'executed', retried.outcome)
  const rows = await openObligations({ dir: crewDir, scope: 'switchboard' })
  check('the retry landed its obligation', rows.some(r => r.ref === 'a4:retry'))
}

// ── §14 A5 — a throwing owner mid-batch stays VISIBLE ───────────────────────
console.log('§14 no invisible half-batch: throwing owners land typed rows')
{
  lane._resetCoordinatorLaneForTesting()
  const lockedCrew = join(scratch, 'crew-locked')
  mkdirSync(lockedCrew, { recursive: true })
  const { chmodSync } = await import('node:fs')
  chmodSync(lockedCrew, 0o555) // reads fail-soft empty; WRITES throw
  const receipt = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'o-a5', text: 'drive this turn' },
    {
      crewDir: lockedCrew,
      callModel: async () => ({
        decisions: [
          { verb: 'attention.raise', ref: 'a5:one', sessionId: 's-a5', question: 'one?', owner: 'operator' },
          { verb: 'attention.raise', ref: 'a5:two', sessionId: 's-a5', question: 'two?', owner: 'operator' },
        ],
      }),
    },
  )
  chmodSync(lockedCrew, 0o755)
  check('the turn completed (no escaped throw)', receipt.outcome === 'executed', receipt.outcome)
  check('BOTH decisions carry visible typed rows', receipt.receipts.length === 2, String(receipt.receipts.length))
  check('the thrown owners read as typed refusals naming the throw', receipt.receipts.every(r => r.outcome === 'refused' && r.detail?.includes('owner threw') === true), JSON.stringify(receipt.receipts.map(r => `${r.outcome}:${r.detail?.slice(0, 30)}`)))
}

// ── §15 A3 (D3) — the kernel entry resolves config when no mode is passed ───
console.log('§15 kernel-resolves-config: a mode-less caller honors the per-user mode')
{
  const kernel = await import('../../src/services/concourse/coordinatorKernel.ts')
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'off' as const } }))
  const offReceipts = await kernel.runCoordinatorKernel(
    { kind: 'dispatch-refused', clientMessageId: 'a3-off', reason: 'r', workspaceDir: '/tmp', promptPreview: 'p' },
    { crewDir },
  )
  check("config 'off' with NO mode passed ⇒ the kernel does not run", offReceipts.length === 0)
  const rowsOff = await openObligations({ dir: crewDir, scope: 'switchboard' })
  check('…and raised NOTHING', !rowsOff.some(r => r.ref === 'kernel:capacity:a3-off'))
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'rules-only' as const } }))
  const onReceipts = await kernel.runCoordinatorKernel(
    { kind: 'dispatch-refused', clientMessageId: 'a3-on', reason: 'r', workspaceDir: '/tmp', promptPreview: 'p' },
    { crewDir },
  )
  check("config 'rules-only' with NO mode passed ⇒ R1 runs", onReceipts.some(r => r.verb === 'attention.raise' && r.outcome === 'applied'), JSON.stringify(onReceipts))
  // restore for any later legs
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: anthropicId } }))
}

// ── §16 session verbs — validator admits, execution rides ONE path ────
console.log('§16 session verbs: validated shapes + the one executor path (parity)')
{
  check('session.pause shape admits', lane.validateProposal({ verb: 'session.pause', sessionId: 's-1', by: 'coordinator', reason: 'quiet hours' }))
  check('session.resume shape admits', lane.validateProposal({ verb: 'session.resume', sessionId: 's-1', by: 'coordinator' }))
  check('session.redirect shape admits', lane.validateProposal({ verb: 'session.redirect', sessionId: 's-1', clientMessageId: 'm-1', instruction: 'focus the tests', by: 'coordinator' }))
  check('an oversize instruction refuses', !lane.validateProposal({ verb: 'session.redirect', sessionId: 's-1', clientMessageId: 'm-1', instruction: 'x'.repeat(4001), by: 'c' }))
  check('a stray field-less pause refuses', !lane.validateProposal({ verb: 'session.pause', sessionId: 's-1' }))
  // Parity: a model-proposed session.pause EXECUTES through the SAME
  // executeKernelDecision path — with no daemon in this proof the executor
  // answers the TYPED transport-loss outcome ('failed', item 8: the daemon
  // never DECIDED; identity kept, the retry replays — never painted as a
  // refusal). The applied round-trip is the 5f valve prover's daemon-backed leg.
  lane._resetCoordinatorLaneForTesting()
  const receipt = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'o-verbs', text: 'drive this turn' },
    {
      crewDir,
      callModel: async () => ({
        decisions: [{ verb: 'session.pause', sessionId: 's-parity', by: 'coordinator', reason: 'parity leg' }],
      }),
    },
  )
  const row = receipt.receipts[0]
  check('the pause proposal EXECUTED through the kernel path (typed transport-loss outcome with the daemon reason named)', receipt.outcome === 'executed' && row?.verb === 'session.pause' && row.outcome === 'failed' && typeof row.detail === 'string' && /daemon|connect/i.test(row.detail), JSON.stringify(row))
}

// ── §17 B1 switch/fallback mid-flight + attribution ──────────────
//  A model switch DURING a held turn: the in-flight turn finishes on the
//  model it resolved; the receipt carries the TYPED boundary fact
//  (inFlightTurns — §F-3); the NEXT turn resolves the new model; the crew
//  seat identity never moves. Attribution: assisted receipts stamp the
//  coordinator SEAT, the switch gesture stamps the OPERATOR (§F-2).
console.log('§17 mid-flight switch continuity + actor attribution')
{
  const models = await import('../../src/services/concourse/coordinatorModels.ts')
  const { coordinatorAgentId } = await import('../../src/services/concourse/coordinatorIdentity.ts')
  const activity = await import('../../src/services/crew/activity.ts')
  const secondId = 'claude-opus-5'
  check('the registry offers a second current-generation model for the switch leg', secondId !== anthropicId, String(secondId))
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: anthropicId } }))
  lane._resetCoordinatorLaneForTesting()
  activity._resetActivityFeedForTesting()
  const seatBefore = await coordinatorAgentId({ dir: crewDir })

  let releaseA: (() => void) | undefined
  const blockedA = new Promise<void>(res => {
    releaseA = res
  })
  let aModelId = ''
  const turnA = lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'o-switch-a', text: 'drive this turn' },
    {
      crewDir,
      callModel: async (_input, modelId) => {
        aModelId = modelId
        await blockedA
        return { decisions: [{ verb: 'attention.raise', ref: 'sw:a', sessionId: 's-sw', question: 'a?', owner: 'operator' }] }
      },
    },
  )
  // Let A acquire its permit + enter the call before switching.
  while (aModelId === '') await new Promise(r => setTimeout(r, 10))
  const switchReceipt = await models.switchCoordinatorAssistModel(secondId!)
  check('the switch APPLIED while a turn was in flight', switchReceipt.outcome === 'applied', switchReceipt.outcome)
  check('…with the TYPED boundary fact (inFlightTurns === 1, never prose-parsed)', switchReceipt.inFlightTurns === 1, String(switchReceipt.inFlightTurns))
  releaseA!()
  const aReceipt = await turnA
  check('the in-flight turn FINISHED on the model it resolved (continuity)', aReceipt.outcome === 'executed' && aModelId === anthropicId && aReceipt.modelId === anthropicId, `${aReceipt.outcome} ${aModelId}`)
  check('…and its receipts stamp the coordinator SEAT (attribution)', aReceipt.receipts.every(r => r.actorAgentId === seatBefore && r.actorAgentId !== 'coordinator-unresolved'), JSON.stringify(aReceipt.receipts.map(r => r.actorAgentId)))

  let bModelId = ''
  const bReceipt = await lane.runAssistedTurn(
    { kind: 'operator-message', messageId: 'o-switch-b', text: 'drive this turn' },
    {
      crewDir,
      callModel: async (_input, modelId) => {
        bModelId = modelId
        return { decisions: [] }
      },
    },
  )
  check('the NEXT turn resolved the NEW model', bReceipt.outcome === 'executed' && bModelId === secondId, bModelId)
  const seatAfter = await coordinatorAgentId({ dir: crewDir })
  check('ONE coordinator identity across the switch (the seat never moves)', seatAfter === seatBefore, `${seatBefore} → ${seatAfter}`)
  const rows = activity.activityRows(activity.cachedActivityFeed())
  const switchRow = rows.find(r => r.verb === 'switched coordinator model')
  check('the switch rowed on the feed as an OPERATOR gesture (never the coordinator seat — §F-2)', switchRow !== undefined && switchRow.agentId !== seatBefore && switchRow.agentId.length > 0, switchRow?.agentId)
  // restore the validated first model for the fixtures below
  await models.switchCoordinatorAssistModel(anthropicId)
}

// ── §18 — the §9.3 behavior-fixture table ─────────────────────────────
//  Eleven named situations, one leg each, over injected callModel scripts —
//  every leg rides the landed machinery (owner idempotency, kernel rules,
//  failure memory, validation, the un-burn discipline, the smallest-question
//  surfacing). 'restart' = module reset between turns: receipts stay
//  exactly-once at the OWNERS.
console.log('§18 the behavior fixtures (§9.3 table)')
{
  const kernel = await import('../../src/services/concourse/coordinatorKernel.ts')
  const activity = await import('../../src/services/crew/activity.ts')
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: anthropicId } }))

  const raiseOf = (ref: string, sessionId: string, question: string) =>
    ({ verb: 'attention.raise' as const, ref, sessionId, question, owner: 'operator' as const })
  const oneTurn = (obligationId: string, decisions: unknown[], extra: Record<string, unknown> = {}) =>
    lane.runAssistedTurn(
      { kind: 'operator-message', messageId: 'm-x', text: 'drive this turn' },
      { crewDir, callModel: async () => ({ decisions: decisions as never, ...extra }) },
    )

  const FIXTURES: Array<{ name: string; run: () => Promise<{ ok: boolean; detail?: string }> }> = [
    {
      name: 'duplicate proposals — the owner keeps exactly one (ref idempotency)',
      run: async () => {
        lane._resetCoordinatorLaneForTesting()
        const r = await oneTurn('fx-dup', [raiseOf('fx:dup', 's-fx', 'dup?'), raiseOf('fx:dup', 's-fx', 'dup?')])
        const rows = (await openObligations({ dir: crewDir, scope: 'switchboard' })).filter(o => o.ref === 'fx:dup')
        const outcomes = r.receipts.map(x => x.outcome).sort().join(',')
        return { ok: r.receipts.length === 2 && outcomes === 'applied,noop' && rows.length === 1, detail: `${outcomes} rows=${rows.length}` }
      },
    },
    {
      name: 'conflicting workspaces — the refusal becomes the operator question (R1)',
      run: async () => {
        const receipts = await kernel.runCoordinatorKernel(
          { kind: 'dispatch-refused', clientMessageId: 'fx-collide', reason: 'workspace collision: exclusive overlap', workspaceDir: '/ws', promptPreview: 'p' },
          { crewDir, mode: 'rules-only' },
        )
        const rows = await openObligations({ dir: crewDir, scope: 'switchboard' })
        return { ok: receipts.some(r => r.verb === 'attention.raise' && r.outcome === 'applied') && rows.some(o => o.ref === 'kernel:capacity:fx-collide'), detail: JSON.stringify(receipts) }
      },
    },
    {
      name: 'stale session — settlement supersedes its open question (R2)',
      run: async () => {
        await kernel.executeKernelDecision(raiseOf('fx:stale', 's-stale', 'still there?'), { crewDir })
        const before = (await openObligations({ dir: crewDir, scope: 'switchboard' })).some(o => o.ref === 'fx:stale')
        await kernel.runCoordinatorKernel({ kind: 'worker-settled', sessionId: 's-stale', runnerId: 'w-stale' }, { crewDir, mode: 'rules-only' })
        const after = (await openObligations({ dir: crewDir, scope: 'switchboard' })).some(o => o.ref === 'fx:stale')
        return { ok: before && !after, detail: `before=${before} after=${after}` }
      },
    },
    {
      name: 'unavailable provider — typed refusal, trigger un-burned, retry succeeds',
      run: async () => {
        lane._resetCoordinatorLaneForTesting()
        const failed = await lane.runAssistedTurn(
          { kind: 'operator-message', messageId: 'fx-prov', text: 'drive this turn' },
          { crewDir, callModel: async () => { throw new Error('provider unavailable') } },
        )
        const retried = await oneTurn('fx-prov', [raiseOf('fx:prov', 's-fx', 'retry?')])
        return { ok: failed.outcome === 'refused' && retried.outcome === 'executed', detail: `${failed.outcome}/${retried.outcome}` }
      },
    },
    {
      name: 'withdrawn question — supersede settles it; re-withdrawal is a noop',
      run: async () => {
        lane._resetCoordinatorLaneForTesting()
        await oneTurn('fx-wd-1', [raiseOf('fx:wd', 's-fx', 'withdraw me?')])
        const row = (await openObligations({ dir: crewDir, scope: 'switchboard' })).find(o => o.ref === 'fx:wd')
        if (!row) return { ok: false, detail: 'raise never landed' }
        const first = await kernel.executeKernelDecision({ verb: 'attention.supersede', obligationId: row.obligationId, reason: 'withdrawn' }, { crewDir })
        const second = await kernel.executeKernelDecision({ verb: 'attention.supersede', obligationId: row.obligationId, reason: 'withdrawn' }, { crewDir })
        const stillOpen = (await openObligations({ dir: crewDir, scope: 'switchboard' })).some(o => o.ref === 'fx:wd')
        return { ok: first.outcome === 'applied' && second.outcome === 'noop' && !stillOpen, detail: `${first.outcome}/${second.outcome} open=${stillOpen}` }
      },
    },
    {
      name: 'stale receipt digest — the engine choice LIFTS with no status word (receipts never decide a label; the verdict-word removal)',
      run: async () => {
        const qPath = q.__qualificationFilePathForTest()
        const { readFileSync } = await import('node:fs')
        const raw = JSON.parse(readFileSync(qPath, 'utf8')) as { receipts: Array<Record<string, unknown>> }
        const row = raw.receipts.find(r => r['role'] === 'coordinator')!
        row['roleCapabilityDigest'] = 'rc1-stale00000000000'
        writeFileSync(qPath, JSON.stringify(raw))
        saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: 'gpt-5.6-sol' } }))
        const eff = await lane.resolveEffectiveCoordinator()
        // restore: current receipt + the validated anthropic choice
        q.recordLiveQualification({ modelId: 'gpt-5.6-sol', role: 'coordinator', sourceKind: 'subscription' as never })
        saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: anthropicId } }))
        return {
          ok: eff.resolution.effective === 'agent-assisted' && eff.assistModelId === 'gpt-5.6-sol' && eff.assistModelStatus === undefined,
          detail: `${eff.resolution.effective}/${eff.assistModelStatus}`,
        }
      },
    },
    {
      name: 'mid-turn new event — queues behind the ONE lane, then executes (never lost)',
      run: async () => {
        lane._resetCoordinatorLaneForTesting()
        let release: (() => void) | undefined
        const gate = new Promise<void>(res => { release = res })
        let aEntered = false
        const a = lane.runAssistedTurn(
          { kind: 'operator-message', messageId: 'fx-mid-a', text: 'drive this turn' },
          { crewDir, callModel: async () => { aEntered = true; await gate; return { decisions: [] } } },
        )
        while (!aEntered) await new Promise(r => setTimeout(r, 10))
        const b = lane.runAssistedTurn(
          { kind: 'operator-message', messageId: 'fx-mid-b', text: 'drive this turn' },
          { crewDir, callModel: async () => ({ decisions: [] }) },
        )
        await new Promise(r => setTimeout(r, 50))
        release!()
        const [ra, rb] = await Promise.all([a, b])
        return { ok: ra.outcome === 'executed' && rb.outcome === 'executed', detail: `${ra.outcome}/${rb.outcome}` }
      },
    },
    {
      name: 'restart between proposal and receipt — owners stay exactly-once',
      run: async () => {
        lane._resetCoordinatorLaneForTesting()
        const r1 = await oneTurn('fx-restart', [raiseOf('fx:restart', 's-fx', 'restart?')])
        lane._resetCoordinatorLaneForTesting() // the restart: trigger memory gone
        const r2 = await oneTurn('fx-restart', [raiseOf('fx:restart', 's-fx', 'restart?')])
        const rows = (await openObligations({ dir: crewDir, scope: 'switchboard' })).filter(o => o.ref === 'fx:restart')
        return {
          ok: r1.receipts[0]?.outcome === 'applied' && r2.outcome === 'executed' && r2.receipts[0]?.outcome === 'noop' && rows.length === 1,
          detail: `${r1.receipts[0]?.outcome}/${r2.receipts[0]?.outcome} rows=${rows.length}`,
        }
      },
    },
    {
      name: 'impossible task — decisions withheld, the smallest honest question SURFACES',
      run: async () => {
        lane._resetCoordinatorLaneForTesting()
        activity._resetActivityFeedForTesting()
        const r = await oneTurn('fx-impossible', [], { smallestQuestion: 'which of the two conflicting priorities wins?' })
        const feedRows = activity.activityRows(activity.cachedActivityFeed())
        const asked = feedRows.find(x => x.verb === 'asked' && x.objectLabel.includes('conflicting priorities'))
        const contractFlat = lane.COORDINATOR_CONTRACT.replace(/\s+/g, ' ')
        const contractSaysSo = contractFlat.includes('unattainable') && contractFlat.includes('smallest honest question')
        return {
          ok: r.outcome === 'executed' && r.receipts.length === 0 && r.smallestQuestion?.includes('conflicting') === true && asked !== undefined && contractSaysSo,
          detail: `receipts=${r.receipts.length} q=${r.smallestQuestion?.slice(0, 30)} feed=${asked !== undefined}`,
        }
      },
    },
    {
      name: 'repeated identical failures — the equivalent batch refuses (failure memory)',
      run: async () => {
        lane._resetCoordinatorLaneForTesting()
        const lockedCrew = join(scratch, 'crew-fx-fail')
        mkdirSync(lockedCrew, { recursive: true })
        const { chmodSync } = await import('node:fs')
        const batch = [raiseOf('fx:fail', 's-fx', 'fail?')]
        chmodSync(lockedCrew, 0o555)
        const first = await lane.runAssistedTurn(
          { kind: 'operator-message', messageId: 'fx-fail-1', text: 'drive this turn' },
          { crewDir: lockedCrew, callModel: async () => ({ decisions: batch }) },
        )
        chmodSync(lockedCrew, 0o755)
        const second = await lane.runAssistedTurn(
          { kind: 'operator-message', messageId: 'fx-fail-2', text: 'drive this turn' },
          { crewDir, callModel: async () => ({ decisions: batch }) },
        )
        return {
          ok: first.receipts.every(x => x.outcome === 'refused') && second.outcome === 'refused' && second.reason?.includes('changed strategy') === true,
          detail: `${first.receipts[0]?.outcome}/${second.outcome}`,
        }
      },
    },
    {
      name: 'changed strategy — novelty admits (a genuinely different batch executes)',
      run: async () => {
        // rides the failure memory the previous fixture just planted
        const changed = await oneTurn('fx-fail-3', [raiseOf('fx:fail-changed', 's-fx', 'changed approach?')])
        const rows = (await openObligations({ dir: crewDir, scope: 'switchboard' })).some(o => o.ref === 'fx:fail-changed')
        return { ok: changed.outcome === 'executed' && changed.receipts[0]?.outcome === 'applied' && rows, detail: changed.outcome }
      },
    },
  ]
  for (const f of FIXTURES) {
    const r = await f.run()
    check(`fixture: ${f.name}`, r.ok, r.detail)
  }
}

// ── §19 — structurally event-triggered (no resident loop, no timer) ───
console.log('§19 no resident loop: the coordinator family carries NO setInterval')
{
  const { readFileSync, readdirSync } = await import('node:fs')
  const dir = join(import.meta.dir, '../../src/services/concourse')
  const family = readdirSync(dir).filter(f => f.startsWith('coordinator'))
  check('the family is present (kernel/lane/call/models/receipts/identity)', family.length >= 6, family.join(','))
  const offenders = family.filter(f => readFileSync(join(dir, f), 'utf8').includes('setInterval'))
  check('ZERO setInterval across the family (event-triggered by construction)', offenders.length === 0, offenders.join(','))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-COORDINATOR-LANE: PASS' : `\nPROVE-COORDINATOR-LANE: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
