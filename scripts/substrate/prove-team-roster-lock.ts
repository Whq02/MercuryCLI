#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-team-roster-lock.ts
//  PROOF (#8): the team roster (config.json) read-modify-write is now serialized
//  under an exclusive proper-lockfile lock (teamHelpers.withLockedTeamFile, mirror
//  of leaseGlob.withLockedStore) + published via tmp+rename. The bug: concurrent
//  member-appends (two spawns) each read the old roster, push, and write — the
//  second clobbers the first, silently dropping a teammate.
//
//  teamHelpers.ts IS loadable under plain bun-run, so this is a LIVE behavioral
//  proof: K concurrent appendTeamMember() calls must ALL survive; the pre-fix
//  unlocked path (replicated inline) is shown to LOSE members (so the test is
//  sensitive — it would catch a regression that dropped the lock).
//
//  Run:  ~/.bun/bin/bun run scripts/substrate/prove-team-roster-lock.ts
// ============================================================================

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect the config home (getTeamsDir → getMercuryHome, memoized off this env)
// BEFORE importing teamHelpers so every getTeamFilePath resolves into the sandbox.
const TMP = mkdtempSync(join(tmpdir(), 'hermes-roster-lock-'))
process.env.MERCURY_CONFIG_DIR = TMP

const {
  appendTeamMember,
  readTeamFileAsync,
  writeTeamFileAsync,
  setMemberMode,
  getTeamFilePath,
} = await import('../../src/utils/swarm/teamHelpers.js')

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Member = Parameters<typeof appendTeamMember>[1]
const mkMember = (i: number): Member => ({
  agentId: `agent-${i}@t`,
  name: `agent-${i}`,
  joinedAt: 1,
  tmuxPaneId: `pane-${i}`,
  cwd: '/tmp',
  subscriptions: [],
})

async function freshTeam(name: string): Promise<void> {
  await writeTeamFileAsync(name, {
    name,
    createdAt: 1,
    leadAgentId: 'lead@t',
    members: [
      { agentId: 'lead@t', name: 'lead', joinedAt: 1, tmuxPaneId: 'lead', cwd: '/tmp', subscriptions: [] },
    ],
  })
}

console.log('============================================================')
console.log(' Team roster lock (#8) — concurrent RMW serialization proof')
console.log('============================================================')

const K = 12

// ── (a) LOCKED appendTeamMember: all K concurrent appends survive ──────────────
section('(a) withLockedTeamFile append — K concurrent appends, ZERO clobber')
{
  const TEAM = 'locked-team'
  await freshTeam(TEAM)
  await Promise.all(Array.from({ length: K }, (_, i) => appendTeamMember(TEAM, mkMember(i))))
  const tf = await readTeamFileAsync(TEAM)
  const names = new Set((tf?.members ?? []).map(m => m.name))
  check(`all ${K} appended members present (+ lead)`, (tf?.members.length ?? 0) === K + 1, `got ${tf?.members.length}`)
  check('every concurrent appendee survived (no last-write-wins clobber)', Array.from({ length: K }, (_, i) => names.has(`agent-${i}`)).every(Boolean))
  check('lead member preserved', names.has('lead'))
  // The published file is well-formed (tmp+rename ⇒ no torn read).
  const raw = (await import('node:fs')).readFileSync(getTeamFilePath(TEAM), 'utf-8')
  let parsed = false
  try { JSON.parse(raw); parsed = true } catch { parsed = false }
  check('roster file is valid JSON after the burst (atomic publish)', parsed)
}

// ── (b) sensitivity: the PRE-FIX unlocked path LOSES members ───────────────────
section('(b) sensitivity — the old unlocked read→push→write LOSES members (so (a) is meaningful)')
{
  const TEAM = 'racy-team'
  await freshTeam(TEAM)
  // Replicate the exact pre-fix pattern: read, push, yield, write — NO lock.
  const racyAppend = async (m: Member): Promise<void> => {
    const tf = await readTeamFileAsync(TEAM)
    // The non-atomic concurrent writes this arm demonstrates can momentarily produce a
    // truncated/half-written config.json → jsonParse fails → null. That IS the race; just
    // skip this append (only the FINAL surviving count matters). Do NOT throw (it would
    // flake the gate on the very corruption it is proving).
    if (!tf) return
    tf.members.push(m)
    await new Promise(r => setTimeout(r, 2)) // widen the interleave window
    await writeTeamFileAsync(TEAM, tf)
  }
  await Promise.all(Array.from({ length: K }, (_, i) => racyAppend(mkMember(i))))
  const tf = await readTeamFileAsync(TEAM)
  check(`unlocked path drops members (got ${tf?.members.length}, would-be ${K + 1})`, (tf?.members.length ?? 0) < K + 1)
}

// ── (c) sync helper still correct (return semantics preserved under the lock) ──
section('(c) withLockedTeamFileSync — setMemberMode semantics preserved')
{
  const TEAM = 'sync-team'
  await freshTeam(TEAM)
  await appendTeamMember(TEAM, mkMember(0))
  check('setMemberMode returns true for an existing member', setMemberMode(TEAM, 'agent-0', 'implement') === true)
  const tf1 = await readTeamFileAsync(TEAM)
  check('the mode was written', tf1?.members.find(m => m.name === 'agent-0')?.mode === 'implement')
  check('setMemberMode returns true (no write) when unchanged', setMemberMode(TEAM, 'agent-0', 'implement') === true)
  check('setMemberMode returns false for a missing member', setMemberMode(TEAM, 'nobody', 'strategy') === false)
  check('setMemberMode returns false for a missing team', setMemberMode('no-such-team', 'x', 'strategy') === false)
}

// ── (d) source: the locking idiom is wired (mirror of leaseGlob.withLockedStore)
section('(d) source — lock infra present + spawn appends routed through appendTeamMember')
{
  const fs = await import('node:fs')
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8')
  const th = read('../../src/utils/swarm/teamHelpers.ts')
  check(
    'withLockedTeamFile (async, retry-capable, compromise-guarded) exists',
    th.includes('async function withLockedTeamFile') &&
      th.includes('...LOCK_OPTIONS') &&
      // the lane refuses to publish after a lease compromise
      // the guard must never regress.
      th.includes('onCompromised') &&
      th.includes('compromisedTeamLocks.has(path)'),
  )
  check('withLockedTeamFileSync (bounded backoff) exists', th.includes('function withLockedTeamFileSync') && th.includes('lockfile.lockSync(path)'))
  check(
    'writes publish atomically via the durable primitive',
    th.includes('writeTeamFileAtomic') && th.includes('durableAtomicPublish('),
  )
  check('appendTeamMember locks the member-append', /appendTeamMember[\s\S]{0,300}withLockedTeamFile/.test(th))
  const sm = read('../../src/tools/shared/spawnMultiAgent.ts')
  const appendCalls = (sm.match(/await appendTeamMember\(teamName, \{/g) || []).length
  check('all 3 spawn member-appends routed through appendTeamMember', appendCalls === 3, `found ${appendCalls}`)
  check('no raw teamFile.members.push + writeTeamFileAsync append remains in spawn', !/members\.push\(\{[\s\S]{0,400}writeTeamFileAsync/.test(sm))
}

// ── roster cap enforced TOCTOU-safe under concurrency ──────────────
section('(HB-0068) roster cap — concurrent overshoot capped EXACTLY, surplus rejected')
{
  const CAP = 16 // must match MAX_TEAM_MEMBERS in src/utils/swarm/teamHelpers.ts
  const TEAM = 'capped-team'
  await freshTeam(TEAM) // 1 lead member already present
  const N = CAP + 8 // fire well past the cap, all concurrent
  const settled = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => appendTeamMember(TEAM, mkMember(i))),
  )
  const ok = settled.filter(s => s.status === 'fulfilled').length
  const rejected = settled.filter(s => s.status === 'rejected').length
  const tf = await readTeamFileAsync(TEAM)
  const len = tf?.members.length ?? 0
  // The whole point: a pre-lock check would let concurrent appends each read
  // length<cap and overshoot to N+1; the in-lock check caps at EXACTLY CAP.
  check(`roster capped at exactly ${CAP} (no concurrent overshoot)`, len === CAP, `got ${len}`)
  check(`exactly ${CAP - 1} appends succeeded (lead fills the last slot)`, ok === CAP - 1, `got ${ok}`)
  check(`surplus rejected (${N - (CAP - 1)})`, rejected === N - (CAP - 1), `got ${rejected}`)
  check(
    'cap rejection names the limit',
    settled.some(s => s.status === 'rejected' && /max 16/.test(String((s as PromiseRejectedResult).reason))),
  )
}

rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL TEAM-ROSTER-LOCK PROOFS PASS')
else console.log(`❌ ${fail} TEAM-ROSTER-LOCK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)
