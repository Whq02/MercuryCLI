// ============================================================================
// prove-session-receipts — the closing paper trail's laws (ledger
//  T5–T6). PINS:
//   A  THE FLOOR DERIVES ONLY TRANSCRIPT TRUTHS — every number names its
//      construction: settled non-error edit/write inputs name the files
//      (POISON: an entry naming a file the transcript never touched — an
//      errored Write's path never appears); checks are verbatim settled
//      shell commands with the harness's own ok/failed verdict; the
//      reducer-era tool-settlement envelope is read envelope-side; meta,
//      virtual, compact-summary and api-error rows count nowhere.
//   B  FINISH AND PARK EACH WRITE EXACTLY ONCE — a park-then-reactivate-
//      then-finish life carries one park trail + one settle trail (POISON:
//      doubled entries); a re-park noops; a settle of a still-parked record
//      writes nothing (the park edge already wrote); a second settle noops.
//   C  A RELEASED NEWBORN LEAVES NO ORPHAN TRAIL — born blank, never
//      messaged ⇒ no receipts file is ever born beside no transcript.
//   D  THE TORN-TAIL READ LAW — a partial last line (receipts or
//      transcript) is carried unread, never parsed, never fatal, and the
//      floor discloses its unread count.
//   E  THE VIEWER PAINTS NEWEST-FIRST and the contract-close entry from
//      the seam paints — the append-ordered file reverses at the one view
//      seam; no kind is filtered; the contract lane's append round-trips.
//   F  THE PRUNE TAKES A SESSION'S RECEIPTS WITH ITS TRANSCRIPT — the
//      frozen offer names the sidecar, the confirmed delete takes exactly
//      it (absent tolerated, never failing the row), and a receipts file
//      whose transcript was not offered SURVIVES (POISON: reaching beyond
//      the named set).
//   G  THE SEAM HOLDS NO DELETE DOOR — append/read only, forever.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, appendFileSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'session-receipts-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getProjectDir } = await import('../../src/utils/sessionStorage/paths.ts')
const {
  appendSessionReceipt,
  readSessionReceipts,
  deriveSessionFloor,
  machineFloorDetailsOf,
  receiptsPathBesideTranscript,
} = await import('../../src/services/switchboard/sessionReceipts.ts')
const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
const { buildPruneOffer, operatorPruneTranscripts } = await import('../../src/utils/sessionStorage/transcriptPruneDoor.ts')

const DAEMON_DIR = join(SCRATCH, 'daemon')
mkdirSync(DAEMON_DIR, { recursive: true })
const WS = join(SCRATCH, 'ws')
mkdirSync(WS, { recursive: true })
const sid = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`

// ── the seeded transcript: every truth the floor may claim, and the traps ───
const T = (m: number): string => new Date(Date.UTC(2026, 7, 28, 10, m)).toISOString()
function writeTranscript(sessionId: string): string {
  const home = getProjectDir(WS)
  mkdirSync(home, { recursive: true })
  const lines: unknown[] = [
    { type: 'user', uuid: 'u1', timestamp: T(0), sessionId, message: { role: 'user', content: 'do the work' } },
    { type: 'assistant', uuid: 'a1', timestamp: T(1), sessionId, message: { content: [
      { type: 'text', text: 'starting' },
      { type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: join(WS, 'a.ts'), old_string: 'x', new_string: 'y' } },
    ] } },
    { type: 'user', uuid: 'u2', timestamp: T(2), sessionId, sourceToolUseID: 'tu-edit', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-edit', content: 'ok' },
    ] } },
    { type: 'assistant', uuid: 'a2', timestamp: T(3), sessionId, message: { content: [
      { type: 'tool_use', id: 'tu-write', name: 'Write', input: { file_path: join(WS, 'b.ts'), content: 'zz' } },
    ] } },
    // The POISON seed: the Write ERRORED — its path must never be certified.
    { type: 'user', uuid: 'u3', timestamp: T(4), sessionId, sourceToolUseID: 'tu-write', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-write', content: 'permission denied', is_error: true },
    ] } },
    { type: 'assistant', uuid: 'a3', timestamp: T(5), sessionId, message: { content: [
      { type: 'tool_use', id: 'tu-check1', name: 'Bash', input: { command: 'bun run typecheck' } },
    ] } },
    { type: 'user', uuid: 'u4', timestamp: T(6), sessionId, sourceToolUseID: 'tu-check1', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-check1', content: 'green' },
    ] } },
    { type: 'assistant', uuid: 'a4', timestamp: T(7), sessionId, message: { content: [
      { type: 'tool_use', id: 'tu-check2', name: 'Bash', input: { command: 'bun run verify' } },
    ] } },
    { type: 'user', uuid: 'u5', timestamp: T(8), sessionId, sourceToolUseID: 'tu-check2', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-check2', content: 'suite red', is_error: true },
    ] } },
    { type: 'assistant', uuid: 'a5', timestamp: T(9), sessionId, message: { content: [
      { type: 'tool_use', id: 'tu-commit', name: 'Bash', input: { command: "git commit -m 'landed'" } },
    ] } },
    { type: 'user', uuid: 'u6', timestamp: T(10), sessionId, sourceToolUseID: 'tu-commit', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-commit', content: '[main abc1234] landed' },
    ] } },
    // The durable era: a MercuryRecord envelope output + its reducer-era
    // tool-settlement — the dual-read must count both envelope-side.
    { schemaVersion: 1, recordId: 'r-env-1', sessionId, threadId: 't-1', creationOrdinal: 12, updateOrdinal: 12, occurredAt: T(11), actor: { role: 'assistant', model: 'm' }, source: { channel: 'sdk' }, annotations: { uuid: 'a-env', timestamp: T(11) }, payload: { kind: 'output', model: 'm', content: [
      { kind: 'tool-use', callId: 'tu-nb', name: 'NotebookEdit', input: { notebook_path: join(WS, 'nb.ipynb') } },
    ], usage: {}, outcome: { result: 'completed' } } },
    { schemaVersion: 1, recordId: 'r-env-2', sessionId, threadId: 't-1', creationOrdinal: 13, updateOrdinal: 13, occurredAt: T(12), actor: { role: 'system' }, source: { channel: 'sdk' }, payload: { kind: 'tool-settlement', callId: 'tu-nb', outcome: 'ok', result: 'edited' } },
    // Counts-nowhere rows: meta, compact summary, session meta.
    { type: 'user', uuid: 'u7', timestamp: T(13), sessionId, isMeta: true, message: { role: 'user', content: 'caveat' } },
    { type: 'user', uuid: 'u8', timestamp: T(14), sessionId, isCompactSummary: true, message: { role: 'user', content: 'summary of it all' } },
    { type: 'custom-title', customTitle: 'the work', sessionId },
    { type: 'user', uuid: 'u9', timestamp: T(15), sessionId, message: { role: 'user', content: 'ship it' } },
    { type: 'assistant', uuid: 'a9', timestamp: T(16), sessionId, message: { content: [
      { type: 'text', text: 'All landed. The edit is in and typecheck is green.' },
    ] } },
    // A LATER api-error notice must neither count nor become the close.
    { type: 'assistant', uuid: 'a10', timestamp: T(17), sessionId, isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'boom' }] } },
  ]
  const path = join(home, `${sessionId}.jsonl`)
  writeFileSync(path, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
  return path
}

// ── A: the floor derives only transcript truths ─────────────────────────────
console.log('A — the machine floor is true by construction over a known transcript')
{
  const S = sid('a01')
  writeTranscript(S)
  const walked = deriveSessionFloor(getProjectDir(WS), S, 'settle')
  check('a transcript walks (the derivation answers)', walked !== null)
  if (walked !== null) {
    const f = walked.floor
    check('turns count NON-META prompts and replies only (2 prompts · 7 replies)', f.turns.user === 2 && f.turns.assistant === 7, JSON.stringify(f.turns))
    check('tool families from the tools\' own names (2 edits · 1 write · 3 shell · 0 other)', f.toolCalls.edits === 2 && f.toolCalls.writes === 1 && f.toolCalls.shell === 3 && f.toolCalls.other === 0 && f.toolCalls.total === 6, JSON.stringify(f.toolCalls))
    check('files touched = settled NON-ERROR edit/write inputs, in first-touch order (a.ts then the envelope notebook)', f.filesTouched.length === 2 && f.filesTouched[0] === join(WS, 'a.ts') && f.filesTouched[1] === join(WS, 'nb.ipynb'), JSON.stringify(f.filesTouched))
    check('POISON: the errored Write\'s path is NOT certified (no file the transcript never touched)', !f.filesTouched.includes(join(WS, 'b.ts')))
    check('checks are verbatim settled commands with the harness\'s own verdict (typecheck ok · verify failed)', f.checks.length === 2 && f.checks[0]!.command === 'bun run typecheck' && f.checks[0]!.ok === true && f.checks[1]!.command === 'bun run verify' && f.checks[1]!.ok === false, JSON.stringify(f.checks))
    check('gitCommitCalls counts exactly the settled-ok `git commit` shell calls (1)', f.gitCommitCalls === 1, String(f.gitCommitCalls))
    check('duration spans first→last REAL conversation timestamps (the api-error row moves nothing)', f.firstAt === T(0) && f.lastAt === T(16) && f.spanMs === Date.parse(T(16)) - Date.parse(T(0)), `${f.firstAt} → ${f.lastAt}`)
    check('the envelope era read through the ONE codec (the NotebookEdit call and its reducer-era settlement both counted)', f.filesTouched.includes(join(WS, 'nb.ipynb')))
    check('the agent\'s own close is the final REAL assistant text (never the later api-error notice)', walked.finalAssistant?.text === 'All landed. The edit is in and typecheck is green.', walked.finalAssistant?.text ?? '(absent)')
  }
}

// ── B: finish and park each write exactly once ──────────────────────────────
console.log('B — one park trail, one settle trail, never doubled, never both for one close')
{
  const S = sid('b01')
  const RUNNER = 'concourse-w1'
  writeTranscript(S)
  supervisor.updateConcourseWorkers(w => {
    w[RUNNER] = {
      schema: 1, runnerId: RUNNER, sessionId: S, workspaceId: WS, isolation: 'exclusive',
      modelKey: 'test-model', agentName: 'tester', spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now(),
      lastDeliveryAt: Date.now() - 30_000, lastTurnSettledAt: Date.now() - 20_000,
    }
  }, DAEMON_DIR)
  const park = supervisor.parkConcourseSession(S, 'operator:test', undefined, DAEMON_DIR)
  check('the park applies (dead runner parks at once)', park.outcome === 'applied' && park.released === false, JSON.stringify(park))
  let entries = readSessionReceipts(getProjectDir(WS), S)
  check('the park seam wrote exactly its trail: machine-floor + agent-close', entries.length === 2 && entries[0]!.kind === 'machine-floor' && entries[1]!.kind === 'agent-close', entries.map(e => e.kind).join(','))
  check('the park floor says park, and its by is the daemon; the close carries the agent\'s name', machineFloorDetailsOf(entries[0]!)?.closedBy === 'park' && entries[0]!.by === 'daemon' && entries[1]!.by === 'tester')
  const rePark = supervisor.parkConcourseSession(S, 'operator:test', undefined, DAEMON_DIR)
  check('POISON: a re-park noops and writes nothing (still 2 entries)', rePark.outcome === 'noop' && readSessionReceipts(getProjectDir(WS), S).length === 2)
  // The reactivate's one publication (the estate's own contract: parkedAt
  // clears; the session then runs more turns).
  supervisor.updateConcourseWorkers(w => {
    const rec = w[RUNNER]!
    delete rec.parkedAt
    delete rec.parkedBy
    delete rec.parkReason
  }, DAEMON_DIR)
  supervisor.markConcourseWorkerDelivery(RUNNER, DAEMON_DIR)
  supervisor.markConcourseWorkerTurnSettled(RUNNER, DAEMON_DIR)
  const settled = supervisor.settleConcourseWorker(RUNNER, DAEMON_DIR)
  entries = readSessionReceipts(getProjectDir(WS), S)
  check('the finish seam wrote its own trail after the reactivate (4 entries: park pair + settle pair)', settled && entries.length === 4, String(entries.length))
  check('the newest floor says settle (the park floor stands beneath it)', machineFloorDetailsOf(entries[2]!)?.closedBy === 'settle' && machineFloorDetailsOf(entries[0]!)?.closedBy === 'park')
  const settledAgain = supervisor.settleConcourseWorker(RUNNER, DAEMON_DIR)
  check('POISON: a second settle noops and writes nothing (the endedAt guard holds the trail at 4)', settledAgain === false && readSessionReceipts(getProjectDir(WS), S).length === 4)
}
{
  const S = sid('b02')
  const RUNNER = 'concourse-w2'
  writeTranscript(S)
  supervisor.updateConcourseWorkers(w => {
    w[RUNNER] = {
      schema: 1, runnerId: RUNNER, sessionId: S, workspaceId: WS, isolation: 'exclusive',
      modelKey: 'test-model', spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now(),
      lastDeliveryAt: Date.now() - 30_000, lastTurnSettledAt: Date.now() - 20_000,
    }
  }, DAEMON_DIR)
  supervisor.parkConcourseSession(S, 'operator:test', undefined, DAEMON_DIR)
  const afterPark = readSessionReceipts(getProjectDir(WS), S).length
  supervisor.settleConcourseWorker(RUNNER, DAEMON_DIR)
  check('POISON: the x-x release of a STILL-PARKED record writes nothing new (the park edge already wrote; nothing ran since)', afterPark === 2 && readSessionReceipts(getProjectDir(WS), S).length === 2, String(readSessionReceipts(getProjectDir(WS), S).length))
  check('the agent-close by falls to \'session\' when the record names no agent', readSessionReceipts(getProjectDir(WS), S)[1]!.by === 'session')
}

// ── C: a released newborn leaves no orphan trail ────────────────────────────
console.log('C — born blank and never messaged ⇒ no receipts file is ever born')
{
  const S = sid('c01')
  const RUNNER = 'concourse-w3'
  supervisor.updateConcourseWorkers(w => {
    w[RUNNER] = {
      schema: 1, runnerId: RUNNER, sessionId: S, workspaceId: WS, isolation: 'exclusive',
      modelKey: 'test-model', spawnedAt: Date.now() - 60_000, lastLiveAt: Date.now(),
      bornBlankAt: Date.now() - 60_000,
    }
  }, DAEMON_DIR)
  const park = supervisor.parkConcourseSession(S, 'operator:test', undefined, DAEMON_DIR)
  check('the newborn is RELEASED, not parked (one-door\'s rule kept)', park.outcome === 'applied' && park.released === true, JSON.stringify(park))
  check('POISON: no orphan receipts file beside no transcript', !existsSync(join(getProjectDir(WS), `${S}.receipts.jsonl`)))
}

// ── D: the torn-tail read law ───────────────────────────────────────────────
console.log('D — a torn tail is carried unread, never parsed, never fatal')
{
  // b02's trail (2 entries) takes the torn tail — b01 stays clean for E's
  // append (a torn tail would swallow a later append into one mixed line).
  const S = sid('b02')
  const receiptsPath = join(getProjectDir(WS), `${S}.receipts.jsonl`)
  appendFileSync(receiptsPath, '{"at":"2026-08-28T10:00:00.000Z","ki')
  const entries = readSessionReceipts(getProjectDir(WS), S)
  check('the receipts read returns every whole entry and skips the torn tail without throwing', entries.length === 2)
  const S2 = sid('d01')
  writeTranscript(S2)
  appendFileSync(join(getProjectDir(WS), `${S2}.jsonl`), '{"type":"assistant","uuid":"torn"')
  const walked = deriveSessionFloor(getProjectDir(WS), S2, 'park')
  check('the floor derives over a torn transcript and DISCLOSES the unread line', walked !== null && walked.floor.unreadLines === 1, String(walked?.floor.unreadLines))
}

// ── E: the viewer paints newest-first; the contract-close entry paints ──────
console.log('E — newest-first at the one view seam; the contract lane\'s append round-trips')
{
  const mirror = readSrc('src/components/concourse/SessionMirror.tsx')
  check('the viewer reverses the append-ordered file (newest-first) at its one read seam', mirror.includes('.slice().reverse()') && mirror.includes('Newest-first: the file is append-ordered; the viewer reverses'))
  check('the section derives its rows from the pane it was given (a third, cap 6, the 2-row minimum) and exists only over entries that exist', mirror.includes('Math.min(6, Math.floor(paneRows / 3))') && mirror.includes('if (entryCount === 0) return null'))
  check('the deep close row pre-clips to two width-true rows (the wrap can never push a third into the frame)', mirror.includes('truncateToWidth(text, Math.max(16, paneWidth * 2 - 2))'))
  check('every kind paints — floor, close, and the contract estate\'s close-against', mirror.includes("`floor: ${flat}`") && mirror.includes("`close (${e.by}): ${flat}`") && mirror.includes("`contract: ${flat}`"))
  const S = sid('b01')
  appendSessionReceipt(getProjectDir(WS), S, { at: new Date().toISOString(), by: 'coordinator', kind: 'contract-close', summary: 'delivered against the contract: 3 items closed' })
  const entries = readSessionReceipts(getProjectDir(WS), S)
  check('the contract-close entry from the seam round-trips whole (the frozen append door)', entries.length === 5 && entries[4]!.kind === 'contract-close' && entries[4]!.summary.includes('3 items closed'))
}

// ── F: the prune takes a session's receipts WITH its transcript ─────────────
console.log('F — the frozen offer names the sidecar; the confirmed delete takes exactly it')
{
  const P = join(HOME, 'projects', 'prune-estate')
  mkdirSync(P, { recursive: true })
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
  const t1 = join(P, `${sid('f01')}.jsonl`)
  writeFileSync(t1, '{"type":"user"}\n')
  writeFileSync(receiptsPathBesideTranscript(t1), '{"kind":"machine-floor"}\n')
  const t2 = join(P, `${sid('f02')}.jsonl`)
  writeFileSync(t2, '{"type":"user"}\n')
  const survivor = join(P, `${sid('f03')}.receipts.jsonl`)
  writeFileSync(survivor, '{"kind":"machine-floor"}\n')
  for (const f of [t1, receiptsPathBesideTranscript(t1), t2, survivor]) utimesSync(f, old, old)
  const offer = buildPruneOffer(
    [
      { sessionId: sid('f01'), fullPath: t1, fileSize: 16, modified: old },
      { sessionId: sid('f02'), fullPath: t2, fileSize: 16, modified: old },
    ],
    { scopeLabel: 'this project', windowDays: 30 },
  )
  check('the frozen offer names each transcript\'s sidecar through the seam\'s one spelling', offer.candidates.length === 2 && offer.candidates.every(c => c.receiptsPath === receiptsPathBesideTranscript(c.transcriptPath)))
  const receipt = await operatorPruneTranscripts(offer)
  check('the confirmed delete takes the transcript AND its receipts (absent sidecar tolerated, never a failed row)', receipt.deleted === 2 && receipt.failed === 0 && receipt.receiptsDeleted === 1, JSON.stringify(receipt))
  check('both named files are gone; the offered no-sidecar row simply had none', !existsSync(t1) && !existsSync(receiptsPathBesideTranscript(t1)) && !existsSync(t2))
  check('POISON: a receipts file whose transcript was NOT offered SURVIVES (the door never reaches beyond the named set)', existsSync(survivor))
}

// ── G: the seam holds no delete door ────────────────────────────────────────
console.log('G — the receipts seam is append/read only, forever')
{
  const seam = readSrc('src/services/switchboard/sessionReceipts.ts')
  check('no unlink/rm anywhere in the seam module (retention rides the transcript\'s law)', !/unlinkSync\(|rmSync\(|\.unlink\(|rimraf/.test(seam))
  check('the finish seam is the settle\'s one writer and the park stamp is the other (no second finish detector)', (readSrc('src/daemon/concourseSupervisor.ts').match(/writeSessionCloseReceipts\(/g) ?? []).length === 2)
}

console.log(failures === 0 ? 'prove-session-receipts: ALL PASS' : `prove-session-receipts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
