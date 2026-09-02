#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  const raw = (await import('node:fs')).readFileSync(getTeamFilePath(TEAM), 'utf-8')
  let parsed = false
  try { JSON.parse(raw); parsed = true } catch { parsed = false }
  check('roster file is valid JSON after the burst (atomic publish)', parsed)
}

section('(b) sensitivity — the old unlocked read→push→write LOSES members (so (a) is meaningful)')
{
  const TEAM = 'racy-team'
  await freshTeam(TEAM)
  const racyAppend = async (m: Member): Promise<void> => {
    const tf = await readTeamFileAsync(TEAM)
    if (!tf) return
    tf.members.push(m)
    await new Promise(r => setTimeout(r, 2))
    await writeTeamFileAsync(TEAM, tf)
  }
  await Promise.all(Array.from({ length: K }, (_, i) => racyAppend(mkMember(i))))
  const tf = await readTeamFileAsync(TEAM)
  check(`unlocked path drops members (got ${tf?.members.length}, would-be ${K + 1})`, (tf?.members.length ?? 0) < K + 1)
}

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

section('(d) source — lock infra present + spawn appends routed through appendTeamMember')
{
  const fs = await import('node:fs')
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8')
  const th = read('../../src/utils/swarm/teamHelpers.ts')
  check(
    'withLockedTeamFile (async, retry-capable, compromise-guarded) exists',
    th.includes('async function withLockedTeamFile') &&
      th.includes('...LOCK_OPTIONS') &&
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

section('(HB-0068) roster cap — concurrent overshoot capped EXACTLY, surplus rejected')
{
  const CAP = 16
  const TEAM = 'capped-team'
  await freshTeam(TEAM)
  const N = CAP + 8
  const settled = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => appendTeamMember(TEAM, mkMember(i))),
  )
  const ok = settled.filter(s => s.status === 'fulfilled').length
  const rejected = settled.filter(s => s.status === 'rejected').length
  const tf = await readTeamFileAsync(TEAM)
  const len = tf?.members.length ?? 0
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
