#!/usr/bin/env bun
// ============================================================================
//  scripts/swarm/prove-handoff.ts
//  PROOF: the honesty-gated handoff module (capability-matrix "Next action"
//  debt — validateHandoff + the lock-guarded ledger had wiring-only coverage).
//  Asserts, against the REAL module:
//    • validateHandoff — a success claim ('done') with NO usable evidenceRefs
//      is verified:false (quarantined-but-delivered); whitespace-only refs
//      don't count; blocked/needs-review are honest non-claims needing none;
//    • recordHandoff — verdict stamped onto the persisted row; idempotent
//      refresh on id (re-record never duplicates);
//    • listIncomingHandoffs — unacknowledged-only, and the addressee match is
//      CASE-INSENSITIVE (the rule the sibling Q&A ledger already
//      follows — a handoff to "Bob" must reach bob's TeamBrief);
//    • junk-ledger fail-open.
//
//  Run:  ~/.bun/bin/bun run scripts/swarm/prove-handoff.ts
// ============================================================================

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Sandbox the config home BEFORE importing (getTeamsDir memoizes off this env).
const TMP = mkdtempSync(join(tmpdir(), 'hermes-swarm-handoff-'))
process.env.MERCURY_CONFIG_DIR = TMP

const {
  validateHandoff,
  isSuccessClaim,
  recordHandoff,
  listIncomingHandoffs,
  listAllOpenHandoffs,
  HANDOFF_STATUSES,
} = await import('../../src/utils/swarm/handoff.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' swarm handoff honesty gate — proof')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
section('validateHandoff — success claims need evidence, non-claims never do')
{
  check('status vocabulary is the documented trio', JSON.stringify([...HANDOFF_STATUSES]) === JSON.stringify(['done', 'blocked', 'needs-review']))
  check("only 'done' is a success claim", isSuccessClaim('done') && !isSuccessClaim('blocked') && !isSuccessClaim('needs-review'))

  const bare = validateHandoff({ status: 'done' })
  check('done + no refs ⇒ verified:false', bare.verified === false && bare.isSuccessClaim === true)
  check('unverified reason instructs (attach evidence or downgrade)', /attach files\/commands\/commits|downgrade/.test(bare.reason ?? ''))

  const whitespace = validateHandoff({ status: 'done', evidenceRefs: [{ ref: '   ' }, { ref: '' }] })
  check('whitespace-only refs do not count as evidence', whitespace.verified === false)

  const junkRef = validateHandoff({ status: 'done', evidenceRefs: [null as never, { ref: 42 as never }] })
  check('malformed refs do not count as evidence', junkRef.verified === false)

  const backed = validateHandoff({ status: 'done', evidenceRefs: [{ kind: 'commit', ref: 'abc1234' }] })
  check('done + one real ref ⇒ verified:true', backed.verified === true && backed.isSuccessClaim === true)

  const blocked = validateHandoff({ status: 'blocked' })
  check('blocked needs no evidence (honest non-claim)', blocked.verified === true && blocked.isSuccessClaim === false)
  const review = validateHandoff({ status: 'needs-review' })
  check('needs-review needs no evidence', review.verified === true && review.isSuccessClaim === false)
}

// ───────────────────────────────────────────────────────────────────────────
section('ledger IO (hermetic) — verdict stamping + id idempotency')
{
  const TEAM = 'proof-team'

  const v1 = await recordHandoff(
    { id: 'h1', from: 'executor', to: 'bob', status: 'done', summary: 'built it', evidenceRefs: [{ kind: 'commit', ref: 'abc1234' }, { ref: '  ' }] },
    TEAM,
  )
  check('backed done records verified:true', v1.verified === true)

  const v2 = await recordHandoff(
    { id: 'h2', from: 'executor', to: 'bob', status: 'done', summary: 'trust me' },
    TEAM,
  )
  check('unbacked done records verified:false', v2.verified === false)

  let incoming = await listIncomingHandoffs('bob', TEAM)
  check('recipient sees both handoffs', incoming.length === 2)
  const h1 = incoming.find(h => h.id === 'h1')
  const h2 = incoming.find(h => h.id === 'h2')
  check('persisted row stamps the verdict', h1?.verified === true && h2?.verified === false)
  check('unverified row carries the quarantine reason', typeof h2?.unverifiedReason === 'string' && (h2?.unverifiedReason ?? '').length > 0)
  check('verified row carries no quarantine reason', h1?.unverifiedReason === undefined)
  check('whitespace evidence ref was filtered at persist', h1?.evidenceRefs.length === 1)

  // Idempotent on id: re-record refreshes, never duplicates.
  await recordHandoff({ id: 'h2', from: 'executor', to: 'bob', status: 'needs-review', summary: 'downgraded honestly' }, TEAM)
  incoming = await listIncomingHandoffs('bob', TEAM)
  check('re-recorded id refreshes (no duplicate)', incoming.length === 2)
  check('refresh updates status + verdict', incoming.find(h => h.id === 'h2')?.status === 'needs-review' && incoming.find(h => h.id === 'h2')?.verified === true)
}

// ───────────────────────────────────────────────────────────────────────────
section('listIncomingHandoffs — case-insensitive addressee (the shared rule)')
{
  const TEAM = 'case-team'
  // Sender cased the recipient differently — the handoff MUST still reach
  // bob's TeamBrief (the sibling listOpenQuestions already guarantees this).
  await recordHandoff({ id: 'hc1', from: 'lead', to: 'Bob', status: 'blocked', summary: 'cased differently' }, TEAM)
  const seen = await listIncomingHandoffs('bob', TEAM)
  check('handoff to "Bob" reaches "bob" (case-insensitive)', seen.length === 1)
  const seenUpper = await listIncomingHandoffs('BOB', TEAM)
  check('lookup casing is also normalized', seenUpper.length === 1)
}

// ───────────────────────────────────────────────────────────────────────────
section('acknowledge filtering + junk-ledger fail-open')
{
  const TEAM = 'ack-team'
  await recordHandoff({ id: 'ha1', from: 'a', to: 'bob', status: 'blocked', summary: 'open' }, TEAM)
  await recordHandoff({ id: 'ha2', from: 'a', to: 'bob', status: 'blocked', summary: 'acked' }, TEAM)

  // Mark ha2 acknowledged by editing the ledger directly (close-out shape).
  const ledgerPath = join(TMP, 'teams', TEAM, 'handoffs.json')
  const rows = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as Array<Record<string, unknown>>
  for (const r of rows) if (r.id === 'ha2') r.acknowledgedAt = new Date().toISOString()
  writeFileSync(ledgerPath, JSON.stringify(rows, null, 2), 'utf-8')

  const open = await listIncomingHandoffs('bob', TEAM)
  check('acknowledged handoffs leave the incoming list', open.length === 1 && open[0]?.id === 'ha1')
  const all = await listAllOpenHandoffs(TEAM)
  check('listAllOpenHandoffs is also unacked-only', all.length === 1)

  const junkTeam = 'junk-team'
  const junkDir = join(TMP, 'teams', junkTeam)
  mkdirSync(junkDir, { recursive: true })
  writeFileSync(join(junkDir, 'handoffs.json'), '][ definitely not json', 'utf-8')
  check('junk ledger lists as empty (fail-open)', (await listIncomingHandoffs('bob', junkTeam)).length === 0)
  const vRecover = await recordHandoff({ id: 'hj1', from: 'a', to: 'bob', status: 'blocked', summary: 'post-junk' }, junkTeam)
  check('junk ledger recovers on next write', vRecover.verified === true && (await listIncomingHandoffs('bob', junkTeam)).length === 1)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ ALL HANDOFF PROOFS PASS')
} else {
  console.log(` ❌ ${failures} HANDOFF CHECK(S) FAILED`)
}
console.log('='.repeat(60))
rmSync(TMP, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
