#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'cross-project-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const HINT_SNAPSHOT = 'fix buildConcourseSnapshot in src/screen/concourse-model/concourseSnapshot.ts'
const HINT_SWITCH = 'a project switch must change only the view; look for a write in writeConcourseSeedOverride (src/screen/concourse-model/concourseSnapshot.ts) or applyHarnessGround (src/daemon/switchboard/harnessGround.ts)'
const HINT_CHIP = 'fix bootScopedSeedOverrides, readConcourseSeedOverrides or resolveHarnessGround in src/screen/concourse-model/concourseSnapshot.ts'
const HINT_FOCUS = 'fix the carry-over of the focused session in buildConcourseSnapshot (src/screen/concourse-model/concourseSnapshot.ts); the slot lives in src/engine/connector/focusedConnector.ts'
const HINT_ELSEWHERE = 'fix projectActivity or elsewhereLine in src/screen/concourse-model/projectActivity.ts, or the elsewhere group built in src/screen/concourse-model/concourseSnapshot.ts'
const HINT_NAMING = 'fix src/screen/concourse-model/sessionNaming.ts (sessionTitleOf, shouldMintTitle) or setConcourseSessionTitle in src/daemon/concourse-workers/focus.ts'

const { keyHintLabel } = await import('../../src/screen/widgets/keyHintLabel.ts')
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/screen/concourse-model/workerTranscript.ts')
const snapshotMod = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
const { buildConcourseSnapshot, bootScopedSeedOverrides, readConcourseSeedOverrides, resolveHarnessGround, writeConcourseSeedOverride } = snapshotMod
const workers = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
const { applyHarnessGround } = await import('../../src/daemon/switchboard/harnessGround.ts')
const slot = await import('../../src/engine/connector/focusedConnector.ts')
const { getCwd } = await import('../../src/platform/files/cwd.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourse-workers/concourseWorkers.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const NOW = Date.now()
const recordsDir = join(SCRATCH, 'daemon')
const crewDir = join(SCRATCH, 'crew')
const draftDir = join(SCRATCH, 'draft')
for (const d of [recordsDir, crewDir, draftDir]) mkdirSync(d, { recursive: true })

function seedWorkers(records: ConcourseWorkerRecordV1[]): void {
  const workers = Object.fromEntries(records.map(r => [r.runnerId, r]))
  writeFileSync(join(recordsDir, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers }, null, 1)}\n`)
}
function liveRecord(runnerId: string, sessionId: string, workspaceId: string, extra: Partial<ConcourseWorkerRecordV1> = {}): ConcourseWorkerRecordV1 {
  return {
    schema: 1,
    runnerId,
    sessionId,
    workspaceId,
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 7 * 60_000,
    lastLiveAt: NOW,
    pid: process.pid,
    title: `chat ${sessionId.slice(-2)}`,
    ...extra,
  } as ConcourseWorkerRecordV1
}
function transcriptRows(cwd: string, sessionId: string, words: string): Record<string, unknown>[] {
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date(NOW).toISOString(),
    ...extra,
  })
  const reply = row({
    type: 'assistant',
    message: { id: `msg_${sessionId.slice(-4)}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  return words.length > 0 ? [row({ type: 'user', message: { role: 'user', content: words } }), reply] : [reply]
}
function seedChat(project: string, sessionId: string, words: string, ageMs: number): string {
  mkdirSync(project, { recursive: true })
  const file = workerTranscriptPath({ sessionId, workspaceId: project })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(transcriptRows(project, sessionId, words) as never, sessionId))
  const at = new Date(NOW - ageMs)
  utimesSync(file, at, at)
  return file
}
const sid = (tail: string): string => `00000000-cccc-4000-8000-${tail.padStart(12, '0')}`
function treeBytes(dir: string): string {
  if (!existsSync(dir)) return ''
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(`${p.slice(dir.length)}\n${readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return out.join(String.fromCharCode(10) + " " + String.fromCharCode(10))
}
const build = (): ReturnType<typeof buildConcourseSnapshot> => buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: NOW })
async function switchTo(dir: string): Promise<void> {
  await writeConcourseSeedOverride({ projectDir: dir }, draftDir)
  await applyHarnessGround(dir)
}

const P_A = join(SCRATCH, 'proj-alpha')
const P_B = join(SCRATCH, 'proj-beta')
const S_A1 = sid('a1')
const S_A2 = sid('a2')
const S_B1 = sid('b1')

console.log('§1 — SWITCHING NEVER TOUCHES A SESSION: a switch is a change of view; every record byte-identical across A→B→A')
{
  seedChat(P_A, S_A1, 'alpha one', 10 * 60_000)
  seedChat(P_A, S_A2, 'alpha two', 12 * 60_000)
  seedChat(P_B, S_B1, 'beta one', 9 * 60_000)
  seedWorkers([liveRecord('concourse-w1', S_A1, P_A), liveRecord('concourse-w2', S_A2, P_A, { pausedAt: NOW - 60_000, pausedBy: 'operator' }), liveRecord('concourse-w3', S_B1, P_B)])
  await switchTo(P_A)
  const before = { daemon: treeBytes(recordsDir), crew: treeBytes(crewDir), delta: existsSync(workers.concourseDeltaPath(recordsDir)) }
  const atA = await build()
  check('the view at A names A', atA.context.projectLabel === basename(P_A), atA.context.projectLabel, HINT_SNAPSHOT)
  await switchTo(P_B)
  const atB = await build()
  check('the view at B names B (the switch moved the eyes)', atB.context.projectLabel === basename(P_B), atB.context.projectLabel, HINT_SNAPSHOT)
  const afterB = { daemon: treeBytes(recordsDir), crew: treeBytes(crewDir), delta: existsSync(workers.concourseDeltaPath(recordsDir)) }
  check('A→B: every daemon record is byte-identical (nothing paused, parked, retired, blurred or stamped)', afterB.daemon === before.daemon, '', HINT_SWITCH)
  check('A→B: the obligations store is byte-identical (no ask minted, none settled)', afterB.crew === before.crew, '', HINT_SWITCH)
  check('A→B: no delta stamp was published (no roster transition — the daemon never heard about the switch)', afterB.delta === before.delta && before.delta === false, '', HINT_SWITCH)
  check('A→B: the focused slot is untouched (no session focused before, none after)', slot.hasFocusedSession() === false && slot.landingInFlight() === false, '', HINT_SWITCH)
  await switchTo(P_A)
  const backA = await build()
  const afterA = { daemon: treeBytes(recordsDir), crew: treeBytes(crewDir), delta: existsSync(workers.concourseDeltaPath(recordsDir)) }
  check('B→A: the view names A again', backA.context.projectLabel === basename(P_A))
  check('B→A: every record still byte-identical to the start', afterA.daemon === before.daemon && afterA.crew === before.crew && afterA.delta === false)
  check('B→A: the paused session is still paused, the live ones still live (the records say so, unchanged)', (() => {
    const w = workers.readSessionWorkers(recordsDir)
    return w['concourse-w2']?.pausedAt === NOW - 60_000 && w['concourse-w1']?.endedAt === undefined && w['concourse-w3']?.endedAt === undefined && w['concourse-w1']?.focusedAt === undefined
  })(), '', HINT_SWITCH)
  check('the switch door is the ground apply: the cwd state moved with it', getCwd() === P_A, '', 'fix applyHarnessGround in src/daemon/switchboard/harnessGround.ts so it moves the cwd')

  const stamped = workers.focusConcourseSession(S_B1, 'operator:1', recordsDir)
  check('POISON CONTROL: a lifecycle write (the focus stamp) changes the record bytes and publishes a delta — the comparator has teeth', stamped.outcome === 'applied' && treeBytes(recordsDir) !== before.daemon && existsSync(workers.concourseDeltaPath(recordsDir)), '', 'focusConcourseSession in src/daemon/concourse-workers/focus.ts must stamp the record and publish a delta, or treeBytes in this file stopped reading the records')
  workers.blurConcourseSession(S_B1, 'operator:1', recordsDir)
  rmSync(workers.concourseDeltaPath(recordsDir), { force: true })

  const start = 5_000_000
  check('chip law (pure): a chip stamped before this boot reads as unset; its siblings survive', (() => {
    const scoped = bootScopedSeedOverrides({ projectDir: P_B, projectDirAt: start - 1, modelKey: 'fable' }, start)
    return scoped.projectDir === undefined && scoped.projectDirAt === undefined && scoped.modelKey === 'fable'
  })(), '', HINT_CHIP)
  check('chip law (pure): a chip stamped at/after this boot stands', bootScopedSeedOverrides({ projectDir: P_B, projectDirAt: start }, start).projectDir === P_B, '', HINT_CHIP)
  check('chip law (pure): a stampless chip (a pre-law write) reads as unset', bootScopedSeedOverrides({ projectDir: P_B }, start).projectDir === undefined, '', HINT_CHIP)
  await writeConcourseSeedOverride({ projectDir: P_B }, draftDir)
  const fresh = await readConcourseSeedOverrides(draftDir)
  check('the writer stamps the chip with the clock; the reader door honours a chip THIS boot wrote', fresh.projectDir === P_B && typeof fresh.projectDirAt === 'number' && fresh.projectDirAt >= NOW - 60_000, '', HINT_CHIP)
  check('the ground resolver answers the fresh chip (the ground law within a boot)', (await resolveHarnessGround(draftDir)) === P_B, '', HINT_CHIP)
  await writeConcourseSeedOverride({ projectDirAt: Date.now() - Math.floor(process.uptime() * 1000) - 60_000 }, draftDir)
  const stale = await readConcourseSeedOverrides(draftDir)
  check('a chip an earlier boot left behind reads as UNSET through the reader door', stale.projectDir === undefined && stale.projectDirAt === undefined, '', HINT_CHIP)
  check('the ground resolver answers the LIVE ground over the stale chip (the seed-chip follow-up)', (await resolveHarnessGround(draftDir)) === getCwd() && getCwd() === P_A, '', HINT_CHIP)
  check('the stale chip is still in the file (the route\'s mount clears it — the reader door only stops it steering)', readFileSync(join(draftDir, 'concourse-draft.json'), 'utf8').includes(JSON.stringify(P_B).slice(1, -1)), '', HINT_CHIP)
  const staleBoard = await build()
  check('the board never follows a stale chip: the view is the live ground (A), not the chip (B)', staleBoard.context.projectLabel === basename(P_A), '', HINT_CHIP)
  await writeConcourseSeedOverride({ projectDir: null }, draftDir)

}

console.log('§2 — THE FOCUSED SESSION CARRIES OVER: the board filters by project, then always adds the one focused session, ★ from its own project')
{
  const { registerChatPresence, presentStripStops, stripKeyMapHintOf, _resetSurfaceRouteForTesting } = await import('../../src/screen/routes/surfaceRoute.ts')
  const seat = await import('../../src/engine/connector/daemonConnector.ts')
  const paths = await import('../../src/sessions/transcripts/paths.ts')
  registerChatPresence({ present: () => slot.hasFocusedSession() || slot.landingInFlight(), subscribe: slot.subscribeFocusedSessionConnector })
  seedWorkers([liveRecord('concourse-w1', S_A1, P_A), liveRecord('concourse-w2', S_A2, P_A), liveRecord('concourse-w3', S_B1, P_B)])
  await switchTo(P_A)
  const connector = seat.daemonSessionConnectorFor({ sessionId: S_A1, runnerId: 'concourse-w1', title: 'alpha one', projectLabel: basename(P_A), workspaceId: P_A, home: paths.getProjectDir(P_A) })
  slot.setFocusedSessionConnector(connector)
  const atA = await build()
  const flatA = atA.groups.flatMap(g => g.rows)
  check('at A the board shows A\'s sessions and none of B\'s (the project filter is a view)', flatA.some(r => r.sessionId === S_A1) && flatA.some(r => r.sessionId === S_A2) && !flatA.some(r => r.sessionId === S_B1), flatA.map(r => r.sessionId.slice(-2)).join(','), HINT_FOCUS)
  check('at A the focused session is an ordinary row of its own project — no ★', flatA.find(r => r.sessionId === S_A1)?.foreignProject === undefined, '', HINT_FOCUS)
  await switchTo(P_B)
  const atB = await build()
  const flatB = atB.groups.flatMap(g => g.rows)
  const star = flatB.find(r => r.sessionId === S_A1)
  check('★ after the switch to B, X (focused, of A) is on B\'s board', star !== undefined, flatB.map(r => r.sessionId.slice(-2)).join(','), HINT_FOCUS)
  check('★ the row wears its project\'s name as the mark ("from alpha")', star?.foreignProject === basename(P_A), star?.foreignProject, HINT_FOCUS)
  check('★ the row keeps its own state and its NOW cell (live, read from its own tail)', star?.state === 'working' && typeof star?.nowLabel === 'string' && star.nowLabel.length > 0, `${star?.state} · ${star?.nowLabel}`, HINT_FOCUS)
  check('★ the row keeps its own workspace (the mirror reads its own home)', star?.workspaceDir === P_A, '', HINT_FOCUS)
  check('the OTHER A session (unfocused) is NOT on B\'s board — only the focused one carries over', !flatB.some(r => r.sessionId === S_A2), '', HINT_FOCUS)
  check('B\'s own session is a plain row (no mark)', flatB.find(r => r.sessionId === S_B1)?.foreignProject === undefined)
  check('hasFocusedSession() stays true across the switch (the slot never moved)', slot.hasFocusedSession() && slot.getFocusedSessionConnector().sessionId() === S_A1, '', HINT_SWITCH)
  check('the chat stop is present on the strip — shift+→ still enters it (the router untouched)', presentStripStops().includes('repl') && stripKeyMapHintOf('concourse', presentStripStops()).includes(`${keyHintLabel('⇧→')} chat`))
  check('the seats stay GLOBAL under the view: counts.live counts every live record (3) while the board shows two live CHAT rows (the elsewhere door is a door, never a chat)', atB.counts.live === 3 && flatB.filter(r => r.state !== 'parked' && r.door === undefined).length === 2, `${atB.counts.live} / ${flatB.length}`, HINT_SNAPSHOT)
  check('the peek lands on a board row (never on a hidden session)', atB.peek !== null && flatB.some(r => r.sessionId === atB.peek?.sessionId), '', HINT_SNAPSHOT)
  seedWorkers([liveRecord('concourse-w3', S_B1, P_B)])
  const noRec = await build()
  const parkedGroup = noRec.groups.find(g => g.id === 'parked')?.rows ?? []
  const parkedStar = parkedGroup.find(r => r.sessionId === S_A1)
  check('★ with no live record the focused foreign chat stays on the board — parked, first in PARKED, its transcript on the row for the one parked arm', parkedStar !== undefined && parkedStar.state === 'parked' && parkedStar.foreignProject === basename(P_A) && parkedStar.transcriptPath === workerTranscriptPath({ sessionId: S_A1, workspaceId: P_A }) && parkedGroup[0]?.sessionId === S_A1, parkedGroup.map(r => r.sessionId.slice(-2)).join(','), HINT_FOCUS)
  check('★ the parked carry-over never paints twice (one row for the id)', noRec.groups.flatMap(g => g.rows).filter(r => r.sessionId === S_A1).length === 1, '', HINT_FOCUS)
  slot.releaseFocusedSessionConnector()
  seedWorkers([liveRecord('concourse-w1', S_A1, P_A), liveRecord('concourse-w2', S_A2, P_A), liveRecord('concourse-w3', S_B1, P_B)])
  const noFocus = await build()
  check('POISON CONTROL: with no focused session nothing of A rides B\'s board', !noFocus.groups.flatMap(g => g.rows).some(r => r.workspaceDir === P_A), '', HINT_FOCUS)
  _resetSurfaceRouteForTesting()
}

console.log('§3 — A NEW FOCUS HANDS IT BACK SILENTLY: focusing a session of the current project releases the ★ row — no notice, no state change')
{
  const seat = await import('../../src/engine/connector/daemonConnector.ts')
  const paths = await import('../../src/sessions/transcripts/paths.ts')
  seedWorkers([liveRecord('concourse-w1', S_A1, P_A), liveRecord('concourse-w2', S_A2, P_A), liveRecord('concourse-w3', S_B1, P_B)])
  await switchTo(P_A)
  slot.setFocusedSessionConnector(seat.daemonSessionConnectorFor({ sessionId: S_A1, runnerId: 'concourse-w1', title: 'alpha one', projectLabel: basename(P_A), workspaceId: P_A, home: paths.getProjectDir(P_A) }))
  await switchTo(P_B)
  const carried = await build()
  check('the sequence starts with X carried onto B\'s board (★)', carried.groups.flatMap(g => g.rows).find(r => r.sessionId === S_A1)?.foreignProject === basename(P_A), '', HINT_FOCUS)
  const before = { daemon: treeBytes(recordsDir), crew: treeBytes(crewDir) }
  let beats = 0
  const off = slot.subscribeFocusedSessionConnector(() => {
    beats += 1
  })
  slot.setFocusedSessionConnector(seat.daemonSessionConnectorFor({ sessionId: S_B1, runnerId: 'concourse-w3', title: 'beta one', projectLabel: basename(P_B), workspaceId: P_B, home: paths.getProjectDir(P_B) }))
  off()
  check('the slot pulsed once for the new focus (the beat the route rebuilds on)', beats === 1, String(beats), 'setFocusedSessionConnector in src/engine/connector/focusedConnector.ts must notify its subscribers exactly once per new focus')
  const handedBack = await build()
  const flat = handedBack.groups.flatMap(g => g.rows)
  check('X left B\'s board — handed back to its own project', !flat.some(r => r.sessionId === S_A1), flat.map(r => r.sessionId.slice(-2)).join(','), HINT_FOCUS)
  check('Y is a plain row of the current project (no ★ anywhere on the board now)', flat.find(r => r.sessionId === S_B1)?.foreignProject === undefined && flat.every(r => r.foreignProject === undefined), '', HINT_FOCUS)
  check('SILENT: no notice — the groups are the standard groups only (the elsewhere door included, law 4), no NEEDS YOU row names X, no rail entry names X', handedBack.groups.every(g => ['attached', 'needs-you', 'stalled', 'ready-to-review', 'working', 'queued', 'starting', 'paused', 'stopped', 'elsewhere', 'parked'].includes(g.id)) && !handedBack.needsYou.some(o => o.sessionId === S_A1) && handedBack.counts.needsYou === 0, '', HINT_FOCUS)
  check('SILENT: no obligation minted, no record byte moved (the hop\'s blur is the daemon\'s only moving fact, and only on the real hop)', treeBytes(crewDir) === before.crew && treeBytes(recordsDir) === before.daemon, '', HINT_SWITCH)
  check('X\'s state is unchanged: still running, still not paused, not parked, not focused-stamped by anything here', (() => {
    const w = workers.readSessionWorkers(recordsDir)['concourse-w1']
    return w?.endedAt === undefined && w?.pausedAt === undefined && w?.stoppedAt === undefined && w?.focusedAt === undefined
  })(), '', HINT_SWITCH)
  await switchTo(P_A)
  const backHome = await build()
  const xHome = backHome.groups.flatMap(g => g.rows).find(r => r.sessionId === S_A1)
  check('back in A, X is a normal running row of ITS project (working, no mark) — exactly what it was', xHome?.state === 'working' && xHome.foreignProject === undefined, '', HINT_FOCUS)
  check('Y (focused, of B) is now the ★ row on A\'s board — the same law in the other direction', backHome.groups.flatMap(g => g.rows).find(r => r.sessionId === S_B1)?.foreignProject === basename(P_B), '', HINT_FOCUS)
  slot.releaseFocusedSessionConnector()
}

console.log('§4 — THE RUNNING-COUNT LINE, A DOOR: one line per other project with activity, its own group before PARKED, ↵ = the picker\'s own switch')
{
  const { projectActivity, elsewhereLine, ELSEWHERE_CAP, isRunningState, runningByProjectKey } = await import('../../src/screen/concourse-model/projectActivity.ts')
  const { upsertObligation, resolveObligation } = await import('../../src/crew/crewmates/obligations.ts')
  const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
  const { projectIdentity } = await import('../../src/screen/boot-face/bootCardFacts.ts')
  const seat = await import('../../src/engine/connector/daemonConnector.ts')
  const P_C = join(SCRATCH, 'proj-gamma')
  const P_D = join(SCRATCH, 'proj-delta')
  const P_E = join(SCRATCH, 'proj-epsilon')
  const P_F = join(SCRATCH, 'proj-foxtrot')
  const S_A3 = sid('a3')
  const S_B2 = sid('b2')
  const S_C1 = sid('c1')
  const S_C2 = sid('c2')
  const S_D1 = sid('d1')
  const S_E1 = sid('e1')
  const S_E2 = sid('e2')
  const S_F1 = sid('f1')
  for (const [p, s] of [[P_A, S_A3], [P_B, S_B2], [P_C, S_C1], [P_C, S_C2], [P_D, S_D1], [P_E, S_E1], [P_E, S_E2], [P_F, S_F1]] as const) seedChat(p, s, `words ${s.slice(-2)}`, 5 * 60_000)
  const roster = (): ConcourseWorkerRecordV1[] => [
    liveRecord('concourse-w1', S_A1, P_A),
    liveRecord('concourse-w2', S_A2, P_A),
    liveRecord('concourse-w3', S_B1, P_B),
    liveRecord('concourse-w4', S_B2, P_B, { lastDeliveryAt: NOW - 2000, lastTurnSettledAt: NOW - 1000 }),
    liveRecord('concourse-w5', S_C1, P_C),
    liveRecord('concourse-w6', S_C2, P_C),
    liveRecord('concourse-w7', S_D1, P_D, { pausedAt: NOW - 1000, pausedBy: 'operator' }),
    liveRecord('concourse-w8', S_E1, P_E),
    liveRecord('concourse-w9', sid('99'), P_E, { stoppedAt: NOW - 1000, stoppedBy: 'operator' }),
  ]
  seedWorkers(roster())
  const ask = await upsertObligation({ ref: 'q:c2', sessionId: S_C2, question: 'may I push?', owner: 'operator', scope: 'switchboard', dir: crewDir })
  slot.releaseFocusedSessionConnector()
  await switchTo(P_A)
  const snap = await build()
  const ids = snap.groups.map(g => g.id)
  const group = snap.groups.find(g => g.id === 'elsewhere')
  check('the OTHER PROJECTS group exists — after every live group of the current project and BEFORE parked (pinned: before)', group !== undefined && ids.indexOf('working') !== -1 && ids.indexOf('elsewhere') > ids.indexOf('working') && ids.includes('parked') && ids.indexOf('elsewhere') !== -1 && ids.indexOf('elsewhere') < ids.indexOf('parked') && ids[ids.length - 1] === 'parked', ids.join(','), HINT_ELSEWHERE)
  const rows = group?.rows ?? []
  check('the counts per project from the daemon\'s roster + the obligations store: B = 2 running · 1 finished; C = 2 running · 1 needs you (alive and waiting counts as running); E = 1 running (the stopped one does not count)', (snap.elsewhere ?? []).map(p => `${p.name}:${p.running}/${p.needsYou}/${p.finished}`).sort().join(' ') === ['proj-beta:2/0/1', 'proj-epsilon:1/0/0', 'proj-gamma:2/1/0'].join(' '), (snap.elsewhere ?? []).map(p => `${p.name}:${p.running}/${p.needsYou}/${p.finished}`).join(' '), HINT_ELSEWHERE)
  check('a project with a paused session only has NO line (no activity); the CURRENT project never has a line', !(snap.elsewhere ?? []).some(p => p.name === 'proj-delta' || p.name === 'proj-alpha') && !rows.some(r => r.projectLabel === 'proj-delta' || r.projectLabel === 'proj-alpha'), '', HINT_ELSEWHERE)
  check('the lines are painted in NAME order, not count order (content-keyed; a count change never re-sorts)', rows.map(r => r.projectLabel).join(',') === 'proj-beta,proj-epsilon,proj-gamma', rows.map(r => r.projectLabel).join(','), HINT_ELSEWHERE)
  check('the list behind the group is most-active-first (the bound picks by activity)', (snap.elsewhere ?? []).map(p => p.name).join(',') === 'proj-beta,proj-gamma,proj-epsilon', '', HINT_ELSEWHERE)
  check('each line reads the board\'s compact grammar with the door in its NOW cell', rows.map(r => `${r.title} | ${r.nowLabel}`).join(' ; ') === '2 running in proj-beta · 1 finished | switch to see them ; 1 running in proj-epsilon | switch to see them ; 2 running in proj-gamma · 1 needs you | switch to see them', rows.map(r => `${r.title} | ${r.nowLabel}`).join(' ; '), HINT_ELSEWHERE)
  check('each line is a DOOR row keyed by the project\'s catalog key, targeting the project\'s folder, with its counts on the door', rows.every(r => r.state === 'elsewhere' && r.sessionId === `project:${r.door?.kind === 'switch-project' ? getProjectDir(r.door.dir) : ''}` && r.workspaceDir === undefined && r.seats === null) && rows.find(r => r.projectLabel === 'proj-beta')?.door?.kind === 'switch-project' && (rows.find(r => r.projectLabel === 'proj-beta')?.door as { dir?: string }).dir === P_B, '', HINT_ELSEWHERE)
  check('no door row carries a workspace or a transcript — nothing subscribes, nothing mirrors, nothing runs', rows.every(r => r.workspaceDir === undefined && r.transcriptPath === undefined && r.ownerLabel === null), '', HINT_ELSEWHERE)
  check('the whole board still holds the invariant: A\'s two live rows, A\'s parked chat, three doors — nothing of B/C/D/E as a row', snap.groups.flatMap(g => g.rows).filter(r => r.door === undefined).every(r => r.workspaceDir === P_A) && snap.groups.find(g => g.id === 'parked')?.rows.map(r => r.sessionId).join(',') === S_A3, '', HINT_ELSEWHERE)
  check(`the bound is ${ELSEWHERE_CAP} lines (ELSEWHERE_CAP) — three projects fit, no "+more" row`, ELSEWHERE_CAP === 3 && !rows.some(r => r.door?.kind === 'pick-project'), '', HINT_ELSEWHERE)
  seedWorkers([...roster(), liveRecord('concourse-w10', S_F1, P_F)])
  const four = await build()
  const fourRows = four.groups.find(g => g.id === 'elsewhere')?.rows ?? []
  check('four active projects: three lines by activity (B, C, E — the tie E/F breaks by name) painted in name order, then "+1 more"', fourRows.map(r => r.projectLabel).join(',') === 'proj-beta,proj-epsilon,proj-gamma,—' && fourRows[3]?.door?.kind === 'pick-project' && (fourRows[3]?.door as { more?: number }).more === 1 && fourRows[3]?.title === '+1 more project with activity' && fourRows[3]?.nowLabel === `${keyHintLabel('⌃g')} picks one` && (four.elsewhere?.length ?? 0) === 4, fourRows.map(r => r.title).join(' ; '), HINT_ELSEWHERE)
  seedWorkers([...roster(), liveRecord('concourse-w10', S_F1, P_F), liveRecord('concourse-w11', S_E2, P_E)])
  const moved = await build()
  const movedRows = moved.groups.find(g => g.id === 'elsewhere')?.rows ?? []
  check('a count change repaints the line in place: same id, same position, new words (E: 1 → 2 running)', movedRows.map(r => r.sessionId).join(',') === fourRows.map(r => r.sessionId).join(',') && movedRows[1]?.title === '2 running in proj-epsilon' && fourRows[1]?.title === '1 running in proj-epsilon', '', HINT_ELSEWHERE)
  const paths = await import('../../src/sessions/transcripts/paths.ts')
  slot.setFocusedSessionConnector(seat.daemonSessionConnectorFor({ sessionId: S_B1, runnerId: 'concourse-w3', title: 'beta one', projectLabel: basename(P_B), workspaceId: P_B, home: paths.getProjectDir(P_B) }))
  const withStar = await build()
  const bLine = withStar.groups.find(g => g.id === 'elsewhere')?.rows.find(r => r.projectLabel === 'proj-beta')
  check('with B\'s session focused (★ on A\'s board), B\'s line counts the rest: "1 running in proj-beta · 1 finished"', bLine?.title === '1 running in proj-beta · 1 finished' && withStar.groups.flatMap(g => g.rows).find(r => r.sessionId === S_B1)?.foreignProject === basename(P_B), bLine?.title, HINT_ELSEWHERE)
  slot.releaseFocusedSessionConnector()
  const current = projectIdentity(P_A)
  const pure = projectActivity(
    [
      { sessionId: 'x1', state: 'working', workspaceDir: P_B },
      { sessionId: 'x2', state: 'needs-you', workspaceDir: P_B },
      { sessionId: 'x3', state: 'needs-you', workspaceDir: P_C },
      { sessionId: 'x4', state: 'paused', workspaceDir: P_D },
      { sessionId: 'x5', state: 'working', workspaceDir: P_A },
      { sessionId: 'x6', state: 'working', workspaceDir: P_E },
    ],
    { current, excludeSessionId: 'x6', aliveOf: id => id !== 'x3' },
  )
  check('the pure fold: groups by the catalog key, skips the current project and the excluded id, counts a live waiting session as running and a crashed one only as needs-you, drops paused-only projects', pure.map(p => `${p.name}:${p.running}/${p.needsYou}/${p.finished}`).join(' ') === 'proj-beta:2/1/0 proj-gamma:0/1/0', pure.map(p => `${p.name}:${p.running}/${p.needsYou}/${p.finished}`).join(' '), 'fix projectActivity in src/screen/concourse-model/projectActivity.ts')
  check('the ONE running predicate', isRunningState('working', false) && isRunningState('ready-to-review', false) && isRunningState('attached', false) && isRunningState('needs-you', true) && !isRunningState('needs-you', false) && !isRunningState('paused', true) && !isRunningState('stopped', true) && !isRunningState('starting', false) && !isRunningState('parked', true), '', 'fix isRunningState in src/screen/concourse-model/projectActivity.ts')
  const line = (running: number, needsYou: number, finished: number): string => elsewhereLine({ dir: P_B, key: 'k', name: 'foo', running, needsYou, finished })
  check('the line grammar: running leads; needs-you and finished follow only when non-zero; a project with no runner leads with what it has', line(3, 0, 0) === '3 running in foo' && line(2, 1, 1) === '2 running in foo · 1 needs you · 1 finished' && line(0, 2, 0) === '2 need you in foo' && line(0, 0, 1) === '1 finished in foo' && line(0, 1, 1) === '1 finished in foo · 1 needs you', '', 'fix elsewhereLine in src/screen/concourse-model/projectActivity.ts')
  const face = await runningByProjectKey(recordsDir)
  check('the face\'s sync read answers the same running counts per key (B 2 · C 2 · E 2 · F 1; A 2; D none)', face.get(getProjectDir(P_B)) === 2 && face.get(getProjectDir(P_C)) === 2 && face.get(getProjectDir(P_E)) === 2 && face.get(getProjectDir(P_F)) === 1 && face.get(getProjectDir(P_A)) === 2 && face.get(getProjectDir(P_D)) === undefined, [...face.entries()].map(([k, v]) => `${basename(k)}=${v}`).join(','), 'fix runningByProjectKey in src/screen/concourse-model/projectActivity.ts')
  await resolveObligation(ask.obligationId, { kind: 'withdrawn', by: 'prover', scope: 'switchboard', dir: crewDir })
}

console.log('§5 — THE CROSS-PROJECT DOOR: an ask in another project rows on the rail as "switch to foo", the ⚑ counts it, ↵ = switch + open')
{
  const { upsertObligation, openObligations, resolveObligation } = await import('../../src/crew/crewmates/obligations.ts')
  const { obligationFacts } = await import('../../src/crew/crewmates/obligationsBridge.ts')
  const { foldAttention, emptyAttentionState, bucketItems } = await import('../../src/screen/attention/contracts.ts')
  const { railTailParts } = await import('../../src/screen/concourse/NeedsYouRail.tsx')
  const S_B2 = sid('b2')
  slot.releaseFocusedSessionConnector()
  await switchTo(P_A)
  const rosterOf = (b2: Partial<ConcourseWorkerRecordV1>, a1: Partial<ConcourseWorkerRecordV1> = {}): ConcourseWorkerRecordV1[] => [
    liveRecord('concourse-w1', S_A1, P_A, a1),
    liveRecord('concourse-w3', S_B1, P_B),
    liveRecord('concourse-w4', S_B2, P_B, { lastDeliveryAt: NOW - 2000, lastTurnSettledAt: NOW - 1000, ...b2 }),
  ]
  seedWorkers(rosterOf({}))
  const attentionOf = async (): Promise<ReturnType<typeof foldAttention>> =>
    foldAttention(emptyAttentionState(), obligationFacts(await openObligations({ scope: 'switchboard', dir: crewDir }), 'operator', Date.now()))
  const ask = await upsertObligation({ ref: 'q:b1', sessionId: S_B1, question: 'shall I merge?', owner: 'operator', scope: 'switchboard', dir: crewDir })
  const local = await upsertObligation({ ref: 'q:a1', sessionId: S_A1, question: 'which branch?', owner: 'operator', scope: 'switchboard', dir: crewDir })
  const snap = await build()
  const foreignRow = snap.needsYou.find(o => o.obligationId === ask.obligationId)
  const localRow = snap.needsYou.find(o => o.obligationId === local.obligationId)
  check('a foreign ask rows as "switch to <name> · needs you", keeps its question, names ITS project and carries the door', foreignRow?.title === `switch to ${basename(P_B)} · needs you` && foreignRow.question === 'shall I merge?' && foreignRow.projectLabel === basename(P_B) && foreignRow.foreignProject?.dir === P_B && foreignRow.foreignProject.name === basename(P_B), `${foreignRow?.title} | ${foreignRow?.projectLabel}`, 'fix needsYouRowOf in src/screen/concourse-model/concourseSnapshot.ts')
  check('a local ask keeps the ordinary row — its question as title, its own project, no door', localRow?.title === 'which branch?' && localRow.projectLabel === basename(P_A) && localRow.foreignProject === undefined, '', 'fix needsYouRowOf in src/screen/concourse-model/concourseSnapshot.ts')
  check('the rail counts both (the ⚑ counts a foreign need like any need — counts.needsYou is the whole store)', snap.counts.needsYou === 2 && snap.needsYou.length === 2, '', HINT_SNAPSHOT)
  const state1 = await attentionOf()
  check('the attention fold holds the foreign ask in needs-you (the badge\'s own bucket)', bucketItems(state1, 'needs-you').some(i => i.subjectId === `obligation:${ask.obligationId}`))
  await upsertObligation({ ref: 'q:b1', sessionId: S_B1, question: 'shall I merge? (still)', owner: 'operator', scope: 'switchboard', dir: crewDir })
  check('a re-raise (revision bump) of the foreign ask keeps ONE needs-you item for it', bucketItems(await attentionOf(), 'needs-you').filter(i => i.subjectId === `obligation:${ask.obligationId}`).length === 1)
  const tail = railTailParts({ projectLabel: 'proj-beta', agentLabel: 'operator', ageLabel: '01m' }, 200, true)
  check('the rail\'s one affordance on a door row is "switch & open" (no separate open; dismiss stays)', tail.some(p => p.key === 'answer' && p.text.includes('switch & open')) && !tail.some(p => p.key === 'open') && tail.some(p => p.key === 'dismiss'))
  check('an ordinary row keeps "answer & resume" and "open session"', railTailParts({ projectLabel: 'x', agentLabel: 'y', ageLabel: '01m' }, 200).map(p => p.key).join(',') === 'meta,answer,open,dismiss')
  for (const id of [ask.obligationId, local.obligationId]) await resolveObligation(id, { kind: 'withdrawn', by: 'prover', scope: 'switchboard', dir: crewDir })
  const { needsYouCount } = await import('../../src/screen/attention/needsYouCount.ts')
}

console.log('§6 — THE INDICATOR ON THE BOOT FACE: the Projects rows read the same running count from the same owner; a row without one composes its old bytes')
{
  const core = await import('../../assets/splash/splash-core.mjs')
  const c = core.createSplashCore({ nocolor: false, truecolor: true })
  const ESC = String.fromCharCode(27)
  const strip = (s: string): string => s.split(ESC).map((seg, i) => (i === 0 ? seg : seg.replace(/^\[[0-9;]*m/, ""))).join("")
  const vis = (s: string): number => c.vis(s) as number
  const recut = core.assembleCardRows({ cwdBase: 'here', continueTarget: null, menuAvailable: true, concourse: { ctx: 'x' } }) as Array<{ key: string; ctx: string }>
  check('the card composes NO standalone project row (the Session Manager carries the estate)', !recut.some(r => r.key === 'project') && !recut.some(r => r.key === 'sessions') && recut.some(r => r.key === 'concourse'))
  const { resumeProjectEntryOf } = await import('../../src/screen/boot-face/BootResumeScreen.js')
  const mergedRow = resumeProjectEntryOf({ dir: '/p/foo', base: 'foo', ageMs: 5 * 60_000, sessionId: 'a', transcriptPath: null, firstChatAt: 1, firstSessionId: 'a', running: 3 })
  check('the merged screen\'s project row wears "5m · 3 running"', mergedRow.valueLabel === '5m · 3 running', mergedRow.valueLabel, 'fix resumeProjectEntryOf in src/screen/boot-face/BootResumeScreen.tsx')
  const mergedPlain = resumeProjectEntryOf({ dir: '/p/foo', base: 'foo', ageMs: 5 * 60_000, sessionId: 'a', transcriptPath: null, firstChatAt: 1, firstSessionId: 'a' })
  check('no count ⇒ the age alone (a row without one says nothing of it)', mergedPlain.valueLabel === '5m', mergedPlain.valueLabel, 'fix resumeProjectEntryOf in src/screen/boot-face/BootResumeScreen.tsx')
  const rowsNoCount = [{ base: 'foo', ageMs: 60_000, dirShown: '~/p/foo' }, { base: 'bar', ageMs: 120_000, dirShown: '~/p/bar' }]
  const before = c.composeProjects(rowsNoCount, 0, 100) as { lines: string[] }
  const zero = c.composeProjects(rowsNoCount.map(r => ({ ...r, running: 0 })), 0, 100) as { lines: string[] }
  check('the picker composes BYTE-IDENTICAL lines for rows without a count and rows with zero (the launcher seam is untouched)', before.lines.join('\n') === zero.lines.join('\n'), '', 'fix composeProjects in assets/splash/splash-core.mjs')
  const withCount = c.composeProjects([{ ...rowsNoCount[0]!, running: 3 }, rowsNoCount[1]!], 0, 100) as { lines: string[]; rowLines: number[] }
  const fooLine = withCount.lines[withCount.rowLines[0]!]!
  const barLine = withCount.lines[withCount.rowLines[1]!]!
  check('the picker paints "3 running" on the row that runs, right before its age, and nothing on the other', strip(fooLine).includes('3 running') && /3 running\s+1m/.test(strip(fooLine)) && !strip(barLine).includes('running'))
  check('the note never widens the row past the box (the line keeps the box width)', vis(fooLine) === vis(before.lines[withCount.rowLines[0]!]!) && vis(fooLine) === vis(barLine))
  check('the note wears the accent (never the faint ink) and closes with the reset before the faint age', fooLine.includes('3 running' + c.R) && !fooLine.includes(c.hexFg(c.FAINT, c.T256.faint) + '3 running') && fooLine.indexOf('3 running') < fooLine.indexOf(c.hexFg(c.FAINT, c.T256.faint) + '1m'))
}

console.log('§7 — THE ANNEX: Projects-↵ hops into a wordless live newborn through the card')
{
  const { workedInProjects, catalogFirstChat, _resetProjectCatalogForTesting } = await import('../../src/screen/boot-face/bootCardFacts.ts')
  const P_G = join(SCRATCH, 'proj-golf')
  const S_G0 = sid('g0')
  mkdirSync(P_G, { recursive: true })
  _resetProjectCatalogForTesting()
  catalogFirstChat(P_G, S_G0)
  const rowG = workedInProjects().find(r => r.dir === P_G)
  check('a catalogued folder with a wordless first chat lists with the card\'s firstSessionId and no resumable transcript', rowG !== undefined && rowG.sessionId === null && rowG.transcriptPath === null && rowG.firstSessionId === S_G0, JSON.stringify(rowG), 'fix workedInProjects or catalogFirstChat in src/screen/boot-face/bootCardFacts.ts')
  check('a card-less project carries no firstSessionId', workedInProjects().find(r => r.dir === P_A)?.firstSessionId === null, '', 'fix workedInProjects in src/screen/boot-face/bootCardFacts.ts')
  seedWorkers([liveRecord('concourse-w1', S_G0, P_G)])
  check('the gate the face reads: the first session is owned by a LIVE worker (a hop, not a birth)', workers.sessionOwnedByLiveWorker(S_G0, recordsDir) === 'concourse-w1', '', 'fix sessionOwnedByLiveWorker in src/daemon/concourse-workers/queries.ts')
  seedWorkers([])
  check('with no live worker the gate answers null (the birth arm stands, as before)', workers.sessionOwnedByLiveWorker(S_G0, recordsDir) === null, '', 'fix sessionOwnedByLiveWorker in src/daemon/concourse-workers/queries.ts')
}

console.log('§8 — SESSION-AWARE NAMING: three stages, one owner; the mint once at turn two; a typed name survives; never a worker id, in any world')
{
  const { sessionTitleOf, newSessionTitle, isWorkerIdTitle, shouldMintTitle } = await import('../../src/screen/concourse-model/sessionNaming.ts')
  const { transcriptHeadFacts } = await import('../../src/screen/concourse-model/sessionTitleMint.ts')
  const manifest = await import('../../src/screen/concourse/controlManifest.ts')
  const { setConcourseSessionTitle } = workers
  check('stage 1: an untitled, wordless session is the FACT — "new session · <project> · ready" — never an invented name', sessionTitleOf({ workspaceId: P_A }, () => null) === `new session · ${basename(P_A)} · ready` && newSessionTitle(P_A) === `new session · ${basename(P_A)} · ready`, '', HINT_NAMING)
  check('stage 2: the first words name it the moment they exist (zero cost — the board\'s own brief)', sessionTitleOf({ workspaceId: P_A }, () => 'fix the auth tests') === 'fix the auth tests', '', HINT_NAMING)
  check('stage 3 / the operator: a stored title outranks the words', sessionTitleOf({ title: 'Fix flaky auth tests', workspaceId: P_A }, () => 'fix the auth tests') === 'Fix flaky auth tests', '', HINT_NAMING)
  check('the poison detector: the worker short is never a title, and the owner cannot even see one (it is not an input)', isWorkerIdTitle('concourse-w3') && !isWorkerIdTitle('fix the auth tests') && !isWorkerIdTitle(sessionTitleOf({ workspaceId: P_A }, () => null)), '', HINT_NAMING)
  check('the mint gate: at turn ONE never (the poison); at turn two once; never twice (the stamp); never over a name; never on an ended record', !shouldMintTitle({}, 1) && shouldMintTitle({}, 2) && !shouldMintTitle({ titleMintedAt: 1 }, 5) && !shouldMintTitle({ title: 'named' }, 5) && !shouldMintTitle({ endedAt: 1 }, 5), '', HINT_NAMING)
  const S_T1 = sid('t1')
  const S_T2 = sid('t2')
  seedChat(P_A, S_T1, 'one question', 60_000)
  const oneTurn = transcriptHeadFacts({ sessionId: S_T1, workspaceId: P_A })
  check('one reply on record reads ONE assistant turn — the mint stays shut', oneTurn.assistantTurns === 1 && !shouldMintTitle({}, oneTurn.assistantTurns), '', 'fix transcriptHeadFacts in src/screen/concourse-model/sessionTitleMint.ts or shouldMintTitle in src/screen/concourse-model/sessionNaming.ts')
  {
    const file = workerTranscriptPath({ sessionId: S_T2, workspaceId: P_A })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, encodeSeedTranscript([...transcriptRows(P_A, S_T2, 'first ask'), ...transcriptRows(P_A, S_T2, 'second ask')] as never, S_T2))
  }
  const twoTurns = transcriptHeadFacts({ sessionId: S_T2, workspaceId: P_A })
  check('two replies read TWO turns and a description carrying the chat\'s own words', twoTurns.assistantTurns >= 2 && twoTurns.description.includes('first ask') && shouldMintTitle({}, twoTurns.assistantTurns), '', 'fix transcriptHeadFacts in src/screen/concourse-model/sessionTitleMint.ts or shouldMintTitle in src/screen/concourse-model/sessionNaming.ts')
  rmSync(workers.concourseDeltaPath(recordsDir), { force: true })
  seedWorkers([liveRecord('concourse-w1', S_T2, P_A, { title: undefined })])
  const recOf = (): ConcourseWorkerRecordV1 | undefined => workers.readSessionWorkers(recordsDir)['concourse-w1']
  check('a minted title fills the empty slot, stamps titleMintedAt once, and publishes (the delta repaints every board)', setConcourseSessionTitle(S_T2, '  Fix   the auth tests  ', 'title-mint', 'minted', recordsDir).outcome === 'applied' && recOf()?.title === 'Fix the auth tests' && recOf()?.titleSource === 'minted' && typeof recOf()?.titleMintedAt === 'number' && existsSync(workers.concourseDeltaPath(recordsDir)), '', HINT_NAMING)
  seedWorkers([liveRecord('concourse-w1', S_T2, P_A, { title: undefined, titleMintedAt: 5 })])
  check('the mint never runs twice: a second minted write is a NOOP even with the slot empty again', setConcourseSessionTitle(S_T2, 'Another', 'title-mint', 'minted', recordsDir).outcome === 'noop' && (recOf()?.title ?? '') === '', '', HINT_NAMING)
  seedWorkers([liveRecord('concourse-w1', S_T2, P_A, { title: 'My name' })])
  check('a minted word never covers a standing name', setConcourseSessionTitle(S_T2, 'Minted words', 'title-mint', 'minted', recordsDir).outcome === 'noop' && recOf()?.title === 'My name', '', HINT_NAMING)
  check('the operator\'s word always lands, and a later mint bounces off it', setConcourseSessionTitle(S_T2, 'Operator name', 'operator', 'operator', recordsDir).outcome === 'applied' && recOf()?.title === 'Operator name' && recOf()?.titleSource === 'operator' && setConcourseSessionTitle(S_T2, 'Minted again', 'title-mint', 'minted', recordsDir).outcome === 'noop' && recOf()?.title === 'Operator name', '', HINT_NAMING)
  check('an empty operator title and an unknown session are typed refusals', setConcourseSessionTitle(S_T2, '   ', 'operator', 'operator', recordsDir).outcome === 'refused' && setConcourseSessionTitle(sid('zz'), 'x', 'operator', 'operator', recordsDir).outcome === 'refused', '', HINT_NAMING)
  const S_T3 = sid('t3')
  slot.releaseFocusedSessionConnector()
  await switchTo(P_A)
  seedWorkers([liveRecord('concourse-w2', S_T3, P_A, { title: undefined })])
  const stage1 = (await build()).groups.flatMap(g => g.rows).find(r => r.sessionId === S_T3)
  check('the board row of an untitled wordless session reads stage 1 — never concourse-wN', stage1?.title === `new session · ${basename(P_A)} · ready` && !isWorkerIdTitle(stage1?.title ?? ''), stage1?.title, HINT_NAMING)
  seedChat(P_A, S_T3, 'polish the boot face', 30_000)
  const stage2 = (await build()).groups.flatMap(g => g.rows).find(r => r.sessionId === S_T3)
  check('with words on record the row reads them (stage 2)', stage2?.title === 'polish the boot face', stage2?.title, HINT_NAMING)
  seedWorkers([liveRecord('concourse-w2', S_T3, P_A, { title: 'Boot face polish' })])
  const stage3 = (await build()).groups.flatMap(g => g.rows).find(r => r.sessionId === S_T3)
  check('a stored title wins everywhere the snapshot paints (stage 3)', stage3?.title === 'Boot face polish', '', HINT_NAMING)
  {
    const { QueuePart } = await import('../../src/sessions/transcripts/writer/queue.ts')
    const { historyHead } = await import('../../src/sessions/transcripts/historyParts.ts')
    const S_FOLD = sid('f1')
    const file = workerTranscriptPath({ sessionId: S_FOLD, workspaceId: P_A })
    mkdirSync(dirname(file), { recursive: true })
    const queue = new QueuePart()
    const land = async (entry: Record<string, unknown>): Promise<void> => {
      const done = queue.enqueueWrite(file, entry as never)
      await queue.flush()
      await done
    }
    const ts = new Date().toISOString()
    await land({ type: 'user', uuid: 'u-fold-1', parentUuid: null, sessionId: S_FOLD, cwd: P_A, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'initial architecture brief for mint' } })
    await land({ type: 'assistant', uuid: 'a-fold-1', parentUuid: 'u-fold-1', sessionId: S_FOLD, cwd: P_A, timestamp: ts, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'first opening reply for mint' }] } })
    await land({ type: 'user', uuid: 'u-fold-2', parentUuid: 'a-fold-1', sessionId: S_FOLD, cwd: P_A, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'second opening exchange for mint' } })
    await land({ type: 'assistant', uuid: 'a-fold-2', parentUuid: 'u-fold-2', sessionId: S_FOLD, cwd: P_A, timestamp: ts, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'second opening reply for mint' }] } })
    await land({ type: 'system', subtype: 'compact_boundary', uuid: 'cb-fold-1', parentUuid: null, sessionId: S_FOLD, timestamp: ts, content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 10000 } })
    await land({ type: 'user', uuid: 'u-fold-3', parentUuid: 'cb-fold-1', sessionId: S_FOLD, cwd: P_A, timestamp: ts, isSidechain: false, message: { role: 'user', content: 'later follow-up after compaction' } })
    await land({ type: 'assistant', uuid: 'a-fold-3', parentUuid: 'u-fold-3', sessionId: S_FOLD, cwd: P_A, timestamp: ts, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'later reply after compaction' }] } })
    const sealed = historyHead(file)
    const folded = transcriptHeadFacts({ sessionId: S_FOLD, workspaceId: P_A })
    check('a folded session seals its opening turns and transcriptHeadFacts still reads the opening words from the first part', sealed.before > 0 && folded.assistantTurns >= 2 && folded.description.includes('initial architecture brief for mint') && !folded.description.includes('later follow-up after compaction'), JSON.stringify({ before: sealed.before, folded }), 'fix transcriptHeadFacts in src/screen/concourse-model/sessionTitleMint.ts so it reads the opening words from the first sealed part')
  }
}

await applyHarnessGround(null)
removeScratch(SCRATCH)
console.log(failures === 0 ? '\nprove-cross-project: ALL LAWS HOLD' : `\nprove-cross-project: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
