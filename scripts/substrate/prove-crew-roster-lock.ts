#!/usr/bin/env bun

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const TMP = mkdtempSync(join(tmpdir(), 'mercury-roster-lock-'))
process.env.MERCURY_CONFIG_DIR = TMP
const DEBUG_LOG = join(TMP, 'debug.txt')
process.argv.push(`--debug-file=${DEBUG_LOG}`)

const {
  appendCrewMember,
  readCrewFileAsync,
  removeCrewmateFromCrewFile,
  writeCrewFileAsync,
  setMemberMode,
  getCrewFilePath,
} = await import('../../src/utils/swarm/crewHelpers.js')
const { flushDebugLogs } = await import('../../src/utils/debug.js')

let fail = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Member = Parameters<typeof appendCrewMember>[1]
const mkMember = (i: number): Member => ({
  agentId: `agent-${i}@t`,
  name: `agent-${i}`,
  joinedAt: 1,
  tmuxPaneId: `pane-${i}`,
  cwd: '/tmp',
  subscriptions: [],
})

async function freshCrew(name: string): Promise<void> {
  await writeCrewFileAsync(name, {
    name,
    createdAt: 1,
    leadAgentId: 'lead@t',
    members: [
      { agentId: 'lead@t', name: 'lead', joinedAt: 1, tmuxPaneId: 'lead', cwd: '/tmp', subscriptions: [] },
    ],
  })
}

console.log('============================================================')
console.log(' Crew roster lock (#8) — concurrent RMW serialization proof')
console.log('============================================================')

const K = 12

section('(a) withLockedCrewFile append — K concurrent appends, ZERO clobber')
{
  const CREW = 'locked-crew'
  await freshCrew(CREW)
  await Promise.all(Array.from({ length: K }, (_, i) => appendCrewMember(CREW, mkMember(i))))
  const tf = await readCrewFileAsync(CREW)
  const names = new Set((tf?.members ?? []).map(m => m.name))
  check(`all ${K} appended members present (+ lead)`, (tf?.members.length ?? 0) === K + 1, `got ${tf?.members.length}`)
  check('every concurrent appendee survived (no last-write-wins clobber)', Array.from({ length: K }, (_, i) => names.has(`agent-${i}`)).every(Boolean))
  check('lead member preserved', names.has('lead'))
  const raw = (await import('node:fs')).readFileSync(getCrewFilePath(CREW), 'utf-8')
  let parsed = false
  try { JSON.parse(raw); parsed = true } catch { parsed = false }
  check('roster file is valid JSON after the burst (atomic publish)', parsed)
}

section('(b) sensitivity — the old unlocked read→push→write LOSES members (so (a) is meaningful)')
{
  const CREW = 'racy-crew'
  await freshCrew(CREW)
  const racyAppend = async (m: Member): Promise<void> => {
    const tf = await readCrewFileAsync(CREW)
    if (!tf) return
    tf.members.push(m)
    await new Promise(r => setTimeout(r, 2))
    await writeCrewFileAsync(CREW, tf)
  }
  await Promise.all(Array.from({ length: K }, (_, i) => racyAppend(mkMember(i))))
  const tf = await readCrewFileAsync(CREW)
  check(`unlocked path drops members (got ${tf?.members.length}, would-be ${K + 1})`, (tf?.members.length ?? 0) < K + 1)
}

section('(c) withLockedCrewFileSync — setMemberMode semantics preserved')
{
  const CREW = 'sync-crew'
  await freshCrew(CREW)
  await appendCrewMember(CREW, mkMember(0))
  check('setMemberMode returns true for an existing member', setMemberMode(CREW, 'agent-0', 'implement') === true)
  const tf1 = await readCrewFileAsync(CREW)
  check('the mode was written', tf1?.members.find(m => m.name === 'agent-0')?.mode === 'implement')
  check('setMemberMode returns true (no write) when unchanged', setMemberMode(CREW, 'agent-0', 'implement') === true)
  check('setMemberMode returns false for a missing member', setMemberMode(CREW, 'nobody', 'implement') === false)
  check('setMemberMode returns false for a missing crew', setMemberMode('no-such-crew', 'x', 'implement') === false)
}

section('(d) source — lock infra present + spawn appends routed through appendCrewMember')
{
  const fs = await import('node:fs')
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf-8')
  const th = read('../../src/utils/swarm/crewHelpers.ts')
  check(
    'withLockedCrewFile (async, retry-capable, compromise-guarded) exists',
    th.includes('async function withLockedCrewFile') &&
      th.includes('...LOCK_OPTIONS') &&
      th.includes('onCompromised') &&
      th.includes('compromisedCrewLocks.has(path)'),
  )
  check('withLockedCrewFileSync (bounded backoff) exists', th.includes('function withLockedCrewFileSync') && th.includes('lockfile.lockSync(path)'))
  check(
    'writes publish atomically via the durable primitive',
    th.includes('writeCrewFileAtomic') && th.includes('durableAtomicPublish('),
  )
  check('appendCrewMember locks the member-append', /appendCrewMember[\s\S]{0,300}withLockedCrewFile/.test(th))
  const sm = read('../../src/tools/shared/spawnMultiAgent.ts')
  const appendCalls = (sm.match(/await appendCrewMember\(crewName, \{/g) || []).length
  check('every spawn member-append is routed through appendCrewMember (the one in-process strategy)', appendCalls === 1 && !/writeCrewFile\(/.test(sm), `found ${appendCalls}`)
  const inProcess = sm.slice(sm.indexOf('spawnInProcessStrategy'))
  const appendAt = inProcess.indexOf('await appendCrewMember(crewName, {')
  const startAt = inProcess.indexOf('startInProcessCrewmate({')
  check('in-process: appendCrewMember runs before startInProcessCrewmate', appendAt !== -1 && startAt !== -1 && appendAt < startAt, `append@${appendAt} start@${startAt}`)
  check('in-process: a start that throws removes the row it landed', /catch \(error\) \{\s*removeCrewmateFromCrewFile\(crewName, \{ agentId: crewmateId \}\)\s*throw error/.test(inProcess))
  check('no raw crewFile.members.push + writeCrewFileAsync append remains in spawn', !/members\.push\(\{[\s\S]{0,400}writeCrewFileAsync/.test(sm))
}

section('(HB-0068) roster cap — concurrent overshoot capped EXACTLY, surplus rejected')
{
  const CAP = 16
  const CREW = 'capped-crew'
  await freshCrew(CREW)
  const N = CAP + 8
  const settled = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => appendCrewMember(CREW, mkMember(i))),
  )
  const ok = settled.filter(s => s.status === 'fulfilled').length
  const rejected = settled.filter(s => s.status === 'rejected').length
  const tf = await readCrewFileAsync(CREW)
  const len = tf?.members.length ?? 0
  check(`roster capped at exactly ${CAP} (no concurrent overshoot)`, len === CAP, `got ${len}`)
  check(`exactly ${CAP - 1} appends succeeded (lead fills the last slot)`, ok === CAP - 1, `got ${ok}`)
  check(`surplus rejected (${N - (CAP - 1)})`, rejected === N - (CAP - 1), `got ${rejected}`)
  check(
    'cap rejection names the limit',
    settled.some(s => s.status === 'rejected' && /max 16/.test(String((s as PromiseRejectedResult).reason))),
  )
}

section('(decoder) an out-of-shape roster is refused whole, named once, and its bytes stay untouched')
{
  const CREW = 'shapeless-crew'
  const path = getCrewFilePath(CREW)
  mkdirSync(dirname(path), { recursive: true })
  const base = { name: CREW, createdAt: 1, leadAgentId: 'lead@t' }
  const row = { agentId: 'x@t', name: 'x', joinedAt: 1, tmuxPaneId: '', cwd: '/tmp', subscriptions: [] as string[] }
  const shapes: Array<[string, string]> = [
    ['members not an array', JSON.stringify({ ...base, members: 'not-an-array' })],
    ['members missing', JSON.stringify(base)],
    ['a member row without a name', JSON.stringify({ ...base, members: [{ ...row, name: undefined }] })],
    ['a member row whose subscriptions is a string', JSON.stringify({ ...base, members: [{ ...row, subscriptions: 'all' }] })],
    ['hiddenPaneIds a string', JSON.stringify({ ...base, members: [row], hiddenPaneIds: 'pane-1' })],
    ['the file an array', JSON.stringify([base])],
  ]
  for (const [label, bytes] of shapes) {
    writeFileSync(path, bytes)
    const read = await readCrewFileAsync(CREW)
    check(`${label}: the read yields no roster rather than the raw object`, read === null, JSON.stringify(read))
    let append = ''
    try {
      await appendCrewMember(CREW, mkMember(0))
      append = 'resolved'
    } catch (e) {
      append = String(e)
    }
    check(`${label}: appendCrewMember refuses on its existing road, never a TypeError`, /does not exist/.test(append) && !/TypeError/.test(append), append)
    let removed: boolean | string
    try {
      removed = removeCrewmateFromCrewFile(CREW, { name: 'x' })
    } catch (e) {
      removed = String(e)
    }
    check(`${label}: removeCrewmateFromCrewFile answers false, never a throw`, removed === false, String(removed))
    let mode: boolean | string
    try {
      mode = setMemberMode(CREW, 'x', 'implement')
    } catch (e) {
      mode = String(e)
    }
    check(`${label}: setMemberMode answers false, never a throw`, mode === false, String(mode))
    check(`${label}: the bytes on disk are untouched`, readFileSync(path, 'utf8') === bytes)
  }
  const whole = JSON.stringify({
    ...base,
    members: [row],
    hiddenPaneIds: ['p'],
    allowedPaths: [{ path: '/tmp', toolName: 'Bash', addedBy: 'x', addedAt: 1 }],
    governance: { broadcastEnabled: false },
  })
  writeFileSync(path, whole)
  const good = await readCrewFileAsync(CREW)
  check('a whole roster carrying every optional field decodes', good !== null && good.members.length === 1 && good.hiddenPaneIds?.length === 1 && good.allowedPaths?.length === 1)
  await flushDebugLogs()
  const named = readFileSync(DEBUG_LOG, 'utf8').split('\n').filter(l => l.includes('[crew-roster]') && l.includes(path))
  check('the refused file is named ONCE in the debug log across every read of it', named.length === 1, `${named.length} line(s)`)
  const { readStoreRecoveryEvents } = await import('../../src/substrate/storeRecovery.ts')
  const refusedRowsFor = async (at: string) => (await readStoreRecoveryEvents()).filter(e => e.kind === 'refused' && e.store === 'crew-roster' && e.path === at)
  let refused = await refusedRowsFor(path)
  for (let i = 0; i < 40 && refused.length < 1; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    refused = await refusedRowsFor(path)
  }
  check(
    'the refused file is named ONCE on the recovery ledger across every read of every shape (one row per file per process, beside the debug line), bytes left in place',
    refused.length === 1 && refused[0]!.quarantinePath === null && refused[0]!.reason === `${path} is not a decodable roster: left in place, reported`,
    `${refused.length} row(s): ${JSON.stringify(refused)}`,
  )
  const OTHER = 'shapeless-crew-two'
  const otherPath = getCrewFilePath(OTHER)
  mkdirSync(dirname(otherPath), { recursive: true })
  writeFileSync(otherPath, 'not json at all')
  let thrown = ''
  try {
    await readCrewFileAsync(OTHER)
  } catch (e) {
    thrown = String(e)
  }
  let other = await refusedRowsFor(otherPath)
  for (let i = 0; i < 40 && other.length < 1; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    other = await refusedRowsFor(otherPath)
  }
  check('bytes that are not JSON are named on the same road under their own path, the callers keeping their existing error handling; the bytes stay', other.length === 1 && readFileSync(otherPath, 'utf8') === 'not json at all', `${other.length} row(s); read ${thrown || 'resolved'}`)
}

rmSync(TMP, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (fail === 0) console.log('✅ ALL CREW-ROSTER-LOCK PROOFS PASS')
else console.log(`❌ ${fail} CREW-ROSTER-LOCK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(fail === 0 ? 0 : 1)
