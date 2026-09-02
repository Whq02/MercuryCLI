#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-concourse-resume.ts — THE CONCOURSE IS THE
//  CONTROL PLANE AND SHOWS THE CURRENT PROJECT'S CHATS (the one-door
//  lifecycle law, rule 4, in the operator's words). The pins are the rule
//  read back off
//  the tree — executed units over the REAL builder, the REAL store and the
//  geometry owner, plus source seams for the doors — no boot (the operator's
//  captures ride the pool pass).
//
//   A  PARKED ROWS OF THE CURRENT PROJECT: the current project's chats (the
//      Boot face's own session store, husk filter and ≤10 bound, listed for
//      ONE project's home) join the board as the LAST group, minus every
//      session a live record paints, the board's cleared marks, the host's
//      own file and any file with no first words; NEVER a global pile —
//      switch the project (the seed the REPO picker and the boot menu's
//      Projects both write) and THAT project's parked chats stand. Each row
//      is honest (state 'parked', a still "parked · <age>" cell, its brief
//      as title, the transcript on the row, its project as mirror home).
//      ↵ reactivates in place through the ONE resume door
//      (focusResumedSession); the double-x clears exactly as a release does
//      (the board's own durable mark — the chat survives), and a release
//      marks the same way so a removed row never bounces back as parked.
//      Capacity: ≤10 per project (one owner), live rows lead the walk, the
//      geometry's list window never shrinks for them, the first window
//      keeps the first live row. THE WEEK TIER (operator, L11): the rows are
//      this week's chats; the rest — older, past the cap, cleared,
//      wordless — collapse into ONE "N older chats · ↵ to browse" line
//      whose ↵ opens the project's own session list (/sessions); nothing is
//      ever removed and no path unlinks a transcript but the operator's own
//      prune door (the /sessions card — the walk's one proven exemption).
//      The poison is another
//      project's chat on the board, a live session painted twice, a cleared
//      row returning, a parked row entered through the live-only hop, a
//      moving cell on a dormant row, an older chat painted as a row, or any
//      unlink.
//   B  THE NEW SESSION TAB: a declared list-region control (click on the
//      SESSIONS title, n from the list), born through THE ONE BIRTH DOOR
//      (bornSession) in the CURRENT harness ground (the seed after every
//      pending write, else the live cwd), the chat focused under the yank
//      law; the reduced stage (concourse off) wires no door, paints no tab
//      and prints no n — the boot menu is the solo road. The poison is a
//      tab that re-implements the birth, births in a frozen boot cwd, or
//      shows on the reduced stage.
//   C  THE RENAMES (at their owners): R3 the
//      idle-retirement knob speaks the session estate — canonical
//      MERCURY_SESSION_IDLE_RETIRE_MINUTES, the legacy concourse spelling
//      tolerated one rung below and dated for removal, both registered; R4
//      the accent module's own words say THE SCREEN's costume; R5 no
//      "in-process connector" survives (landed with the dead organ). R1 (the
//      daemon's wire ops) and R2 (the persisted workerId → runnerId) LANDED
//      as the two-phase migrations behind the daemon-version handshake
//      — no longer parked.
//   (The concourse-off Projects road left this lane for FOLDERPROJ — the
//   folder-as-project lane owns that road and its pin.)
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// realpathSync: on macOS tmpdir() answers through the /var symlink, and a
// transcript path resolved BEFORE its project dir exists rides the raw
// spelling (the resolver's documented failed-canonicalization answer) while
// every later call canonicalizes to /private/var — a different slug home, so
// exactly the FIRST-seeded file per project went invisible to the readers
// (the four store-projection fails). A real SCRATCH makes raw == canonical
// on every call; linux (the hosted gate) never had the symlink.
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'concourse-resume-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
// The builder's coordinator resolution and the parked listing both read the
// config home — pin it to scratch so this prover owns every store it reads.
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
// The credential store rides the scratch home too (the file-backed store —
// the keychain chain ignores the config-home pin on darwin, so a by-hand
// run would otherwise reach this machine's keychain).
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
const { buildConcourseSnapshot, parkedBoardRows, markParkedCleared, readParkedCleared, OLDER_CHATS_ROW_PREFIX } = await import(
  '../../src/services/concourse/concourseSnapshot.ts'
)
const { parkedSessionsOf, PARKED_CAP, projectIdentity, inProject } = await import('../../src/utils/bootCardFacts.ts')
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { switchboardGeometry } = await import('../../src/components/concourse/ConcourseLayout.tsx')
const { paneWindow } = await import('../../src/components/mercury-ui/paneWindow.ts')
const state = await import('../../src/bootstrap/state.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseSupervisor.ts'

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
/** A durable session file: the first user words are the row's brief; an
 *  empty `words` seeds a file with NO user turn (a blank newborn's leftover). */
function transcriptRows(cwd: string, sessionId: string, words: string): Record<string, unknown>[] {
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    userType: 'external',
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
/** Seed one session file at `file`, aged `ageMs`. */
function seedSession(file: string, cwd: string, sessionId: string, words: string, ageMs: number): void {
  mkdirSync(cwd, { recursive: true })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(transcriptRows(cwd, sessionId, words) as never, sessionId))
  const at = new Date(NOW - ageMs)
  utimesSync(file, at, at)
}
/** Seed a chat of `project` (its file where the path law puts it). */
function seedChat(project: string, sessionId: string, words: string, ageMs: number): string {
  const file = workerTranscriptPath({ sessionId, workspaceId: project })
  seedSession(file, project, sessionId, words, ageMs)
  return file
}
const sid = (tail: string): string => `00000000-bbbb-4000-8000-${tail.padStart(12, '0')}`
// The board's project rides the builder's proof seam (the catalog door's own
// identity of a folder — the same shape currentProject() answers for the
// live ground), so the rig never depends on the process's cwd.
const buildFor = (projectDir: string): ReturnType<typeof buildConcourseSnapshot> =>
  buildConcourseSnapshot({ recordsDir, crewDir, draftDir, nowMs: NOW, project: projectIdentity(projectDir) })
const parkedOf = async (projectDir: string): Promise<Array<import('../../src/components/concourse/contracts.ts').ConcourseRowV1>> => {
  const snap = await buildFor(projectDir)
  return snap.groups.find(g => g.id === 'parked')?.rows ?? []
}

// ── A1: the current project's parked chats over the real builder ────────────
console.log('A1 — parked rows: the CURRENT project\'s chats, minus live records, cleared marks, the host file and wordless files')
const P_CUR = join(SCRATCH, 'proj-current')
const P_OTHER = join(SCRATCH, 'proj-other')
const S_LIVE = sid('11')
const S_A = sid('a1')
const S_B = sid('b2')
const S_BLANK = sid('00')
const S_OTHER = sid('ee')
{
  seedChat(P_CUR, S_LIVE, 'the live one', 10 * 60_000)
  const fileA = seedChat(P_CUR, S_A, 'resume me a', 60 * 60_000)
  seedChat(P_CUR, S_B, 'resume me b', 3 * 60 * 60_000)
  seedChat(P_CUR, S_BLANK, '', 20 * 60_000)
  // The host's OWN file (this screen's session id) is never a candidate,
  // newest of all.
  seedChat(P_CUR, String(state.getSessionId()), 'the host', 5 * 60_000)
  // Another project's newest chat — newer than everything above — and a
  // LIVE session of that other project: neither may appear while the board's
  // project is P_CUR (never a global pile; the scope is inProject over the
  // record's ORIGIN workspace).
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

  // The project switch: the ground the REPO picker and the boot menu's
  // Projects both move puts THAT project's chats — live and parked — on the
  // board, and this project's off it.
  const switched = await buildFor(P_OTHER)
  const switchedRows = switched.groups.flatMap(g => g.rows)
  check('switching the project shows THAT project\'s parked chats', (switched.groups.find(g => g.id === 'parked')?.rows ?? []).map(r => r.sessionId).join(',') === S_OTHER && switchedRows.find(r => r.sessionId === S_OTHER)?.workspaceDir === P_OTHER, switchedRows.map(r => r.sessionId.slice(-2)).join(','))
  check('switching the project shows THAT project\'s live session and hides this one\'s', switchedRows.some(r => r.sessionId === S_OTHER_LIVE) && !switchedRows.some(r => r.sessionId === S_LIVE) && !switchedRows.some(r => r.sessionId === S_A))
  check('the switched context names the other project', switched.context.projectLabel === basename(P_OTHER))

  // THE DOUBLE-X's durable effect: the cleared mark drops the row and the
  // chat survives on disk (the boot menu and /resume still offer it).
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
  // A cleared chat that RUNS again paints live regardless of the mark.
  seedWorkers([liveRecord('concourse-w1', S_LIVE, P_CUR), liveRecord('concourse-w2', S_A, P_CUR)])
  const revived = await buildFor(P_CUR)
  check('a cleared chat that runs again is a LIVE row (the mark is a view preference, never session truth)', revived.groups.some(g => g.id === 'working' && g.rows.some(r => r.sessionId === S_A)) && !(revived.groups.find(g => g.id === 'parked')?.rows ?? []).some(r => r.sessionId === S_A))

  // POISON CONTROLS: the same file with no live record IS a parked row
  // (the live exclusion did the work); the same file with no cleared mark
  // IS a parked row (the mark did the work).
  seedWorkers([])
  const poison = await parkedOf(P_CUR)
  check('POISON CONTROL (live): the live session\'s file with no record IS a parked row', poison.some(r => r.sessionId === S_LIVE))
  check('POISON CONTROL (cleared): the cleared chat stays off the board while its mark stands', !poison.some(r => r.sessionId === S_A))
  // The pure unit: the subtractions are honoured without the store.
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
  // The listing owner lists ONE project's home and nothing else.
  const listed = parkedSessionsOf(P_CUR)
  check('the listing owner lists the project\'s own home only (the path law), newest first', listed.every(s => s.transcriptPath.startsWith(getProjectDir(P_CUR))) && !listed.some(s => s.sessionId === S_OTHER) && listed[0]?.sessionId === String(state.getSessionId()))
  check('the listing owner skips the excluded (host) file', !parkedSessionsOf(P_CUR, { excludeSessionId: String(state.getSessionId()) }).some(s => s.sessionId === String(state.getSessionId())))
}

// ── A2: capacity — bounded per project, live rows never pushed off the board ─
console.log('A2 — capacity: ≤10 per project (one owner); live rows lead; the window never shrinks')
{
  for (let i = 1; i <= 14; i++) seedChat(P_CUR, sid(`c${i}`), `cap ${i}`, (4 + i) * 60 * 60_000)
  // Two live sessions of THIS project lead the board; a third project's
  // live session is off it (the scope) and counted only by the machine.
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
      const before = switchboardGeometry(cols, rows, needsYou, live.length, groupsLive, 1, 'mirror')
      const after = switchboardGeometry(cols, rows, needsYou, flat.length, groupsLive + 1, 1, 'mirror')
      check(`${cols}x${rows} ny=${needsYou}: parked rows never shrink the list window (${before.listContentRows} → ${after.listContentRows})`, after.listContentRows >= before.listContentRows)
      const win = paneWindow(flat.length, 0, after.listContentRows)
      check(`${cols}x${rows} ny=${needsYou}: the first window keeps the first live row (start ${win.start})`, win.start === 0 && win.end > 0)
      const mirrorRows = after.mirrorBand[1] - after.mirrorBand[0] + 1
      check(`${cols}x${rows} ny=${needsYou}: the mirror keeps the geometry owner's floor under the fuller board`, mirrorRows >= 1 && after.listBand[1] < after.mirrorBand[0])
    }
  }
}

// ── A4: the recency tier (operator, L11) — a week of rows, the rest one line ─
console.log('A4 — the week tier: rows for this week\'s chats (≤10), one "N older chats · ↵ to browse" line for the rest; nothing removed')
{
  const { PARKED_WEEK_MS, projectChatCount } = await import('../../src/utils/bootCardFacts.ts')
  const { OLDER_CHATS_ROW_PREFIX } = await import('../../src/services/concourse/concourseSnapshot.ts')
  const DAY = 24 * 60 * 60_000
  check('the week is the tier (one owner)', PARKED_WEEK_MS === 7 * DAY)
  const P_WEEK = join(SCRATCH, 'proj-week')
  const S_W1 = sid('d1')
  const S_W2 = sid('d2')
  const S_W3 = sid('d3')
  seedChat(P_WEEK, S_W1, 'this week one', 1 * 60 * 60_000)
  seedChat(P_WEEK, S_W2, 'this week two', 2 * DAY)
  seedChat(P_WEEK, S_W3, 'this week three', 6 * DAY)
  for (let i = 1; i <= 14; i++) seedChat(P_WEEK, sid(`o${i}`), `older ${i}`, (7 + i) * DAY)
  // One of this week's chats is LIVE: its transcript is on the board as a live
  // row, so it is neither a parked row nor an "older" chat.
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
  // Cap first, then the line counts the rest: twelve chats this week, five
  // older ⇒ ten rows and "7 older chats".
  const P_CAP = join(SCRATCH, 'proj-cap-week')
  for (let i = 1; i <= 12; i++) seedChat(P_CAP, sid(`w${i}`), `week ${i}`, i * 60 * 60_000)
  for (let i = 1; i <= 5; i++) seedChat(P_CAP, sid(`x${i}`), `old ${i}`, (9 + i) * DAY)
  seedWorkers([])
  const capped = (await buildFor(P_CAP)).groups.find(g => g.id === 'parked')?.rows ?? []
  const cappedRows = capped.filter(r => !r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  const cappedLine = capped.find(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX))
  check('the ≤10 cap applies within the week tier; the line counts the rest (2 past the cap + 5 older = 7)', cappedRows.length === PARKED_CAP && cappedLine?.title === '7 older chats · ↵ to browse', `${cappedRows.length} · ${cappedLine?.title ?? '(no line)'}`)
  check('a project whose chats all fit paints no older line', !(await parkedOf(P_OTHER)).some(r => r.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)))
  // The door (L20, superseding the /sessions arm): ↵ on the line unfolds
  // the census DROP-DOWN in place on the board; a pick reactivates through
  // the ONE resume door (resumeOlderChat → the parked leg). The board keeps
  // the frame — no route change, no chat shunt.
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  const enterAt = route.indexOf('const attachAndEnter = useCallback(')
  const enterBody = route.slice(enterAt, route.indexOf('const waitingRoomAdmitted = useCallback(', enterAt))
  check('↵ on the older line never shunts into a route — the /sessions arm is dead; an older id reaching the enter door is a typed refusal', enterBody.includes('if (sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {') && enterBody.includes('the older chats unfold on the board') && !route.includes('createUserMessage') && !route.includes('armedRootCommand'))
  check('a census pick reactivates through the ONE resume door (resumeOlderChat rides the parked leg of attachAndEnter — never a second writer)', route.includes('resumeOlderChat: (sessionId, transcriptPath, title) => {') && route.includes("attachAndEnter(sessionId, 'board:open', { parkedFact: { transcriptPath, title } })") && enterBody.includes('const parked = opts?.parkedFact ?? rowParked'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('x on the older line clears nothing (the chats behind it clear one at a time); the mirror and the peek say what it is', screen.includes('if (sel.sessionId.startsWith(OLDER_CHATS_ROW_PREFIX)) {') && screen.includes('older chats — ↵ unfolds the list right here'))
  check('the drop-down is the screen\'s own in-place layer: unfold on ↵/→, esc folds, a selection move folds (a VIEW, never a hop)', screen.includes('const unfoldOlderList = (row: ConcourseRowV1): void => {') && screen.includes('setOlderList(null)') && screen.includes('olderNavConsumed'))
  const builder = read('src/services/concourse/concourseSnapshot.ts')
  check('the builder lists the WEEK tier and pushes the older line after the rows (cap first)', builder.includes('withinMs: PARKED_WEEK_MS,') && builder.indexOf('for (const s of listed) {') !== -1 && builder.indexOf('rows.push(olderChatsRow(') > builder.indexOf('for (const s of listed) {'))
  // The census pass (L20): the line derives from ONE
  // owner that ENUMERATES — the retired arithmetic counted husks and
  // wordless leftovers no browse could ever show (the 21-vs-0 lie).
  check(
    'the line derives from THE CENSUS — one owner enumerates and counts; no second arithmetic',
    builder.includes('const census = olderChatsCensus(projectDir, excluded, nowMs') &&
      builder.includes('for (const r of rows) excluded.add(r.sessionId)') &&
      builder.includes('if (census.total > 0) rows.push(olderChatsRow(projectDir, projectLabel, census.total))') &&
      !builder.includes('liveInProject'),
  )
  // TRANSCRIPTS ARE NEVER AUTO-DELETED: no board, reconcile, idle or store
  // path unlinks a transcript — a source walk over src/ finds no unlink/rm
  // whose line names a transcript or a .jsonl; the owners of the board
  // (builder, route, store owner), the reconcile and the idle reaper carry
  // no transcript unlink at all. THE ONE EXEMPTION (the operator's L11
  // later parcel): the operator-pressed prune door — the
  // single file allowed to unlink a transcript, behind the /sessions
  // confirmation card. The walk skips exactly that file, and the checks
  // after it pin that the exempt file really IS the door (its ONLY-door
  // marker stands) and that the door's delete function never appears in
  // the sweep's file, so auto-deletion cannot re-arm through the sweep.
  // The door's own laws (deletes only the confirmed card's named set,
  // No/esc delete nothing, a live record's transcript never offered) are
  // pinned in prove-status-prune.ts.
  const { readdirSync, statSync } = await import('node:fs')
  const offenders: string[] = []
  const THE_ONE_DOOR = join('src', 'utils', 'sessionStorage', 'transcriptPruneDoor.ts')
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith(THE_ONE_DOOR)) continue
      else if (/\.(ts|tsx)$/.test(name)) {
        const lines = readFileSync(p, 'utf8').split('\n')
        lines.forEach((l, i) => {
          // The teeth name the RECEIPTS spellings too (T5–T6):
          // the paper trail rides the transcript's retention law, so a
          // delete naming a receipts path is the same offence class.
          if (/unlinkSync\(|rmSync\(|\.unlink\(|\brm\(|rimraf/.test(l) && /transcript|\.jsonl|workerTranscriptPath|getTranscriptPath|receiptsPath|SessionReceipt/i.test(l)) offenders.push(`${p}:${i + 1}`)
        })
      }
    }
  }
  walk(join(process.cwd(), 'src'))
  check('POISON: no unlink/rm of a transcript anywhere in src (the one operator-pressed door excepted, proven below to BE the door)', offenders.length === 0, offenders.join(', '))
  const doorSource = readFileSync(join(process.cwd(), THE_ONE_DOOR), 'utf8')
  check('the one exempt file exists and IS the door (the ONLY-door marker stands at the door)', doorSource.includes('THE ONLY DOOR IN THE PRODUCT THAT DELETES A TRANSCRIPT'))
  check("the door's delete function never appears in the sweep's file (auto-deletion cannot re-arm through the sweep)", !read('src/utils/cleanup.ts').includes('operatorPruneTranscripts'))
  // The retention sweep is the one path that unlinks files under the projects
  // store by age — it must never take a transcript: the line that keeps only
  // recordings (.cast) is the exemption, and a .jsonl anywhere in its file
  // filter is the poison the operator's "never auto-deleted" ruling forbids.
  const sweep = read('src/utils/cleanup.ts')
  check("the retention sweep ages only recordings (.cast) — a transcript (.jsonl) is never auto-deleted (operator ruling: never)", /endsWith\('\.cast'\)/.test(sweep) && !/endsWith\('\.jsonl'\)[^\n]*continue/.test(sweep) && !/!entry\.name\.endsWith\('\.jsonl'\) &&/.test(sweep))
  for (const owner of ['src/services/concourse/concourseSnapshot.ts', 'src/components/concourse/ConcourseRoute.tsx', 'src/utils/bootCardFacts.ts', 'src/daemon/idleRetirement.ts', 'src/services/switchboard/sessionReceipts.ts']) {
    check(`${owner} never unlinks anything (the board, the store owner, the reaper and the receipts seam hold no delete door)`, !/unlinkSync\(|rmSync\(|\.unlink\(/.test(read(owner)))
  }
  check('the chord-clear hides only (parkedCleared) — the mark is a view preference; the transcript stays', read('src/services/concourse/concourseSnapshot.ts').includes('parkedCleared') && !/unlinkSync\(|rmSync\(/.test(read('src/services/concourse/concourseSnapshot.ts')))
}

// ── A3: the doors and the still cell, at their source seams ─────────────────
console.log('A3 — ↵ reactivates through the ONE resume door; the close chord clears as a release does; the cell never moves')
{
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  const enterAt = route.indexOf('const attachAndEnter = useCallback(')
  const enterBody = route.slice(enterAt, route.indexOf('const waitingRoomAdmitted = useCallback(', enterAt))
  check('a PARKED row enters through focusResumedSession with the row\'s own transcript (the door Projects-↵ rides)', enterBody.includes("row?.state === 'parked'") && enterBody.includes('hops.focusResumedSession(sessionId, parked.transcriptPath, { title: parked.title })'))
  check('a live row still enters through the hop — the resume door is the parked arm only', /parked !== undefined\s*\?\s*await hops\.focusResumedSession\([\s\S]*?:\s*await hops\.hopIntoBoardSession\(sessionId\)/.test(enterBody))
  check('the reactivation is never a second writer of records (no admit/dispatch op on this road)', !enterBody.includes("op: 'sessionAdmit'") && !enterBody.includes("op: 'sessionDispatch'"))
  check('the route flips to the chat under the yank law after the resume lands', enterBody.indexOf('hops.focusResumedSession(') !== -1 && enterBody.indexOf('enterRootRepl()') > enterBody.indexOf('hops.focusResumedSession('))
  const removeAt = route.indexOf('removeSession: sessionId => {')
  const removeBody = route.slice(removeAt, route.indexOf('openObligation: obligationId => {', removeAt))
  check('the chord-clear on a parked row marks it cleared through the board\'s own store — before any daemon call, no release op (and the release op speaks the session spelling, runnerId not workerId)', removeBody.indexOf("parkedRow?.state === 'parked'") !== -1 && removeBody.indexOf("parkedRow?.state === 'parked'") < removeBody.indexOf('ensureOwnedDaemon()') && removeBody.indexOf('await markParkedCleared(sessionId)') !== -1 && removeBody.indexOf('await markParkedCleared(sessionId)') < removeBody.indexOf("op: 'sessionRelease'") && removeBody.includes("{ op: 'sessionRelease', runnerId: rec.runnerId } as never") && !removeBody.includes("op: 'concourseRelease'"))
  check('a release marks the same way (a removed row never bounces back as parked)', removeBody.includes('await markParkedCleared(sessionId).catch(() => {})') && removeBody.indexOf('await markParkedCleared(sessionId).catch(() => {})') > removeBody.indexOf("op: 'sessionRelease'"))
  check('a parked row is never a survivor for the last-release hop (with no survivor the slot rests and the board stays)', removeBody.includes("r.state !== 'parked',"))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  const chordAt = screen.indexOf('const closeChordGesture = (): void => {')
  const chordBody = screen.slice(chordAt, screen.indexOf('const closeChordRoutineRef', chordAt))
  check('the chord on a parked row: the first completed gesture says nothing runs, the same gesture inside the stage window clears — the release grammar on the new key', chordAt !== -1 && chordBody.indexOf("sel.state === 'parked'") !== -1 && chordBody.indexOf("sel.state === 'parked'") < chordBody.indexOf('callbacks.stopSession?.(sel.sessionId)') && chordBody.includes('Date.now() - prior.at < CLOSE_CHORD_STAGE_WINDOW_MS') && chordBody.includes('callbacks.removeSession?.(sel.sessionId)') && chordBody.includes('nothing to stop'))
  check('plain x carries no board verb any more (the poison the chord retired)', !screen.includes("input === 'x'"))
  check('a parked row subscribes to no work chip (the calm law)', screen.includes("peekSelRow.workspaceDir !== undefined && peekSelRow.state !== 'parked'"))
  const cell = read('src/components/concourse/LiveNowCell.tsx')
  check('the NOW cell\'s live predicate excludes parked rows (no tile subscription, no motion)', cell.includes("const live = row.state === 'working' || row.state === 'needs-you' || row.state === 'starting'"))
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the state spine paints parked as the faint spark, muted, and no other state wears it', layout.includes("parked: { glyph: GLYPH.sparkFaint, color: 'textMuted' }") && layout.split('GLYPH.sparkFaint').length === 2)
  const contracts = read('src/components/concourse/contracts.ts')
  check('the contract admits the state and the group and carries the transcript on the row (parked = the group union\'s LAST member, after elsewhere)', contracts.includes("| 'parked'") && contracts.includes("'stopped' | 'elsewhere' | 'parked'") && contracts.includes('transcriptPath?: string'))
  const builder = read('src/services/concourse/concourseSnapshot.ts')
  check('the builder pushes PARKED after STOPPED (always the last group) and keys it on the door\'s project', builder.indexOf("groups.push({ id: 'stopped', label: 'STOPPED'") !== -1 && builder.indexOf("groups.push({ id: 'parked', label: 'PARKED'") > builder.indexOf("groups.push({ id: 'stopped', label: 'STOPPED'") && builder.includes('const project = opts.project ?? currentProject()') && builder.includes('parkedBoardRows(\n    project.dir,'))
  check('the builder SCOPES the board through the door: live records, held launches and finished forks by inProject over the ORIGIN workspace', builder.includes('allRecords.filter(r => inProject(project, r.workspaceId))') && builder.includes('inProject(project, d.workspaceId)') && builder.includes('inProject(project, e.workspaceId)'))
  check('the counts stay the machine\'s (the seats fraction and the admission pump read them)', builder.includes('const liveAll = allRows.filter('))
  check('the builder lists through the one session-store owner (the catalog door\'s scan and its one husk law — never a second listing)', builder.includes("from '../../utils/bootCardFacts.js'") && builder.includes('parkedSessionsOf(projectDir, {') && builder.includes('isAuthFailureHusk'))
  check('the board re-scopes on the door\'s beat (a ground move, a first chat catalogued)', route.includes('const unsubProject = subscribeCurrentProject(rebuild)') && route.includes('unsubProject()'))
  check('the context label rides the door (the .mercury-parent naming is the catalog\'s seam, untouched here)', builder.includes('const projectLabel = project.name'))
  const owner = read('src/utils/bootCardFacts.ts')
  check('the listing owner shares the scan\'s husk filter and its ≤10 bound', owner.includes('export const PARKED_CAP = 10') && owner.includes('if (isAuthFailureHusk(c.file, c.size)) continue') && owner.includes('export function parkedSessionsOf('))
  const board = read('src/services/concourse/coordinatorBoard.ts')
  check('the coordinator hears a parked row as not running, nothing to send', board.includes("case 'parked':") && board.includes('not running, nothing to send here'))
}

// ── B: the New Session tab ──────────────────────────────────────────────────
console.log('B — the New Session tab: declared, keyed, born in the current ground, absent on the reduced stage')
{
  const { CONCOURSE_CONTROLS, CONCOURSE_REGION_KEYS, regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const tab = CONCOURSE_CONTROLS.find(c => c.id === 'board:new-session')
  check('B1 the tab is a declared control of the list region — n by keyboard, click by pointer', tab !== undefined && tab.region === 'list' && tab.keys.includes('n') && tab.pointer === 'activate' && tab.action === 'concourse:new-session')
  check('B1 the list legend advertises it (a printed key that fires)', CONCOURSE_REGION_KEYS.list.some(k => k.keys === 'n' && k.label === 'new session'))
  check('B1 ↵ keeps enter-session (the tab sits beside the rows, never instead of them)', CONCOURSE_CONTROLS.find(c => c.id === 'board:open')?.keys.includes('return') === true)
  check('B1 the ONE legend resolver drops n exactly when the door is absent (the reduced stage)', regionKeysFor('list', { newSession: false }).every(k => k.keys !== 'n') && regionKeysFor('list', { newSession: true }).some(k => k.keys === 'n') && regionKeysFor('rail', { newSession: false }).length === CONCOURSE_REGION_KEYS.rail.length)
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  const doorAt = route.indexOf('newSession: (opts?: { contractText?: string }) => {')
  const door = route.slice(doorAt, route.indexOf('submitSessionDraft: (text: string) => {', doorAt))
  check('B2 the tab births through THE ONE BIRTH DOOR (bornSession — imported, never re-implemented)', door.includes("import('../../services/switchboard/bornSession.js')") && door.includes('bornSession({ workspaceDir: ground })'))
  check('B2 the birth lands in the CURRENT ground: the resolved harness ground after every pending seed write, never process.cwd() nor a frozen boot cwd', door.indexOf('await seedWriteChain.current') !== -1 && door.indexOf('await seedWriteChain.current') < door.indexOf('await resolveHarnessGround()') && door.indexOf('await resolveHarnessGround()') < door.indexOf('bornSession({') && !door.includes('process.cwd()') && !door.includes('getOriginalCwd'))
  check('B2 no words ride the birth (no dispatch op, no draft consumed)', !door.includes("op: 'sessionDispatch'") && !door.includes('writeConcourseDraft'))
  check("B2 the chat focuses under the yank law; a refusal paints the daemon's own sentence on the tab", door.includes('if (surfaceGeneration() === gen) {') && door.indexOf('bornSession({') !== -1 && door.indexOf('enterRootRepl()') > door.indexOf('bornSession({') && door.includes("noteControl('board:new-session', { state: 'refused', reason: born.reason"))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('B3 the n key fires only in the list region, only with the door wired, never on the reduced stage (and never yields to typing — words need the composer’s own focus)', screen.includes("if (input === 'n' && !key.ctrl && !key.meta && !reducedStage && callbacks.newSession !== undefined && pastGate()) {"))
  check('B3 the screen wires the tab only off the reduced stage (rule 5: live view only) — the tab now ARMS the contract ask, which births through the same door on its answer', screen.includes('...(reducedStage || callbacks.newSession === undefined ? {} : { newSession: () => armContractAsk() })'))
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('B3 the layout paints the tab only with the door wired and derives the legend through the one resolver', layout.includes('wiring.newSession !== undefined ? (') && layout.includes('id="concourse:board:new-session"') && layout.includes('regionKeysFor(region, {') && layout.includes('newSession: wiring.newSession !== undefined,'))
  // The birth lands in the HARNESS GROUND (getCwd — the ground law: seed and
  // cwd move together), never a frozen boot cwd; the model resolves inside
  // the door (birthModelOf).
  check("B3 the boot menu stays the solo road: the face's New Session births through the same door (the model resolves inside the door — birthModelOf)", read('src/components/BootSplashScreen.tsx').includes('bornSession({ workspaceDir: getCwd() })') && !read('src/components/BootSplashScreen.tsx').includes('bornSession({ workspaceDir: process.cwd() })'))
  // The reduced band paints the strip's OWN key-map row (STRIP's ruling B:
  // the live view is not a stop; only the moves that exist print) — the
  // router's pure derivation, re-read on the route beat.
  const { stripKeyMapHintOf } = await import('../../src/context/surfaceRoute.ts')
  check("B4 the reduced band paints the router's key-map hint, re-read on the route beat", screen.includes('const keyMapHint = stripKeyMapHint()') && screen.includes('useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)') && screen.includes('${keyMapHint.length > 0 ? ` · ${keyMapHint}` : \'\'}'))
  check('B4 with the concourse off and no chat, the live view offers the boot face to the left and no chat stop to the right', stripKeyMapHintOf('concourse', ['boot-settings']).startsWith('⇧← boot face') && !stripKeyMapHintOf('concourse', ['boot-settings']).includes('⇧→ chat'))
  check('B4 with a chat present the live view offers both moves', stripKeyMapHintOf('concourse', ['boot-settings', 'repl']) === '⇧← boot face · ⇧→ chat')
  check('B4 the reduced pane notice derives its move from the same hint (the retired literal is gone)', screen.includes('your sessions run and show here · ↵ enters one${keyMapHint.length > 0 ? ` · ${keyMapHint}` : \'\'}') && !screen.includes('⇧← the boot menu'))
  // THE CHAT IS A BRIDGE: esc lands the focused chat while one exists, the
  // boot menu otherwise — the legend, the too-small frame and the atlas say
  // which; the FOCUSED CHAT crumb is a control only while a chat exists.
  const { browseKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  check("B5 the ONE legend resolver relabels esc by chat presence ('focused chat' ↔ 'boot face'), the other keys untouched", browseKeysFor({ chatPresent: true }).find(k => k.keys === 'esc')?.label === 'focused chat' && browseKeysFor({ chatPresent: false }).find(k => k.keys === 'esc')?.label === 'boot face' && browseKeysFor({ chatPresent: false }).filter(k => k.keys !== 'esc').map(k => k.label).join(',') === browseKeysFor({ chatPresent: true }).filter(k => k.keys !== 'esc').map(k => k.label).join(','))
  check('B5 the layout derives its legend and its too-small frame through the resolver, re-read on the route beat', layout.includes('const browseKeys = browseKeysFor({ chatPresent: chat, region })') && layout.includes("browseKeys.find(k => k.keys === 'esc')!") && layout.includes("chat ? 'esc returns to the focused chat' : 'esc returns to the boot face'") && layout.includes('useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)'))
  check('B5 the atlas reads the same resolver', screen.includes("keys: [...browseKeysFor({ chatPresent: chat }), CONCOURSE_HELP_KEY]") && screen.includes('chat={chatPresent()}'))
  const header = read('src/components/concourse/ConcourseHeader.tsx')
  check('B5 the FOCUSED CHAT crumb is a destination only while a chat exists — inert and muted otherwise, full and compact alike', header.includes("chat ? (\n        dest('main-repl', 'FOCUSED CHAT', onMainRepl)\n      ) : (\n        <Text color={t.textMuted}>FOCUSED CHAT</Text>") && header.includes('<Text color={t.textMuted}>FOCUSED CHAT ›</Text>') && header.split('useSyncExternalStore(subscribeSurfaceRoute, surfaceRouteVersion, surfaceRouteVersion)').length === 3)
  // The VERB lands where the legend points —
  // esc's exitToRepl falls through to the boot menu when the home verb
  // refuses on an empty bridge (STRIP's enterRootRepl refuses with no chat;
  // the legend had ruled 'boot menu' while the verb stayed a dead key), on
  // the live route and on the assembling shell alike; the shell's label
  // reads presence too.
  const routeSrc = read('src/components/concourse/ConcourseRoute.tsx')
  check("B5 esc's verb lands where the legend points: the focused chat, else the boot menu directly (the refused home verb falls through — never a dead esc under a 'boot menu' label), on the route and the assembling shell alike", routeSrc.split('if (!enterRootRepl().ok) enterBootSettings()').length === 3)
  check('B5 the assembling shell says where its esc lands by presence', routeSrc.includes("chatPresent() ? 'esc focused chat' : 'esc boot face'"))
}

// ── C: the renames at their owners ──────────────
console.log('C — the renames: the idle knob speaks the session estate; the accent module says the screen; the in-process connector is gone')
{
  // R3: a registered rename with a tolerated legacy spelling — the canonical
  // wins one rung above the legacy; both rows registered (the registry proof's
  // coverage + liveness laws); the reaper reads them in that order.
  const CANON = 'MERCURY_SESSION_IDLE_RETIRE_MINUTES'
  const LEGACY = 'MERCURY_CONCOURSE_IDLE_RETIRE_MINUTES'
  const saved = { canon: process.env[CANON], legacy: process.env[LEGACY] }
  delete process.env[CANON]
  delete process.env[LEGACY]
  const { concourseIdleRetireMs, DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES } = await import('../../src/daemon/idleRetirement.ts')
  const { FLAG_REGISTRY, flagEnv } = await import('../../src/substrate/flagRegistry.ts')
  check('C1 both spellings unset ⇒ the operator\'s ten minutes', concourseIdleRetireMs() === DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES * 60_000 && DEFAULT_CONCOURSE_IDLE_RETIRE_MINUTES === 10)
  process.env[LEGACY] = '5'
  check('C1 the legacy spelling alone still sets the threshold (tolerated, never a silent break)', concourseIdleRetireMs() === 5 * 60_000, String(concourseIdleRetireMs()))
  process.env[CANON] = '7'
  check('C1 the canonical spelling wins one rung above the legacy', concourseIdleRetireMs() === 7 * 60_000, String(concourseIdleRetireMs()))
  delete process.env[LEGACY]
  check('C1 the canonical spelling alone sets it', concourseIdleRetireMs() === 7 * 60_000)
  delete process.env[CANON]
  if (saved.canon !== undefined) process.env[CANON] = saved.canon
  if (saved.legacy !== undefined) process.env[LEGACY] = saved.legacy
  const canonRow = FLAG_REGISTRY.find(f => f.env === CANON)
  const legacyRow = FLAG_REGISTRY.find(f => f.env === LEGACY)
  check('C1 both spellings are REGISTERED rows (the reader throws on neither)', canonRow?.kind === 'value' && legacyRow?.kind === 'value' && flagEnv(CANON) === saved.canon && flagEnv(LEGACY) === saved.legacy)
  check('C1 the legacy row names the canonical, is dated for removal, and reads second', legacyRow !== undefined && legacyRow.summary.includes(CANON) && typeof legacyRow.retirement === 'string' && /REMOVE after 20\d\d-\d\d-\d\d/.test(legacyRow.retirement) && (legacyRow.interactsWith ?? []).includes(CANON))
  const reaper = read('src/daemon/idleRetirement.ts')
  check('C1 the reaper reads canonical-then-legacy through the ONE bounded reader and logs the canonical name', reaper.includes(`flagEnv('${CANON}') ?? flagEnv('${LEGACY}')`) && reaper.includes(`(threshold \${formatLimit(thresholdMs)}, ${CANON})`))
  // R3's sibling (ruled to FOLLOW): the birth-grace knob, minted one day
  // under the concourse name — the same reader pattern, both rows
  // registered, the sibling prover's needles repointed.
  const GRACE = 'MERCURY_SESSION_NEWBORN_GRACE_MINUTES'
  const GRACE_LEGACY = 'MERCURY_CONCOURSE_NEWBORN_GRACE_MINUTES'
  const savedGrace = { canon: process.env[GRACE], legacy: process.env[GRACE_LEGACY] }
  delete process.env[GRACE]
  delete process.env[GRACE_LEGACY]
  const { concourseNewbornGraceMs } = await import('../../src/daemon/idleRetirement.ts')
  check('C1 grace: both spellings unset ⇒ never (0)', concourseNewbornGraceMs() === 0)
  process.env[GRACE_LEGACY] = '30'
  check('C1 grace: the legacy spelling alone still sets the grace', concourseNewbornGraceMs() === 30 * 60_000)
  process.env[GRACE] = '45'
  check('C1 grace: the canonical spelling wins one rung above the legacy', concourseNewbornGraceMs() === 45 * 60_000)
  delete process.env[GRACE]
  delete process.env[GRACE_LEGACY]
  if (savedGrace.canon !== undefined) process.env[GRACE] = savedGrace.canon
  if (savedGrace.legacy !== undefined) process.env[GRACE_LEGACY] = savedGrace.legacy
  const graceRow = FLAG_REGISTRY.find(f => f.env === GRACE)
  const graceLegacyRow = FLAG_REGISTRY.find(f => f.env === GRACE_LEGACY)
  check('C1 grace: both spellings are REGISTERED rows; the legacy names the canonical and is dated', graceRow?.kind === 'value' && graceLegacyRow?.kind === 'value' && graceLegacyRow.summary.includes(GRACE) && typeof graceLegacyRow.retirement === 'string' && /REMOVE after 20\d\d-\d\d-\d\d/.test(graceLegacyRow.retirement))
  check('C1 the knob graph is symmetric: canonical idle ↔ canonical grace, each legacy ↔ its own canonical', (canonRow?.interactsWith ?? []).includes(GRACE) && (graceRow?.interactsWith ?? []).includes(CANON) && (graceRow?.interactsWith ?? []).includes(GRACE_LEGACY) && (graceLegacyRow?.interactsWith ?? []).join(',') === GRACE && (legacyRow?.interactsWith ?? []).join(',') === CANON)
  check('C1 grace: the reaper reads canonical-then-legacy through the ONE bounded reader', reaper.includes(`flagEnv('${GRACE}') ?? flagEnv('${GRACE_LEGACY}')`))
  const sibling = read('scripts/daemon/prove-newborn-grace.ts')
  check('C1 grace: the sibling prover pins the session spelling and tolerates the legacy (its needles repointed)', sibling.includes(`env: '${GRACE}'`) && sibling.includes(`process.env.${GRACE} = '45'`) && sibling.includes(`process.env.${GRACE_LEGACY} = '30'`))
  // R4: the accent module's own words say THE SCREEN's costume
  // (process-lifetime); the exported spellings stay (85 importers — a
  // named sweep, not this lane's).
  const accent = read('src/components/mercury-ui/sessionAccent.ts')
  check('C2 the accent module names itself the SCREEN\'s critter, process-lifetime, never a session\'s', accent.includes("THE SCREEN's critter") && accent.includes('process-lifetime') && accent.includes('a SESSION is the daemon-hosted unit and carries no critter'))
  check('C2 the chat-first phrasing is gone ("Session-only", "the critter session-theme", "the active session critter")', !accent.includes('Session-only') && !accent.includes('critter session-theme') && !accent.includes('The active session critter') && !accent.includes('the live session critter'))
  check('C2 the exported spellings stand (the sweep is named, not smuggled)', accent.includes('export function getSessionAccent(): Critter') && accent.includes('export function useSessionAccent(): Critter'))
  // R5: "the in-process connector" narrated a third implementation; ONEDOOR
  // retired it with the dead transcript organ — this pin keeps it gone.
  const { readdirSync, statSync } = await import('node:fs')
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (/\.(ts|tsx|mjs|js)$/.test(name) && readFileSync(p, 'utf8').includes('in-process connector')) hits.push(p)
    }
  }
  walk(join(process.cwd(), 'src'))
  check('C3 no "in-process connector" spelling survives in src (R5 landed with the dead organ)', hits.length === 0, hits.join(', '))
  check('C3 the dead organ stays dead', !existsSync(join(process.cwd(), 'src/state/transcriptStore.ts')))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-concourse-resume: ALL LAWS HOLD' : `\nprove-concourse-resume: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
