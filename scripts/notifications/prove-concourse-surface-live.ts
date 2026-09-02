#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'sg4-concourse-live-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
writeFileSync(
  join(home, '.credentials.json'),
  JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-fixture', refreshToken: 'sk-ant-ort01-fixture', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'], subscriptionType: 'max' } }),
)
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}

const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config.ts')
enableConfigs()

import {
  buildConcourseSnapshot,
  readConcourseDraft,
  subscribeConcourseDraft,
  writeConcourseDraft,
} from '../../src/services/concourse/concourseSnapshot.ts'
import { boardRowsOf } from '../../src/components/concourse/contracts.ts'
import { projectIdentity } from '../../src/utils/bootCardFacts.ts'
import { upsertObligation } from '../../src/services/crew/obligations.ts'
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const recordsDir = join(scratch, 'daemon')
const crewDir = join(scratch, 'crew')
const draftDir = join(scratch, 'config')
for (const d of [recordsDir, crewDir, draftDir]) mkdirSync(d, { recursive: true })

const DEAD_PID = 4_194_999

function seedWorkers(records: ConcourseWorkerRecordV1[]): void {
  const workers = Object.fromEntries(records.map(r => [r.runnerId, r]))
  writeFileSync(
    join(recordsDir, 'concourse-workers.json'),
    `${JSON.stringify({ version: 1, workers }, null, 1)}\n`,
  )
}

const NOW = Date.now()
const PROJECT = projectIdentity(join(scratch, 'ws-a'))
const build = (opts: Parameters<typeof buildConcourseSnapshot>[0]): ReturnType<typeof buildConcourseSnapshot> =>
  buildConcourseSnapshot({ project: PROJECT, ...opts })
function rec(over: Partial<ConcourseWorkerRecordV1> & { runnerId: string; sessionId: string }): ConcourseWorkerRecordV1 {
  return {
    schema: 1,
    workspaceId: join(scratch, 'ws-a'),
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 7 * 60_000,
    lastLiveAt: NOW,
    pid: process.pid,
    ...over,
  } as ConcourseWorkerRecordV1
}

console.log('§1 durable draft store')
{
  check('empty store reads empty draft', (await readConcourseDraft(draftDir)) === '')
  await writeConcourseDraft('Fix the reconnect race', draftDir)
  check('write-through round-trip', (await readConcourseDraft(draftDir)) === 'Fix the reconnect race')
  await writeConcourseDraft('x'.repeat(5000), draftDir)
  check('4000-char bound enforced at write', (await readConcourseDraft(draftDir)).length === 4000)
  await writeConcourseDraft('', draftDir)
  check("clear semantics ('' clears)", (await readConcourseDraft(draftDir)) === '')
}

console.log('§2 draft subscribe')
{
  let fired = 0
  const unsub = subscribeConcourseDraft(() => {
    fired += 1
  }, draftDir)
  await writeConcourseDraft('draft v2', draftDir)
  await new Promise(r => setTimeout(r, 10))
  check('a write fires the subscriber', fired >= 1, `fired=${fired}`)
  unsub()
}

console.log('§3 builder honesty rules')
{
  seedWorkers([
    rec({ runnerId: 'concourse-w1', sessionId: 's-alive', workspaceId: join(scratch, 'ws-a') }),
    rec({ runnerId: 'concourse-w2', sessionId: 's-dead', pid: DEAD_PID }),
    rec({ runnerId: 'concourse-w3', sessionId: 's-asked' }),
  ])
  await upsertObligation({
    ref: 'q-migration',
    sessionId: 's-asked',
    question: 'Choose the schema migration order',
    owner: 'worker',
    dir: crewDir,
  })
  const snap = await build({ recordsDir, crewDir, draftDir, nowMs: NOW })
  const byId = new Map(snap.groups.flatMap(g => g.rows).map(r => [r.sessionId, r]))
  check('pid-alive worker → working', byId.get('s-alive')?.state === 'working')
  check('dead-pid worker → needs-you (the client-derived death)', byId.get('s-dead')?.state === 'needs-you')
  check("…and its cell says what happened, never a climbing-age tail", byId.get('s-dead')?.nowLabel === 'its process is gone')
  check(
    'open obligation OUTRANKS liveness (§6.2)',
    byId.get('s-asked')?.state === 'needs-you',
    `state=${byId.get('s-asked')?.state}`,
  )
  check(
    'row seats ALWAYS null (cross-process truth lands later)',
    [...byId.values()].every(r => r.seats === null),
  )
  check('needsYou rail carries the obligation', snap.needsYou.length === 1 && snap.needsYou[0]?.sessionId === 's-asked')
  const LIVE_STATES = ['working', 'needs-you', 'stalled', 'paused', 'ready-to-review', 'attached', 'starting']
  const seatRows = [...byId.values()].filter(
    r => LIVE_STATES.includes(r.state) && (r.state === 'attached' || r.state === 'starting' || r.sessionId !== 's-dead'),
  )
  const liveCount = seatRows.length
  check('counts.live reconciles with the seat-holding rows (dead-pid row EXCLUDED)', snap.counts.live === liveCount, `${snap.counts.live} vs ${liveCount}`)
  check('…and the dead-pid row held no seat in that tally', liveCount === 2, String(liveCount))
  check(
    '§5.5 denominator = live×2 (rules-only default: no coordinator seat)',
    snap.counts.seatsDenominator === liveCount * 2,
    `${snap.counts.seatsDenominator} vs ${liveCount * 2}`,
  )
  check('counts.needsYou = open obligations', snap.counts.needsYou === 1)
  const order = snap.groups.map(g => g.id).join(',')
  check('group order needs-you → working (no starting group: the dead-pid row is a death, not a spawn)', order === 'needs-you,working', order)
  check('draft rides the snapshot', snap.newSession.draft === 'draft v2')

  saveGlobalConfig(c => ({
    ...c,
    concourseCoordinator: { mode: 'agent-assisted' as const, assistModel: 'claude-sonnet-5' },
  }))
  const assisted = await build({ recordsDir, crewDir, draftDir, nowMs: NOW })
  check(
    '§5.5 +1 iff agent-assisted (the coordinator seat joins the denominator)',
    assisted.counts.seatsDenominator === liveCount * 2 + 1,
    `${assisted.counts.seatsDenominator} vs ${liveCount * 2 + 1}`,
  )
  saveGlobalConfig(c => ({ ...c, concourseCoordinator: { mode: 'rules-only' as const } }))
}

console.log('§3b paused derivation + honest actions')
{
  seedWorkers([
    rec({ runnerId: 'concourse-w1', sessionId: 's-live2' }),
    rec({ runnerId: 'concourse-w2', sessionId: 's-paused', pausedAt: NOW - 60_000, pausedBy: 'operator' }),
  ])
  await upsertObligation({
    ref: 'q-on-paused',
    sessionId: 's-paused',
    question: 'Should the schema move first?',
    owner: 'worker',
    dir: crewDir,
  })
  const snap = await build({ recordsDir, crewDir, draftDir, nowMs: NOW })
  const byId = new Map(snap.groups.flatMap(g => g.rows).map(r => [r.sessionId, r]))
  check('an EXPLICIT pause outranks the obligation projection (§5.2 needs-you→paused)', byId.get('s-paused')?.state === 'paused', `state=${byId.get('s-paused')?.state}`)
  check('the PAUSED group renders (board order: after starting)', snap.groups.some(g => g.id === 'paused' && g.label === 'PAUSED'))
  const livePeek = await build({ recordsDir, crewDir, draftDir, peekSessionId: 's-live2', nowMs: NOW })
  check('a live unpaused peek offers pause + redirect (receipts are real now)', JSON.stringify(livePeek.peek?.actions) === JSON.stringify(['enter-full-session', 'pause-after-turn', 'redirect']), JSON.stringify(livePeek.peek?.actions))
  const pausedPeek = await build({ recordsDir, crewDir, draftDir, peekSessionId: 's-paused', nowMs: NOW })
  check('a paused peek offers resume (never pause/redirect through a closed valve)', JSON.stringify(pausedPeek.peek?.actions) === JSON.stringify(['enter-full-session', 'resume']), JSON.stringify(pausedPeek.peek?.actions))
  check('the paused peek state is paused', pausedPeek.peek?.state === 'paused')
}

console.log('§4 scope from the records’ isolation fields')
{
  seedWorkers([
    rec({ runnerId: 'concourse-w1', sessionId: 's-one', workspaceId: join(scratch, 'shared') }),
    rec({ runnerId: 'concourse-w2', sessionId: 's-two', workspaceId: join(scratch, 'shared') }),
  ])
  const overlap = await build({ recordsDir, crewDir, draftDir, peekSessionId: 's-one', nowMs: NOW, project: projectIdentity(join(scratch, 'shared')) })
  check('two exclusive holders of one workspace ⇒ overlap', overlap.peek?.scope.kind === 'overlap')
  seedWorkers([
    rec({ runnerId: 'concourse-w1', sessionId: 's-one', workspaceId: join(scratch, 'shared') }),
    rec({ runnerId: 'concourse-w2', sessionId: 's-two', workspaceId: join(scratch, 'shared'), isolation: 'worktree-isolated' }),
  ])
  const clear = await build({ recordsDir, crewDir, draftDir, peekSessionId: 's-one', nowMs: NOW, project: projectIdentity(join(scratch, 'shared')) })
  check('an isolated co-tenant ⇒ clear', clear.peek?.scope.kind === 'clear')
}

console.log('§5 peek selection, resident states, wired-only actions')
{
  seedWorkers([
    rec({ runnerId: 'concourse-w1', sessionId: 's-alive', workspaceId: join(scratch, 'ws-a') }),
    rec({ runnerId: 'concourse-w2', sessionId: 's-molt', pid: undefined }),
  ])
  const picked = await build({ recordsDir, crewDir, draftDir, peekSessionId: 's-molt', nowMs: NOW })
  check('explicit peek selection honored', picked.peek?.sessionId === 's-molt')
  check('a starting resident molts (FN-001)', picked.peek?.residentState === 'molt', picked.peek?.residentState)
  const defaulted = await build({ recordsDir, crewDir, draftDir, nowMs: NOW })
  check('absent selection ⇒ the first live row', defaulted.peek?.sessionId === 's-alive')
  check('a settled live resident sits settled', defaulted.peek?.residentState === 'settled')
  const wink = await build({ recordsDir, crewDir, draftDir, residentOverride: 'wink', nowMs: NOW })
  check('residentOverride layers the event state', wink.peek?.residentState === 'wink')
  check(
    'LIVE actions derive from the record truth (the receipts are real)',
    JSON.stringify(defaulted.peek?.actions) === JSON.stringify(['enter-full-session', 'pause-after-turn', 'redirect']),
    JSON.stringify(defaulted.peek?.actions),
  )
  check('peek seats null (honest —, never fabricated)', defaulted.peek?.seats === null)
  check('identityColor NOT fabricated by the builder', defaulted.peek !== null && !('identityColor' in (defaulted.peek as object)))
}

console.log('§6 board interleave')
{
  const snap = await build({ recordsDir, crewDir, draftDir, nowMs: NOW })
  const rows = boardRowsOf(snap)
  const headerIdx = rows.findIndex(r => r.kind === 'group')
  check('a group header leads its rows', headerIdx === 0)
  let ok = true
  let current: { count: number; seen: number } | null = null
  for (const r of rows) {
    if (r.kind === 'group') {
      if (current && current.seen !== current.count) ok = false
      current = { count: r.count, seen: 0 }
    } else if (current) current.seen += 1
    else ok = false
  }
  if (current && current.seen !== current.count) ok = false
  check('every header count matches its interleaved rows', ok)
}

console.log('§7 surface: preflight preview, typed collision scope, plain-folder fact')
{
  const { recordCollisionEvidence, canonicalWorkspaceId } = await import('../../src/daemon/concourseSupervisor.ts')
  await writeConcourseDraft('ship the parser fix', draftDir)
  seedWorkers([])
  const okSnap = await build({ recordsDir, crewDir, draftDir, nowMs: NOW })
  check('a drafted request previews preflight OK on a quiet board', okSnap.newSession.preflight?.ok === true, JSON.stringify(okSnap.newSession.preflight))
  seedWorkers([1, 2, 3, 4, 5].map(n =>
    rec({ runnerId: `concourse-w${n}`, sessionId: `s-full-${n}`, workspaceId: join(scratch, `full-${n}`), pid: process.pid })))
  const fullSnap = await build({ recordsDir, crewDir, draftDir, nowMs: NOW })
  check(
    'a full board previews the CEILING refusal before any provider use',
    fullSnap.newSession.preflight?.ok === false && fullSnap.newSession.preflight.refusals.some(r => /every seat is taken|ceiling/.test(r)),
    JSON.stringify(fullSnap.newSession.preflight),
  )
  await writeConcourseDraft('', draftDir)
  const undrafted = await build({ recordsDir, crewDir, draftDir, nowMs: NOW })
  check('no draft ⇒ no preflight claim (the preview binds to a real request)', undrafted.newSession.preflight === undefined)

  const sharedWs = join(scratch, 'shared')
  seedWorkers([
    rec({ runnerId: 'concourse-w1', sessionId: 's-one', workspaceId: sharedWs }),
    rec({ runnerId: 'concourse-w2', sessionId: 's-two', workspaceId: sharedWs }),
  ])
  recordCollisionEvidence(
    {
      schema: 1,
      kind: 'exclusive-overlap',
      workspaceId: canonicalWorkspaceId(sharedWs),
      holders: [{ workerId: 'concourse-w1' }, { workerId: 'concourse-w2' }],
      observedAt: NOW,
    },
    recordsDir,
  )
  const typedScope = await build({ recordsDir, crewDir, draftDir, peekSessionId: 's-one', nowMs: NOW, project: projectIdentity(join(scratch, 'shared')) })
  check(
    'the peek scope line carries the TYPED evidence (holders + when —)',
    typedScope.peek?.scope.kind === 'overlap' && typedScope.peek.scope.detail.includes('2 holder(s)'),
    JSON.stringify(typedScope.peek?.scope),
  )

  seedWorkers([
    { ...rec({ runnerId: 'concourse-w1', sessionId: 's-plain', workspaceId: join(scratch, 'plainws') }), workspaceKind: 'plain-folder' as const },
  ])
  const plainSnap = await build({ recordsDir, crewDir, draftDir, peekSessionId: 's-plain', nowMs: NOW, project: projectIdentity(join(scratch, 'plainws')) })
  check(
    "a plain-folder session's project fact says so (typed capability, zero geometry change)",
    plainSnap.peek?.projectLabel.includes('plain folder') === true,
    JSON.stringify(plainSnap.peek?.projectLabel),
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-CONCOURSE-SURFACE-LIVE: PASS' : `\nPROVE-CONCOURSE-SURFACE-LIVE: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
