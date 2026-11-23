#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const SCRATCH = mkdtempSync(join(tmpdir(), 'status-prune-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : `${detail}${detail ? ' — ' : ''}fix the census in src/sessions/transcripts/sessionListings.ts (transcriptCensus), the sweep in src/sessions/transcripts/retentionSweep.ts (recordingsUnderSweep, retentionWindowDays, cleanupOldSessionFiles) or the offer and the delete door in src/daemon/switchboard/transcriptPruneDoor.ts (buildPruneOffer, operatorPruneTranscripts)`
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
const { getProjectsDir } = await import('../../src/sessions/transcripts/paths.ts')
const { transcriptCensus } = await import('../../src/sessions/transcripts/sessionListings.ts')
const { cleanupOldSessionFiles, recordingsUnderSweep, retentionWindowDays } = await import('../../src/sessions/transcripts/retentionSweep.ts')
const { buildPruneOffer, operatorPruneTranscripts } = await import('../../src/daemon/switchboard/transcriptPruneDoor.ts')

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
const projectsRoot = getProjectsDir()

const sid = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`
function seedFile(dir: string, name: string, bytes: number, days: number): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, 'x'.repeat(bytes))
  const t = new Date(NOW - days * DAY)
  utimesSync(file, t, t)
  return file
}

console.log('A — the retention numbers come from the estate\'s own owners, exact over a known estate')
{
  const P_A = join(projectsRoot, 'proj-a')
  const P_B = join(projectsRoot, 'proj-b')
  seedFile(P_A, `${sid('a1')}.jsonl`, 120, 10)
  seedFile(P_A, `${sid('a2')}.jsonl`, 80, 0)
  seedFile(P_A, 'young.cast', 50, 0)
  seedFile(P_A, 'notes.jsonl', 999, 5)
  seedFile(P_A, 'stray.txt', 11, 500)
  const oldestFile = seedFile(P_B, `${sid('b1')}.jsonl`, 200, 400)
  seedFile(P_B, 'aged.cast', 70, 90)
  seedFile(projectsRoot, 'rootfile.cast', 33, 90)

  const t = await transcriptCensus()
  check('transcriptCensus counts every UUID transcript and only those (3, the non-UUID .jsonl excluded)', t.count === 3, String(t.count))
  check('…with their exact disk weight (120+80+200)', t.bytes === 400, String(t.bytes))
  check("…and the oldest's own mtime (the 400-day file, stat-exact)", t.oldestMtimeMs === statSync(oldestFile).mtime.getTime(), String(t.oldestMtimeMs))
  const r = await recordingsUnderSweep()
  check('recordingsUnderSweep counts the .cast files in project dirs and only those (2 — root strays and .txt excluded)', r.count === 2, String(r.count))
  check('…with their exact bytes (50+70)', r.bytes === 120, String(r.bytes))
  check('the window has ONE owner and defaults honest (30 days in a bare home)', retentionWindowDays() === 30, String(retentionWindowDays()))
}

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

  const born = seedFile(P_DOOR, `${sid('b0')}.jsonl`, 150, 90)
  utimesSync(t4, new Date(NOW - 90 * DAY), new Date(NOW - 90 * DAY))

  unlinkSync(t3)
  const receipt = await operatorPruneTranscripts(offer)
  check('the door deleted exactly the named set that still stood (t1 t2), receipt exact (2 deleted · 300 bytes freed)', receipt.deleted === 2 && receipt.bytesFreed === 300 && receipt.deletedSessionIds.join(',') === [sid('f1'), sid('f2')].join(','), JSON.stringify(receipt))
  check('the vanished candidate counts FAILED, honestly', receipt.failed === 1)
  check('the receipt stamps its when', receipt.at instanceof Date && Math.abs(receipt.at.getTime() - Date.now()) < 60_000)
  check('POISON: nothing outside the confirmed scope was deleted — the young, the live, the active and the recording all stand', !existsSync(t1) && !existsSync(t2) && existsSync(t4) && existsSync(t5) && existsSync(t6) && existsSync(decoyCast))
  check('POISON (the freeze law): a chat born after the card, or aged past the window inside the gap, is never deleted — the offer never rebuilds at Yes', existsSync(born) && existsSync(t4))
  check('POISON: the door reached into no other project (the census estate stands whole)', existsSync(join(projectsRoot, 'proj-a', `${sid('a1')}.jsonl`)) && existsSync(join(projectsRoot, 'proj-b', `${sid('b1')}.jsonl`)))

}


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
}

removeScratch(SCRATCH)
console.log(failures === 0 ? '\nprove-status-prune: ALL LAWS HOLD' : `\nprove-status-prune: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
