#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-status-prune.ts — THE RETENTION NUMBERS AND THE
// ONE PRUNE DOOR (the operator's L11 later parcel). The
//  ruled ground: transcripts (.jsonl) are NEVER auto-deleted — the retention
//  sweep ages only recordings (.cast); deleting a transcript is the
//  operator's own pressed act behind the /sessions confirmation card, and
//  that card's confirmed Yes is the ONE caller of the ONE door. The pins are
//  the rule read back off the tree — executed units over the REAL owners
//  (the census functions, the pure offer builder, the real door, the real
//  sweep) in a scratch estate, plus source seams for the surfaces — no boot.
//
//   A  THE NUMBERS DERIVE FROM THE OWNERS: transcriptCensus (the session
//      store's enumerator — UUID .jsonl only) and recordingsUnderSweep (the
//      sweep's own file) return the seeded estate's exact counts, bytes and
//      oldest age; the /status wrapper reads THESE owners and counts nothing
//      itself; the window has ONE owner (retentionWindowDays) and the
//      sweep's cutoff derives from it. The poison is a second counter.
//   B  THE DOOR DELETES ONLY THE CARD'S NAMED SET: the frozen offer holds
//      exactly the aged rows — never the active session, never a live
//      (board-homed) record, never a young chat — and the door unlinks
//      exactly the offer, one file each: a vanished candidate counts failed
//      (never re-resolved), every file outside the set survives, and the
//      receipt's numbers are exact. THE FREEZE LAW (lead-ratified): the
//      offer never rebuilds at Yes — a chat born, or aged past the window,
//      between the card and the Yes is never in it. The poison is a delete
//      outside the confirmed scope, the freeze-window cases included.
//   C  NO/ESC DELETE NOTHING (source seams): the card opens answered No,
//      esc / n leave without the door, the one runPrune call sits behind
//      the highlighted-Yes gate, nothing about the answer is remembered,
//      and the key is named in the /sessions footer.
//   D  THE SWEEP STILL NEVER TOUCHES .jsonl: the REAL sweep over the
//      scratch estate takes exactly the aged recordings and not one
//      transcript — the aged transcript survives by name and the census
//      counts are unmoved. The poison is the door's function appearing in
//      the sweep's path.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'status-prune-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
// Every store this prover reads or sweeps lives in the scratch home.
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getProjectsDir } = await import('../../src/utils/sessionStorage/paths.ts')
const { transcriptCensus } = await import('../../src/utils/sessionStorage/logs.ts')
const { cleanupOldSessionFiles, recordingsUnderSweep, retentionWindowDays } = await import('../../src/utils/cleanup.ts')
const { buildPruneOffer, operatorPruneTranscripts } = await import('../../src/utils/sessionStorage/transcriptPruneDoor.ts')

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
const projectsRoot = getProjectsDir()

/** A valid-UUID session id with a readable tail. */
const sid = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`
/** Seed one file of exactly `bytes` bytes, aged `days` back from NOW. */
function seedFile(dir: string, name: string, bytes: number, days: number): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, 'x'.repeat(bytes))
  const t = new Date(NOW - days * DAY)
  utimesSync(file, t, t)
  return file
}

// ── A: the numbers derive from the owners ───────────────────────────────────
console.log('A — the retention numbers come from the estate\'s own owners, exact over a known estate')
{
  const P_A = join(projectsRoot, 'proj-a')
  const P_B = join(projectsRoot, 'proj-b')
  seedFile(P_A, `${sid('a1')}.jsonl`, 120, 10)
  seedFile(P_A, `${sid('a2')}.jsonl`, 80, 0)
  seedFile(P_A, 'young.cast', 50, 0)
  seedFile(P_A, 'notes.jsonl', 999, 5) // not a UUID — not a session transcript
  seedFile(P_A, 'stray.txt', 11, 500)
  const oldestFile = seedFile(P_B, `${sid('b1')}.jsonl`, 200, 400)
  seedFile(P_B, 'aged.cast', 70, 90)
  seedFile(projectsRoot, 'rootfile.cast', 33, 90) // at the root, not in a project dir

  const t = await transcriptCensus()
  check('transcriptCensus counts every UUID transcript and only those (3, the non-UUID .jsonl excluded)', t.count === 3, String(t.count))
  check('…with their exact disk weight (120+80+200)', t.bytes === 400, String(t.bytes))
  check("…and the oldest's own mtime (the 400-day file, stat-exact)", t.oldestMtimeMs === statSync(oldestFile).mtime.getTime(), String(t.oldestMtimeMs))
  const r = await recordingsUnderSweep()
  check('recordingsUnderSweep counts the .cast files in project dirs and only those (2 — root strays and .txt excluded)', r.count === 2, String(r.count))
  check('…with their exact bytes (50+70)', r.bytes === 120, String(r.bytes))
  check('the window has ONE owner and defaults honest (30 days in a bare home)', retentionWindowDays() === 30, String(retentionWindowDays()))
  check("the sweep's cutoff DERIVES from the one window owner (no second derivation in cleanup.ts)", /Date\.now\(\) - retentionWindowDays\(\)/.test(read('src/utils/cleanup.ts')))

  const status = read('src/commands/status/mercuryStatus.tsx')
  check('/status reads THESE owners (transcriptCensus · recordingsUnderSweep · retentionWindowDays imported)', status.includes('transcriptCensus') && status.includes('recordingsUnderSweep') && status.includes('retentionWindowDays'))
  check('POISON: /status is never a second counter (no directory read of its own)', !/readdir/i.test(status))
  check("/status speaks the law's words for transcripts (kept for good)", status.includes('kept for good'))
  const view = read('src/components/mercury-ui/screens/SettingsStatusView.tsx')
  check('the retention block paints on the ONE status surface (its own header, no second surface, no fs in the view)', view.includes('>Retention</SectionHeader>') && !view.includes('node:fs'))
}

// ── B: the door deletes ONLY the card's named set ───────────────────────────
console.log("B — the frozen offer is the honest set; the door unlinks exactly it and nothing else")
{
  const P_DOOR = join(projectsRoot, 'proj-door')
  const LIVE = sid('11'), ACTIVE = sid('22')
  const t1 = seedFile(P_DOOR, `${sid('f1')}.jsonl`, 100, 90)
  const t2 = seedFile(P_DOOR, `${sid('f2')}.jsonl`, 200, 60)
  const t3 = seedFile(P_DOOR, `${sid('f3')}.jsonl`, 300, 45)
  const t4 = seedFile(P_DOOR, `${sid('f4')}.jsonl`, 400, 0)
  const t5 = seedFile(P_DOOR, `${LIVE}.jsonl`, 500, 90)
  const t6 = seedFile(P_DOOR, `${ACTIVE}.jsonl`, 600, 90)
  const decoyCast = seedFile(P_DOOR, 'decoy.cast', 90, 90)
  const rowOf = (file: string, id: string): { sessionId: string; fullPath: string; fileSize: number; modified: Date } => ({
    sessionId: id, fullPath: file, fileSize: statSync(file).size, modified: statSync(file).mtime,
  })
  const rows = [rowOf(t1, sid('f1')), rowOf(t2, sid('f2')), rowOf(t3, sid('f3')), rowOf(t4, sid('f4')), rowOf(t5, LIVE), rowOf(t6, ACTIVE)]
  const offer = buildPruneOffer(rows, {
    scopeLabel: "this project's listed chats",
    windowDays: 30,
    now: new Date(NOW),
    activeSessionId: ACTIVE,
    liveSessionIds: new Set([LIVE]),
  })
  check('the offer is exactly the aged, non-live, non-active rows (t1 t2 t3), oldest first', offer.candidates.map(c => c.sessionId).join(',') === [sid('f1'), sid('f2'), sid('f3')].join(','), offer.candidates.map(c => c.sessionId).join(','))
  check("a LIVE record's transcript is never in the offered set (the builder's own fence, whatever rows arrive)", !offer.candidates.some(c => c.sessionId === LIVE))
  check('the active session is never in the offered set', !offer.candidates.some(c => c.sessionId === ACTIVE))
  check('a young chat is never in the offered set (the window is the fence)', !offer.candidates.some(c => c.sessionId === sid('f4')))
  check('the card\'s numbers are exact: count 3 · total 600 bytes · age range oldest→newest', offer.candidates.length === 3 && offer.totalBytes === 600 && offer.oldestModified?.getTime() === statSync(t1).mtime.getTime() && offer.newestModified?.getTime() === offer.candidates[2]?.modified.getTime())
  check('a young-only estate offers NOTHING (empty offer, null range)', (() => { const o = buildPruneOffer([rowOf(t4, sid('f4'))], { scopeLabel: 's', windowDays: 30, now: new Date(NOW) }); return o.candidates.length === 0 && o.totalBytes === 0 && o.oldestModified === null && o.newestModified === null })())

  // THE FREEZE LAW (lead-ratified at the ACK): Yes deletes exactly the
  // frozen set — the offer never rebuilds at Yes. Inside the card-to-Yes
  // gap a new aged transcript is BORN and the young chat AGES past the
  // window; the door must leave both standing.
  const born = seedFile(P_DOOR, `${sid('b0')}.jsonl`, 150, 90)
  utimesSync(t4, new Date(NOW - 90 * DAY), new Date(NOW - 90 * DAY))

  // One candidate vanishes between the card and the Yes — the door must
  // count it failed, never re-resolve it onto another file.
  unlinkSync(t3)
  const receipt = await operatorPruneTranscripts(offer)
  check('the door deleted exactly the named set that still stood (t1 t2), receipt exact (2 deleted · 300 bytes freed)', receipt.deleted === 2 && receipt.bytesFreed === 300 && receipt.deletedSessionIds.join(',') === [sid('f1'), sid('f2')].join(','), JSON.stringify(receipt))
  check('the vanished candidate counts FAILED, honestly', receipt.failed === 1)
  check('the receipt stamps its when', receipt.at instanceof Date && Math.abs(receipt.at.getTime() - Date.now()) < 60_000)
  check('POISON: nothing outside the confirmed scope was deleted — the young, the live, the active and the recording all stand', !existsSync(t1) && !existsSync(t2) && existsSync(t4) && existsSync(t5) && existsSync(t6) && existsSync(decoyCast))
  check('POISON (the freeze law): a chat born after the card, or aged past the window inside the gap, is never deleted — the offer never rebuilds at Yes', existsSync(born) && existsSync(t4))
  check('POISON: the door reached into no other project (the census estate stands whole)', existsSync(join(projectsRoot, 'proj-a', `${sid('a1')}.jsonl`)) && existsSync(join(projectsRoot, 'proj-b', `${sid('b1')}.jsonl`)))

  // THE NAMED CALLERS (widened, lead-ruled — an
  // exemption-with-teeth over the original one-caller census, WHY
  // unchanged): across src/, the door's function is called from exactly the
  // TWO operator-pressed cards — the /sessions view and the Boot face's
  // resume screen; the only other occurrence is the door's own definition.
  // A third caller — the sweep, the picker core, anything — still reds.
  const { readdirSync } = await import('node:fs')
  const callers: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name)
      if (name.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name.name) && readFileSync(p, 'utf8').includes('operatorPruneTranscripts(')) callers.push(p)
    }
  }
  walk(join(process.cwd(), 'src'))
  const expected = [
    join(process.cwd(), 'src/components/BootResumeScreen.tsx'),
    join(process.cwd(), 'src/components/mercury-ui/screens/SessionManagerView.tsx'),
    join(process.cwd(), 'src/utils/sessionStorage/transcriptPruneDoor.ts'),
  ].sort()
  check('the door has exactly its TWO named cards as callers (plus its own definition, nothing else)', callers.sort().join('|') === expected.join('|'), callers.join(', '))
  // The picker core the two skins share can NEVER reach the door — its
  // dropSessions is a list-state mirror only (the Option-A edge).
  const core = read('src/components/mercury-ui/screens/sessionPickerModel.ts')
  check('the shared picker core reaches no delete road (neither the function nor the module)', !core.includes('operatorPruneTranscripts') && !core.includes('transcriptPruneDoor'))
}

// ── C: No and esc delete nothing; the door is pressed, named, unremembered ──
console.log('C — the card opens answered No; esc/n leave without the door; the key is named; nothing is remembered')
{
  const view = read('src/components/mercury-ui/screens/SessionManagerView.tsx')
  check('the card opens answered No (the frozen offer arms nothing)', view.includes("setPrune({ stage: 'card', offer, answer: 'no' })"))
  const branchStart = view.indexOf('if (prune !== null) {')
  const branchEnd = view.indexOf('// Confirm gate', branchStart)
  const pruneBranch = branchStart >= 0 && branchEnd > branchStart ? view.slice(branchStart, branchEnd) : ''
  check('esc / n answer No before any commit road (the cancel line leads the branch)', pruneBranch.includes("if (key.escape || input === 'n')") && pruneBranch.indexOf("if (key.escape || input === 'n')") < pruneBranch.indexOf('runPrune'))
  check('the ONE commit road is the highlighted Yes over a non-empty offer', pruneBranch.includes("if (prune.answer === 'yes' && prune.offer.candidates.length > 0) {") && pruneBranch.includes('void runPrune(prune.offer)'))
  check('runPrune has exactly one call site (the gated Yes) beside its definition', view.split('runPrune(').length === 3)
  // Needle healed: the landed spelling
  // grew the ctrl/meta guard after this pin was written.
  check('the door is operator-PRESSED: d opens it from the list and the footer names it in the key-map row', view.includes("if (input === 'd' && !key.ctrl && !key.meta) {") && view.includes('d prune'))
  check('the answer is never remembered (no settings write anywhere near the door)', !view.includes('saveGlobalConfig') && !view.includes('savedSettings'))
  check("the receipt is typed and says whose act it was (count · bytes · when · by the operator)", view.includes('by the operator') && view.includes('prune.receipt.deleted') && view.includes('formatFileSize(prune.receipt.bytesFreed)'))

  // THE FACE CARD (caller #2) carries the SAME grammar, pinned with the
  // SAME needles (the Option-A card-parity edge): frozen offer at open,
  // opens answered No, esc/n lead the branch, one commit road, the typed
  // receipt vocabulary, d as the pressed door, list parked while open.
  const face = read('src/components/BootResumeScreen.tsx')
  check('face: the card opens answered No (the frozen offer arms nothing)', face.includes("setPrune({ stage: 'card', offer, answer: 'no' })"))
  const fBranchStart = face.indexOf('if (prune === null) return')
  const fBranchEnd = face.indexOf("{ isActive: prune !== null }", fBranchStart)
  const fBranch = fBranchStart >= 0 && fBranchEnd > fBranchStart ? face.slice(fBranchStart, fBranchEnd) : ''
  check('face: esc / n answer No before any commit road (the cancel line leads the branch)', fBranch.includes("if (key.escape || input === 'n')") && fBranch.indexOf("if (key.escape || input === 'n')") < fBranch.indexOf('runPrune'))
  check('face: the ONE commit road is the highlighted Yes over a non-empty offer', fBranch.includes("if (prune.answer === 'yes' && prune.offer.candidates.length > 0) {") && fBranch.includes('void runPrune(prune.offer)'))
  check('face: runPrune has exactly one call site (the gated Yes) beside its definition', face.split('runPrune(').length === 3)
  check('face: d is the pressed door and the legend names it', face.includes("key: 'd'") && face.includes('d prune'))
  check('face: the offer freezes from the SESSION rows alone (crew transcripts are never offered)', face.includes('flat.map(f => f.row.log)'))
  check('face: the answer is never remembered', !face.includes('saveGlobalConfig') && !face.includes('savedSettings'))
  check("face: the receipt speaks the same vocabulary (the operator's own act · by the operator · still listed)", face.includes("pruned · the operator's own act") && face.includes('by the operator') && face.includes('could not be deleted — still listed'))
  check('face: the card speaks the same consent vocabulary (keep everything · delete exactly this set · never remembered)', face.includes('No — keep everything (default)') && face.includes('Yes — delete exactly this set, for good') && face.includes('asked every time, never remembered'))
  check('face: the mirror rides the model door, never a local list write', face.includes('dropSessions(new Set(receipt.deletedSessionIds))'))
}

// ── D: the sweep still never touches .jsonl ─────────────────────────────────
console.log('D — the REAL sweep over the scratch estate: aged recordings go, no transcript moves')
{
  const preT = await transcriptCensus()
  const preR = await recordingsUnderSweep()
  const result = await cleanupOldSessionFiles()
  const postT = await transcriptCensus()
  const postR = await recordingsUnderSweep()
  check('the sweep took exactly the aged recordings (2: the 90-day .cast pair), zero errors', result.messages === 2 && result.errors === 0, JSON.stringify(result))
  check('not one transcript moved: the census counts are unmoved across the sweep (kept for good, executed)', postT.count === preT.count && postT.bytes === preT.bytes, `${preT.count}→${postT.count}`)
  check('the aged transcript survives the sweep BY NAME (90 days old and still standing)', existsSync(join(projectsRoot, 'proj-door', `${sid('11')}.jsonl`)))
  check('the young recording survives; the recordings census dropped by exactly the swept pair', postR.count === preR.count - 2 && postR.count === 1, `${preR.count}→${postR.count}`)
  const sweep = read('src/utils/cleanup.ts')
  check("the sweep's file filter keeps only recordings (.cast) — a transcript filter is the poison", /endsWith\('\.cast'\)/.test(sweep) && !/endsWith\('\.jsonl'\)[^\n]*continue/.test(sweep) && !/!entry\.name\.endsWith\('\.jsonl'\) &&/.test(sweep))
  check("POISON: the door's function appears nowhere in the sweep's path (auto-deletion cannot re-arm)", !sweep.includes('operatorPruneTranscripts') && !sweep.includes('transcriptPruneDoor'))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-status-prune: ALL LAWS HOLD' : `\nprove-status-prune: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
