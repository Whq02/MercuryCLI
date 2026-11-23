#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'concourse-resume-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
let failHint = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : [detail, failHint].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/screen/concourse-model/workerTranscript.ts')
const { buildConcourseSnapshot, parkedBoardRows, markParkedCleared, readParkedCleared, OLDER_CHATS_ROW_PREFIX } = await import(
  '../../src/screen/concourse-model/concourseSnapshot.ts'
)
const { parkedSessionsOf, PARKED_CAP, projectIdentity, inProject } = await import('../../src/screen/boot-face/bootCardFacts.ts')
const { getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const { switchboardGeometry } = await import('../../src/screen/concourse/ConcourseLayout.tsx')
const { paneWindow } = await import('../../src/screen/widgets/paneWindow.ts')
const state = await import('../../src/boot/process-state/processState.ts')
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
function liveRecord(runnerId: string, sessionId: string, workspaceId: string): ConcourseWorkerRecordV1 {
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
function seedSession(file: string, cwd: string, sessionId: string, words: string, ageMs: number): void {
  mkdirSync(cwd, { recursive: true })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(transcriptRows(cwd, sessionId, words) as never, sessionId))
  const at = new Date(NOW - ageMs)
  utimesSync(file, at, at)
}
function seedChat(project: string, sessionId: string, words: string, ageMs: number): string {
  const file = workerTranscriptPath({ sessionId, workspaceId: project })
  seedSession(file, project, sessionId, words, ageMs)
  return file
}
const sid = (tail: string): string => `00000000-bbbb-4000-8000-${tail.padStart(12, '0')}`
const buildFor = (projectDir: string): ReturnType<typeof buildConcourseSnapshot> =>
  buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: NOW, project: projectIdentity(projectDir) })
const parkedOf = async (projectDir: string): Promise<Array<import('../../src/screen/concourse/contracts.ts').ConcourseRowV1>> => {
  const snap = await buildFor(projectDir)
  return snap.groups.find(g => g.id === 'parked')?.rows ?? []
}

console.log('A1 — parked rows: the CURRENT project\'s chats, minus live records, cleared marks, the host file and wordless files')
const P_CUR = join(SCRATCH, 'proj-current')
const P_OTHER = join(SCRATCH, 'proj-other')
const S_LIVE = sid('11')
const S_A = sid('a1')
const S_B = sid('b2')
const S_BLANK = sid('00')
const S_OTHER = sid('ee')
{
  failHint = 'the parked group is built by buildConcourseSnapshot, parkedBoardRows, markParkedCleared and readParkedCleared in src/screen/concourse-model/concourseSnapshot.ts, from parkedSessionsOf and inProject in src/screen/boot-face/bootCardFacts.ts'
  seedChat(P_CUR, S_LIVE, 'the live one', 10 * 60_000)
  const fileA = seedChat(P_CUR, S_A, 'resume me a', 60 * 60_000)
  seedChat(P_CUR, S_B, 'resume me b', 3 * 60 * 60_000)
  seedChat(P_CUR, S_BLANK, '', 20 * 60_000)
  seedChat(P_CUR, String(state.getSessionId()), 'the host', 5 * 60_000)
  seedChat(P_OTHER, S_OTHER, 'the other project', 60_000)
  const S_OTHER_LIVE = sid('ef')
  seedWorkers([liveRecord('concourse-w1', S_LIVE, P_CUR), liveRecord('concourse-w9', S_OTHER_LIVE, P_OTHER)])

  const snap = await buildFor(P_CUR)
  const ids = snap.groups.map(g => g.id)
  check('the PARKED group is the LAST group (beneath every live row)', ids[ids.length - 1] === 'parked' && ids.length >= 2, ids.join(','))
  check('the live session keeps its live group (working — pid alive)', snap.groups.some(g => g.id === 'working' && g.rows.some(r => r.sessionId === S_LIVE)), ids.join(','))
  const allRows = snap.groups.flatMap(g => g.rows)
  check('NEVER A GLOBAL PILE (live): the other project\'s LIVE session is not on this project\'s board', !allRows.some(r => r.sessionId === S_OTHER_LIVE))
  check('the scoping predicate is the door\'s: the live record\'s origin workspace is in P_CUR, the other is not', inProject(projectIdentity(P_CUR), P_CUR) && !inProject(projectIdentity(P_CUR), P_OTHER))
  const parked = snap.groups.find(g => g.id === 'parked')?.rows ?? []
  check('the parked rows are the CURRENT project\'s chats, newest first', parked.map(r => r.sessionId).join(',') === [S_A, S_B].join(','), parked.map(r => r.sessionId.slice(-2)).join(','))
  check('NEVER A GLOBAL PILE (parked): the other project\'s newer chat is not on this board', !parked.some(r => r.sessionId === S_OTHER))
  check('a session a live record owns is NEVER a parked row (the same id never paints twice)', !parked.some(r => r.sessionId === S_LIVE))
  check("the host's own file is never a candidate", !parked.some(r => r.sessionId === String(state.getSessionId())))
  check('a file with no first words is not a chat (a blank newborn\'s leftover never parks)', !parked.some(r => r.sessionId === S_BLANK))
  check('every parked row says what it is: state parked, a still "parked · <age>" cell, no fabricated seats', parked.every(r => r.state === 'parked' && typeof r.nowLabel === 'string' && /^parked · \d+[mhd]$/.test(r.nowLabel) && r.seats === null && r.ownerLabel === 'Mercury'), parked.map(r => r.nowLabel).join(' | '))
  check('every parked row carries its transcript for the resume door and its project as the mirror home', parked.every(r => r.transcriptPath === workerTranscriptPath({ sessionId: r.sessionId, workspaceId: P_CUR }) && r.workspaceDir === P_CUR && r.projectLabel === basename(P_CUR)))
  check('the AGE cell is the file\'s age; the title is the chat\'s brief', parked.map(r => `${r.ageLabel}:${r.title}`).join(',') === '1h:resume me a,3h:resume me b', parked.map(r => `${r.ageLabel}:${r.title}`).join(','))
  check('parked rows are not live; the COUNTS are the machine\'s (both live records, this project\'s and the other\'s — the seats fraction and the admission pump read them)', snap.counts.live === 2, String(snap.counts.live))
  check('the peek never lands on a parked row nor on another project\'s record (the scoped live record stands)', snap.peek?.sessionId === S_LIVE)
  check('the context names the board\'s project through the door', snap.context.projectLabel === basename(P_CUR))

  const switched = await buildFor(P_OTHER)
  const switchedRows = switched.groups.flatMap(g => g.rows)
  check('switching the project shows THAT project\'s parked chats', (switched.groups.find(g => g.id === 'parked')?.rows ?? []).map(r => r.sessionId).join(',') === S_OTHER && switchedRows.find(r => r.sessionId === S_OTHER)?.workspaceDir === P_OTHER, switchedRows.map(r => r.sessionId.slice(-2)).join(','))
  check('switching the project shows THAT project\'s live session and hides this one\'s', switchedRows.some(r => r.sessionId === S_OTHER_LIVE) && !switchedRows.some(r => r.sessionId === S_LIVE) && !switchedRows.some(r => r.sessionId === S_A))
  check('the switched context names the other project', switched.context.projectLabel === basename(P_OTHER))

  await markParkedCleared(S_A, draftDir)
  const afterClear = await parkedOf(P_CUR)
  check(
    "a cleared parked chat leaves the rows and joins the older line's count (hidden from the board, never from the census — L11/L20)",
    afterClear.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)).map(r => r.sessionId).join(',') === S_B &&
      afterClear.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))?.title === '1 older chat · ↵ to browse',
    afterClear.map(r => `${r.sessionId.slice(-2)}:${r.title}`).join(' | '),
  )
  check('the chat SURVIVES the clearing (the transcript is untouched)', existsSync(fileA))
  check('the mark is durable and readable (the board remembers across rebuilds)', (await readParkedCleared(draftDir)).has(S_A))
  seedWorkers([liveRecord('concourse-w1', S_LIVE, P_CUR), liveRecord('concourse-w2', S_A, P_CUR)])
  const revived = await buildFor(P_CUR)
  check('a cleared chat that runs again is a LIVE row (the mark is a view preference, never session truth)', revived.groups.some(g => g.id === 'working' && g.rows.some(r => r.sessionId === S_A)) && !(revived.groups.find(g => g.id === 'parked')?.rows ?? []).some(r => r.sessionId === S_A))

  seedWorkers([])
  const poison = await parkedOf(P_CUR)
  check('POISON CONTROL (live): the live session\'s file with no record IS a parked row', poison.some(r => r.sessionId === S_LIVE))
  check('POISON CONTROL (cleared): the cleared chat stays off the board while its mark stands', !poison.some(r => r.sessionId === S_A))
  const facts = [
    { sessionId: S_A, transcriptPath: workerTranscriptPath({ sessionId: S_A, workspaceId: P_CUR }), ageMs: 60_000 },
    { sessionId: S_B, transcriptPath: workerTranscriptPath({ sessionId: S_B, workspaceId: P_CUR }), ageMs: 120_000 },
    { sessionId: S_LIVE, transcriptPath: workerTranscriptPath({ sessionId: S_LIVE, workspaceId: P_CUR }), ageMs: 1 },
  ]
  const pure = parkedBoardRows(P_CUR, new Set([S_LIVE]), new Set([S_A]), NOW, undefined, facts)
  check(
    'the pure unit drops live ids and cleared ids from the rows; the cleared chat still counts behind the older line (ONE census — L20)',
    pure.map(r => r.sessionId).join(',') === `${S_B},${OLDER_CHATS_ROW_PREFIX}${P_CUR}` &&
      pure[0]?.workspaceDir === P_CUR &&
      pure[0]?.state === 'parked' &&
      pure[1]?.title === '1 older chat · ↵ to browse',
    pure.map(r => r.title).join(' | '),
  )
  const listed = parkedSessionsOf(P_CUR)
  check('the listing owner lists the project\'s own home only (the path law), newest first', listed.every(s => s.transcriptPath.startsWith(getProjectDir(P_CUR))) && !listed.some(s => s.sessionId === S_OTHER) && listed[0]?.sessionId === String(state.getSessionId()))
  check('the listing owner skips the excluded (host) file', !parkedSessionsOf(P_CUR, { excludeSessionId: String(state.getSessionId()) }).some(s => s.sessionId === String(state.getSessionId())))
}

console.log('A2 — capacity: ≤10 per project (one owner); live rows lead; the window never shrinks')
{
  failHint = 'the cap is PARKED_CAP in src/screen/boot-face/bootCardFacts.ts applied by parkedBoardRows in src/screen/concourse-model/concourseSnapshot.ts; the window geometry is switchboardGeometry in src/screen/concourse/ConcourseLayout.tsx and paneWindow in src/screen/widgets/paneWindow.ts'
  for (let i = 1; i <= 14; i++) seedChat(P_CUR, sid(`c${i}`), `cap ${i}`, (4 + i) * 60 * 60_000)
  seedWorkers([liveRecord('concourse-w1', S_LIVE, P_CUR), liveRecord('concourse-w2', sid('55'), P_CUR), liveRecord('concourse-w3', sid('56'), join(SCRATCH, 'proj-live-3'))])
  const snap = await buildFor(P_CUR)
  const flat = snap.groups.flatMap(g => g.rows)
  check('the third project\'s live session is off this board, yet the machine counts three live', !flat.some(r => r.sessionId === sid('56')) && snap.counts.live === 3, String(snap.counts.live))
  const parked = flat.filter(r => r.state === 'parked')
  const live = flat.filter(r => r.state !== 'parked')
  const cappedParkedRows = parked.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  const cappedOlderLine = parked.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  check(
    `the group is bounded per project by the ONE owner's cap (${PARKED_CAP} — the boot menu's ≤10 precedent); the older line counts the census rest (the cleared chat + five past the cap)`,
    PARKED_CAP === 10 && cappedParkedRows.length === PARKED_CAP && cappedOlderLine?.title === '6 older chats · ↵ to browse',
    `${cappedParkedRows.length} · ${cappedOlderLine?.title ?? '(no line)'}`,
  )
  check(
    'every live row precedes every parked row in the flat walk (the elsewhere DOOR rides between — a door, never a chat)',
    live.filter(r => r.door === undefined).length === 2 && flat.findIndex(r => r.state === 'parked') > flat.map(r => r.state).lastIndexOf('working'),
    live.map(r => `${r.state}${r.door !== undefined ? '(door)' : ''}`).join(' | '),
  )
  const groupsLive = snap.groups.filter(g => g.id !== 'parked').length
  for (const [cols, rows] of [[100, 30], [80, 24], [120, 40], [140, 24]] as const) {
    for (const needsYou of [0, 2]) {
      const before = switchboardGeometry(cols, rows, needsYou, live.length, groupsLive, 1)
      const after = switchboardGeometry(cols, rows, needsYou, flat.length, groupsLive + 1, 1)
      check(`${cols}x${rows} ny=${needsYou}: parked rows never shrink the list window (${before.listContentRows} → ${after.listContentRows})`, after.listContentRows >= before.listContentRows)
      const win = paneWindow(flat.length, 0, after.listContentRows)
      check(`${cols}x${rows} ny=${needsYou}: the first window keeps the first live row (start ${win.start})`, win.start === 0 && win.end > 0)
      const mirrorRows = after.mirrorBand[1] - after.mirrorBand[0] + 1
      check(`${cols}x${rows} ny=${needsYou}: the mirror keeps the geometry owner's floor under the fuller board, clear of the list (beside it at two panes, above it stacked)`, mirrorRows >= 1 && (after.profile === 'wide' ? after.liveCols[1] < after.rightCols[0] : after.mirrorBand[1] < after.listBand[0]))
    }
  }
}

console.log('A4 — the week tier: rows for this week\'s chats (≤10), one "N older chats · ↵ to browse" line for the rest; nothing removed')
{
  failHint = 'the week tier is PARKED_WEEK_MS, PARKED_CAP and projectChatCount in src/screen/boot-face/bootCardFacts.ts, and the older-chats line is built by parkedBoardRows in src/screen/concourse-model/concourseSnapshot.ts'
  const { PARKED_WEEK_MS, projectChatCount } = await import('../../src/screen/boot-face/bootCardFacts.ts')
  const { OLDER_CHATS_ROW_PREFIX } = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
  const DAY = 24 * 60 * 60_000
  check('the week is the tier (one owner)', PARKED_WEEK_MS === 7 * DAY)
  const P_WEEK = join(SCRATCH, 'proj-week')
  const S_W1 = sid('d1')
  const S_W2 = sid('d2')
  const S_W3 = sid('d3')
  seedChat(P_WEEK, S_W1, 'this week one', 1 * 60 * 60_000)
  seedChat(P_WEEK, S_W2, 'this week two', 2 * DAY)
  seedChat(P_WEEK, S_W3, 'this week three', 6 * DAY)
  for (let i = 1; i <= 14; i++) seedChat(P_WEEK, sid(`e${i}`), `older ${i}`, (7 + i) * DAY)
  seedWorkers([liveRecord('concourse-w1', S_W1, P_WEEK)])
  const snap = await buildFor(P_WEEK)
  const parked = snap.groups.find(g => g.id === 'parked')?.rows ?? []
  const rows = parked.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  const line = parked.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  check('the store holds every chat (nothing removed, nothing hidden by the count)', projectChatCount(P_WEEK) === 17)
  check("this week's chats are the rows (the live one excluded), newest first", rows.map(r => r.sessionId).join(',') === [S_W2, S_W3].join(','), rows.map(r => r.sessionId.slice(-2)).join(','))
  check('POISON: no chat older than a week is painted as a row', rows.every(r => r.ageLabel !== null && !/^(7|[89]|1\d|2\d)d$/.test(r.ageLabel)), rows.map(r => r.ageLabel).join(','))
  check('the older line is ONE honest line, LAST in the group, counting the census (17 chats − 2 painted − 1 record-owned = 14 enumerable)', line !== undefined && parked[parked.length - 1] === line && line.title === '14 older chats · ↵ to browse', line?.title)
  check('the older line is a door, not a session: parked state, no transcript, no age, no owner', line?.state === 'parked' && line.transcriptPath === undefined && line.ageLabel === null && line.ownerLabel === null && line.workspaceDir === undefined)
  const P_CAP = join(SCRATCH, 'proj-cap-week')
  for (let i = 1; i <= 12; i++) seedChat(P_CAP, sid(`a${i}`), `week ${i}`, i * 60 * 60_000)
  for (let i = 1; i <= 5; i++) seedChat(P_CAP, sid(`b${i}`), `old ${i}`, (9 + i) * DAY)
  seedWorkers([])
  const capped = (await buildFor(P_CAP)).groups.find(g => g.id === 'parked')?.rows ?? []
  const cappedRows = capped.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  const cappedLine = capped.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  check('the ≤10 cap applies within the week tier; the line counts the rest (2 past the cap + 5 older = 7)', cappedRows.length === PARKED_CAP && cappedLine?.title === '7 older chats · ↵ to browse', `${cappedRows.length} · ${cappedLine?.title ?? '(no line)'}`)
  check('a project whose chats all fit paints no older line', !(await parkedOf(P_OTHER)).some(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)))
}


console.log('B — the New Session tab: declared, keyed, born in the current ground, absent on the reduced stage')
{
  failHint = 'the controls, legends and key resolvers are declared in src/screen/concourse/controlManifest.ts (CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS, regionKeysFor, browseKeysFor); the strip hint is stripKeyMapHintOf in src/screen/routes/surfaceRoute.ts'
  const { CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS, regionKeysFor } = await import('../../src/screen/concourse/controlManifest.ts')
  const tab = CONCOURSE_CONTROLS.find(c => c.id === 'board:new-session')
  check('B1 the tab is a declared control of the list region — n by keyboard, click by pointer', tab !== undefined && tab.region === 'list' && tab.keys.includes('n') && tab.pointer === 'activate' && tab.action === 'concourse:new-session')
  check('B1 the list legend advertises it (a printed key that fires)', CONCOURSE_REGION_KEYS.list.some(k => k.keys === 'n' && k.label === 'new session'))
  check('B1 ↵ keeps enter-session (the tab sits beside the rows, never instead of them)', CONCOURSE_CONTROLS.find(c => c.id === 'board:open')?.keys.includes('return') === true)
  check('B1 the ONE legend resolver drops n exactly when the door is absent (the reduced stage)', regionKeysFor('list', { newSession: false }).every(k => k.keys !== 'n') && regionKeysFor('list', { newSession: true }).some(k => k.keys === 'n') && regionKeysFor('rail', { newSession: false }).length === CONCOURSE_REGION_KEYS.rail.length)
  const { stripKeyMapHintOf } = await import('../../src/screen/routes/surfaceRoute.ts')
  const { keyHintLabel } = await import('../../src/screen/widgets/keyHintLabel.ts')
  check('B4 with the concourse off and no chat, the live view offers the boot face to the left and no chat stop to the right', stripKeyMapHintOf('concourse', ['boot-settings']).startsWith(keyHintLabel('⇧← boot face')) && !stripKeyMapHintOf('concourse', ['boot-settings']).includes(keyHintLabel('⇧→ chat')))
  check('B4 with a chat present the live view offers both moves', stripKeyMapHintOf('concourse', ['boot-settings', 'repl']) === keyHintLabel('⇧← boot face · ⇧→ chat'))
  const { browseKeysFor } = await import('../../src/screen/concourse/controlManifest.ts')
  check("B5 the ONE legend resolver relabels esc by chat presence ('focused chat' ↔ 'boot face'), the other keys untouched", browseKeysFor({ chatPresent: true }).find(k => k.keys === 'esc')?.label === 'focused chat' && browseKeysFor({ chatPresent: false }).find(k => k.keys === 'esc')?.label === 'boot face' && browseKeysFor({ chatPresent: false }).filter(k => k.keys !== 'esc').map(k => k.label).join(',') === browseKeysFor({ chatPresent: true }).filter(k => k.keys !== 'esc').map(k => k.label).join(','))
}

console.log('C — the renames: the idle knob speaks the session estate; the accent module says the screen; the in-process connector is gone')
{
  failHint = 'the knobs are read by concourseIdleRetireMs and concourseNewbornGraceMs in src/daemon/control/idleRetirement.ts and registered in FLAG_REGISTRY in the flag registry'
  const CANON = 'MERCURY_SESSION_IDLE_RETIRE_MINUTES'
  const OLD = 'MERCURY_CONCOURSE_' + 'IDLE_RETIRE_MINUTES'
  const saved = { canon: process.env[CANON], old: process.env[OLD] }
  delete process.env[CANON]
  delete process.env[OLD]
  const { concourseIdleRetireMs, DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES } = await import('../../src/daemon/control/idleRetirement.ts')
  const { FLAG_REGISTRY } = await import('../../src/platform/substrate/flagRegistry.ts')
  check('C1 unset ⇒ the operator\'s ten minutes', concourseIdleRetireMs() === DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES * 60_000 && DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES === 10)
  process.env[OLD] = '5'
  check('C1 the old concourse spelling alone changes nothing (an unknown name)', concourseIdleRetireMs() === DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES * 60_000, String(concourseIdleRetireMs()))
  process.env[CANON] = '7'
  check('C1 the session spelling sets the threshold', concourseIdleRetireMs() === 7 * 60_000, String(concourseIdleRetireMs()))
  delete process.env[OLD]
  check('C1 the session spelling alone sets it', concourseIdleRetireMs() === 7 * 60_000)
  delete process.env[CANON]
  if (saved.canon !== undefined) process.env[CANON] = saved.canon
  if (saved.old !== undefined) process.env[OLD] = saved.old
  const canonRow = FLAG_REGISTRY.find(f => f.env === CANON)
  check('C1 the session spelling is the ONE registered row; the old spelling is no row', canonRow?.kind === 'value' && FLAG_REGISTRY.every(f => f.env !== OLD && !(f.interactsWith ?? []).includes(OLD) && !f.summary.includes(OLD) && !(f.off ?? '').includes(OLD)))
  const GRACE = 'MERCURY_SESSION_NEWBORN_GRACE_MINUTES'
  const GRACE_OLD = 'MERCURY_CONCOURSE_' + 'NEWBORN_GRACE_MINUTES'
  const savedGrace = { canon: process.env[GRACE], old: process.env[GRACE_OLD] }
  delete process.env[GRACE]
  delete process.env[GRACE_OLD]
  const { concourseNewbornGraceMs } = await import('../../src/daemon/control/idleRetirement.ts')
  check('C1 grace: unset ⇒ never (0)', concourseNewbornGraceMs() === 0)
  process.env[GRACE_OLD] = '30'
  check('C1 grace: the old concourse spelling alone changes nothing (an unknown name)', concourseNewbornGraceMs() === 0)
  process.env[GRACE] = '45'
  check('C1 grace: the session spelling sets the grace', concourseNewbornGraceMs() === 45 * 60_000)
  delete process.env[GRACE]
  delete process.env[GRACE_OLD]
  if (savedGrace.canon !== undefined) process.env[GRACE] = savedGrace.canon
  if (savedGrace.old !== undefined) process.env[GRACE_OLD] = savedGrace.old
  const graceRow = FLAG_REGISTRY.find(f => f.env === GRACE)
  check('C1 grace: the session spelling is the ONE registered row; the old spelling is no row', graceRow?.kind === 'value' && FLAG_REGISTRY.every(f => f.env !== GRACE_OLD && !(f.interactsWith ?? []).includes(GRACE_OLD) && !f.summary.includes(GRACE_OLD) && !(f.off ?? '').includes(GRACE_OLD)))
  check('C1 the knob graph is symmetric: idle ↔ grace', (canonRow?.interactsWith ?? []).includes(GRACE) && (graceRow?.interactsWith ?? []).includes(CANON))
}

removeScratch(SCRATCH)
console.log(failures === 0 ? '\nprove-concourse-resume: ALL LAWS HOLD' : `\nprove-concourse-resume: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
