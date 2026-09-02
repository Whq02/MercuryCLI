#!/usr/bin/env bun
// ============================================================================
//  scripts/swarm/prove-governance.ts
//  PROOF: SendMessage governance pure functions + the Q&A ledger lifecycle
//  (capability-matrix "Next action" debt — the governance cluster shipped with
//  wiring-only coverage). Asserts, against the REAL module:
//    • canAnswerCloseQuestion — addressee-only close, case-insensitive,
//      non-empty addressee required, answered-never-recloses;
//    • decideBroadcastTurn — default-permissive (cooldown 0 ⇒ never throttles),
//      deny ONLY on repeat-broadcaster + other-actors-active + inside cooldown,
//      deny leaves state unchanged, garbage state fails open, window pruning;
//    • checkBroadcastAllowed — default null; lead exempt; deny only on explicit
//      governance.broadcastEnabled=false for non-leads;
//    • rankOf/outranks/canDirect/resolveDirectActor — the command-rank ladder
//      (self-directive free, unknown roles never outrank, lead fallback);
//    • Q&A ledger IO (hermetic MERCURY_CONFIG_DIR sandbox) — open→answer
//      lifecycle, request_id idempotency, addressee-only close on the WRITE
//      path, case-insensitive listing, junk-ledger fail-open.
//
//  Run:  ~/.bun/bin/bun run scripts/swarm/prove-governance.ts
// ============================================================================

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Sandbox the config home BEFORE importing (getTeamsDir → getMercuryHome
// memoizes off this env var) so ledger IO never touches the real ~/.claude.
const TMP = mkdtempSync(join(tmpdir(), 'hermes-swarm-governance-'))
process.env.MERCURY_CONFIG_DIR = TMP

const {
  canAnswerCloseQuestion,
  decideBroadcastTurn,
  checkBroadcastAllowed,
  rankOf,
  outranks,
  canDirect,
  resolveDirectActor,
  openQuestion,
  answerQuestion,
  listOpenQuestions,
  DEFAULT_ROLE_LADDER,
} = await import('../../src/utils/swarm/sendMessageGovernance.js')
const { TEAM_LEAD_NAME } = await import('../../src/utils/swarm/constants.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' swarm governance — proof')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('canAnswerCloseQuestion — addressee-only, case-insensitive, total')
{
  check('exact addressee closes', canAnswerCloseQuestion({ to: 'bob' }, 'bob') === true)
  check('case-insensitive: "Bob" closed by "bob"', canAnswerCloseQuestion({ to: 'Bob' }, 'bob') === true)
  check('case-insensitive: "bob" closed by "BOB"', canAnswerCloseQuestion({ to: 'bob' }, 'BOB') === true)
  check('whitespace-tolerant addressee', canAnswerCloseQuestion({ to: ' bob ' }, 'bob') === true)
  check('non-addressee cannot close', canAnswerCloseQuestion({ to: 'bob' }, 'alice') === false)
  check('empty addressee never closes', canAnswerCloseQuestion({ to: '' }, 'bob') === false)
  check('missing addressee never closes', canAnswerCloseQuestion({}, 'bob') === false)
  check('already-answered never re-closes', canAnswerCloseQuestion({ to: 'bob', answeredAt: '2026-07-03T00:00:00Z' }, 'bob') === false)
}

// ───────────────────────────────────────────────────────────────────────────
section('decideBroadcastTurn — permissive default, honest deny, fail-open state')
{
  const now = Date.parse('2026-07-03T12:00:00.000Z')
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

  // Default cooldown (0) ⇒ fairness disabled entirely.
  const d0 = decideBroadcastTurn(null, { actor: 'a', nowMs: now })
  check('cooldown<=0 (default) always allows', d0.allow === true)
  check('allow records the speaker', d0.state.lastSpeaker?.actor === 'a')

  // Garbage persisted state fails open to fresh.
  const dJunk = decideBroadcastTurn('not-an-object', { actor: 'a', nowMs: now, repostCooldownMs: 5000 })
  check('garbage state fails open (allow)', dJunk.allow === true)

  // Deny: same actor spoke last, another actor active, inside cooldown.
  const busy = {
    lastSpeaker: { actor: 'a', ts: iso(1_000) },
    lastSpokeAt: { a: iso(1_000), b: iso(2_000) },
  }
  const deny = decideBroadcastTurn(busy, { actor: 'a', nowMs: now, repostCooldownMs: 5_000 })
  check('repeat broadcaster w/ active peer inside cooldown ⇒ deny', deny.allow === false)
  check('deny carries retryAfterMs = cooldown - elapsed', deny.retryAfterMs === 4_000, `got ${deny.retryAfterMs}`)
  check('deny reason names the yield contract', /yield the turn/.test(deny.reason))
  check('deny leaves lastSpeaker unchanged', deny.state.lastSpeaker?.actor === 'a' && deny.state.lastSpeaker?.ts === iso(1_000))
  check('deny does not stamp a new turn', deny.state.lastSpokeAt['a'] === iso(1_000))

  // Allow: a DIFFERENT actor may broadcast immediately.
  const other = decideBroadcastTurn(busy, { actor: 'b', nowMs: now, repostCooldownMs: 5_000 })
  check('a different actor is never throttled', other.allow === true)

  // Allow: same actor, cooldown elapsed.
  const later = decideBroadcastTurn(busy, { actor: 'a', nowMs: now + 6_000, repostCooldownMs: 5_000 })
  check('same actor after cooldown ⇒ allow', later.allow === true)

  // Allow: same actor, no OTHER active peers (solo room never throttles).
  const solo = {
    lastSpeaker: { actor: 'a', ts: iso(1_000) },
    lastSpokeAt: { a: iso(1_000) },
  }
  const soloAgain = decideBroadcastTurn(solo, { actor: 'a', nowMs: now, repostCooldownMs: 5_000 })
  check('solo broadcaster never throttles', soloAgain.allow === true)

  // Pruning: actors beyond the active window drop off on speak.
  const stale = {
    lastSpeaker: { actor: 'c', ts: iso(20 * 60_000) },
    lastSpokeAt: { c: iso(20 * 60_000), a: iso(1_000) },
  }
  const pruned = decideBroadcastTurn(stale, { actor: 'b', nowMs: now, repostCooldownMs: 5_000, activeWindowMs: 10 * 60_000 })
  check('speak prunes actors beyond the active window', pruned.allow === true && !('c' in pruned.state.lastSpokeAt))
  check('speak keeps in-window actors', 'a' in pruned.state.lastSpokeAt && 'b' in pruned.state.lastSpokeAt)
}

// ───────────────────────────────────────────────────────────────────────────
section('checkBroadcastAllowed — unchanged default, explicit lead gate')
{
  check('no team file ⇒ allowed', checkBroadcastAllowed(null, false) === null)
  check('no governance block ⇒ allowed', checkBroadcastAllowed({ members: [] } as never, false) === null)
  check('broadcastEnabled true ⇒ allowed', checkBroadcastAllowed({ members: [], governance: { broadcastEnabled: true } } as never, false) === null)
  const denied = checkBroadcastAllowed({ members: [], governance: { broadcastEnabled: false } } as never, false)
  check('broadcastEnabled=false denies non-lead with actionable reason', typeof denied === 'string' && /disabled for non-leads/.test(denied ?? ''))
  check('broadcastEnabled=false still allows the lead', checkBroadcastAllowed({ members: [], governance: { broadcastEnabled: false } } as never, true) === null)
}

// ───────────────────────────────────────────────────────────────────────────
section('command-rank ladder — rankOf / outranks / canDirect / resolveDirectActor')
{
  check('rankOf: ladder order (lead above teammate)', rankOf('lead') < rankOf('teammate'))
  check('rankOf: unknown role ⇒ +Infinity', rankOf('wizard') === Number.POSITIVE_INFINITY)
  check('rankOf: undefined ⇒ +Infinity', rankOf(undefined) === Number.POSITIVE_INFINITY)
  check('outranks: unknown never outranks', outranks('wizard', 'scout') === false)
  check('outranks: ranked beats unranked', outranks('scout', undefined) === true)
  check('outranks: strict (equal roles do not outrank)', outranks('specialist', 'specialist') === false)
  check('DEFAULT_ROLE_LADDER is frozen', Object.isFrozen(DEFAULT_ROLE_LADDER))

  // canDirect — self-directives are never gated.
  const self = canDirect({ name: 'x', isLead: false }, { name: 'x', isLead: false })
  check('self-directive always allowed', self.allowed === true)

  // Role ladder precedence.
  check('higher rank directs lower', canDirect({ name: 'a', isLead: false, role: 'field-commander' }, { name: 'b', isLead: false, role: 'scout' }).allowed === true)
  const peerDeny = canDirect({ name: 'a', isLead: false, role: 'specialist' }, { name: 'b', isLead: false, role: 'specialist' })
  check('equal rank denied with coordinate-or-escalate reason', peerDeny.allowed === false && /does not outrank/.test(peerDeny.reason))
  check('lower rank cannot direct higher', canDirect({ name: 'a', isLead: false, role: 'scout' }, { name: 'b', isLead: false, role: 'lead' }).allowed === false)
  check('ranked actor directs role-less member (configured beats unconfigured)', canDirect({ name: 'a', isLead: false, role: 'specialist' }, { name: 'b', isLead: false }).allowed === true)
  check('lead retains authority even with an unranked role', canDirect({ name: 'a', isLead: true, role: 'wizard' }, { name: 'b', isLead: false, role: 'lead' }).allowed === true)

  // Flat default (no roles): lead-only.
  check('flat: lead directs anyone', canDirect({ name: 'lead', isLead: true }, { name: 'b', isLead: false }).allowed === true)
  const flatDeny = canDirect({ name: 'a', isLead: false }, { name: 'b', isLead: false })
  check('flat: non-lead denied with escalate-to-lead reason', flatDeny.allowed === false && /only the lead/.test(flatDeny.reason))

  // resolveDirectActor — case-insensitive member lookup + lead resolution.
  const teamFile = {
    members: [
      { name: 'Alice', agentId: 'id-alice', role: 'specialist' },
      { name: 'bob', agentId: 'id-bob' },
    ],
  } as never
  const alice = resolveDirectActor(teamFile, 'alice', undefined)
  check('member lookup is case-insensitive (role found)', alice.role === 'specialist')
  check('non-lead member resolves isLead=false', alice.isLead === false)
  const leadById = resolveDirectActor(teamFile, 'bob', 'id-bob')
  check('leadAgentId match ⇒ isLead', leadById.isLead === true)
  const leadByName = resolveDirectActor(null, TEAM_LEAD_NAME.toUpperCase(), undefined)
  check('TEAM_LEAD_NAME resolves isLead case-insensitively (no team file)', leadByName.isLead === true)
  const flat = resolveDirectActor(null, 'nobody', undefined)
  check('missing team file ⇒ flat role-less actor', flat.isLead === false && flat.role === undefined)
}

// ───────────────────────────────────────────────────────────────────────────
section('Q&A ledger IO (hermetic) — open → answer lifecycle')
{
  const TEAM = 'proof-team'

  await openQuestion({ request_id: 'q1', from: 'lead', to: 'Bob', text: 'first?' }, TEAM)
  let open = await listOpenQuestions('bob', TEAM)
  check('directed question lists for its addressee case-insensitively', open.length === 1 && open[0]?.text === 'first?')

  // Idempotent on request_id: a re-send refreshes, never duplicates.
  await openQuestion({ request_id: 'q1', from: 'lead', to: 'Bob', text: 'refreshed?' }, TEAM)
  open = await listOpenQuestions('bob', TEAM)
  check('re-sent request_id refreshes (no duplicate)', open.length === 1 && open[0]?.text === 'refreshed?')

  // Non-addressee answer is delivered-but-cannot-close.
  check('non-addressee answer does not close', (await answerQuestion({ request_id: 'q1', answeredBy: 'alice' }, TEAM)) === false)
  check('question still open after spoof-answer', (await listOpenQuestions('bob', TEAM)).length === 1)

  // Addressee answers (different casing) — closes.
  check('addressee answer closes (case-insensitive)', (await answerQuestion({ request_id: 'q1', answeredBy: 'BOB' }, TEAM)) === true)
  check('closed question leaves the open list', (await listOpenQuestions('bob', TEAM)).length === 0)
  check('answered question never re-closes', (await answerQuestion({ request_id: 'q1', answeredBy: 'bob' }, TEAM)) === false)
  check('unknown request_id is a no-op', (await answerQuestion({ request_id: 'zz', answeredBy: 'bob' }, TEAM)) === false)

  // Junk ledger fails open: unreadable state resets rather than blocking.
  const junkTeam = 'junk-team'
  const junkDir = join(TMP, 'teams', junkTeam)
  mkdirSync(junkDir, { recursive: true })
  writeFileSync(join(junkDir, 'questions.json'), '{{{not json', 'utf-8')
  check('junk ledger lists as empty (fail-open)', (await listOpenQuestions('bob', junkTeam)).length === 0)
  await openQuestion({ request_id: 'q2', from: 'lead', to: 'bob', text: 'post-junk?' }, junkTeam)
  check('junk ledger recovers on next write', (await listOpenQuestions('bob', junkTeam)).length === 1)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ ALL GOVERNANCE PROOFS PASS')
} else {
  console.log(` ❌ ${failures} GOVERNANCE CHECK(S) FAILED`)
}
console.log('='.repeat(60))
rmSync(TMP, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
