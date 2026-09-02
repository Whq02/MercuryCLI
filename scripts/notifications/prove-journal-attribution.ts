#!/usr/bin/env bun
// ============================================================================
//  prove-journal-attribution — the coordinator-receipt journal, the channel
//  frame's credential privacy, typed attention, the managed-session count.
//
//  §1 D3 — the cross-process coordinator-receipt journal: a FOREIGN-pid row
//     folds onto this process's feed through the ONE registered classifier
//     exactly once (cursor-guarded re-fold folds zero); OWN-pid rows are
//     skipped (already on this ring) while the cursor advances.
//  §3 — credential privacy: no account-connection material (auth
//     files, api keys, tokens-as-credentials) is referenced anywhere in the
//     channel frame emitter.
//  §4 — authoritative attention only: the obligations bridge consumes
//     TYPED obligation rows from the one owner; no prose scanning, no
//     message-text inference anywhere in the gatherer.
//  §5 — the main REPL is managed session #1: the live-count bridge's
//     self term + the supervisor-truth worker term.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'sg7-attribution-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = join(scratch, 'home')
}
mkdirSync(join(scratch, 'home'), { recursive: true })
const crewDir = join(scratch, 'crew')
mkdirSync(crewDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const REPO = join(import.meta.dir, '../../')
const src = (p: string) => readFileSync(join(REPO, p), 'utf8')

console.log('§1 D3 — the receipt journal folds foreign rows exactly once')
{
  const receipts = await import('../../src/services/concourse/coordinatorReceipts.ts')
  const activity = await import('../../src/services/crew/activity.ts')
  activity._resetActivityFeedForTesting()
  // Seed the journal DIRECTLY (production shape): one foreign-pid refusal
  // row + one own-pid row.
  const journalPath = join(crewDir, 'coordinator-receipt-journal.json')
  writeFileSync(
    journalPath,
    JSON.stringify({
      schemaVersion: 1,
      rows: [
        {
          seq: 1,
          pid: 999_999_1,
          atMs: Date.now(),
          actorAgentId: 'daemon-coordinator-seat',
          payload: { kind: 'turn-refusal', reason: 'daemon-side refusal for the fold leg', actorAgentId: 'daemon-coordinator-seat' },
        },
        {
          seq: 2,
          pid: process.pid,
          atMs: Date.now(),
          actorAgentId: 'own-seat',
          payload: { kind: 'turn-refusal', reason: 'own-pid row must not double-fold', actorAgentId: 'own-seat' },
        },
      ],
      nextSeq: 3,
      consumedSeq: 0,
    }),
  )
  const folded = await receipts.foldJournaledCoordinatorReceipts({ crewDir })
  check('exactly the FOREIGN row folded', folded === 1, String(folded))
  const rows = activity.activityRows(activity.cachedActivityFeed())
  check(
    'the daemon-side refusal is on THIS feed through the registered classifier',
    rows.some(r => r.verb === 'refused' && r.objectLabel.includes('daemon-side refusal')),
    JSON.stringify(rows.map(r => r.verb)),
  )
  check('the own-pid row never double-folded', !rows.some(r => r.objectLabel.includes('own-pid')))
  const again = await receipts.foldJournaledCoordinatorReceipts({ crewDir })
  check('a re-fold folds ZERO (cursor exactly-once)', again === 0, String(again))
  const state = JSON.parse(readFileSync(journalPath, 'utf8')) as { consumedSeq: number }
  check('the cursor advanced past BOTH rows', state.consumedSeq === 2, String(state.consumedSeq))

  // THE CURSOR FOLLOWS WHAT LANDED (FN-017 rank 14). The base advanced the
  // cursor to the journal's max seq whatever happened to a row, so a row
  // whose ingest threw was gone from the feed for good, and the fold ran
  // OUTSIDE the hook's re-entrancy guard, so a second fold could start over
  // the same snapshot before the cursor moved. An ingest cannot be made to
  // throw through any payload shape (classifyActivity swallows a classifier's
  // throw and the total unknown-fallback classifier is registered by the
  // activity module itself — the driven checks above already saw a null
  // payload land), so the failure half is a latent property pinned at the
  // source; the landed-rows half is what the checks above drive.
  const fold = src('src/services/concourse/coordinatorReceipts.ts')
  const foldFn = fold.slice(fold.indexOf('export async function foldJournaledCoordinatorReceipts'), fold.indexOf('async function resolveActor'))
  check('the cursor advances only over rows the fold ingested (after the ingest, never before)', /ingestActivity\(inputOf\(row\.payload, row\.actorAgentId, row\.atMs\)\)\s*\n\s*folded\+\+\s*\n\s*advanceTo = row\.seq/.test(foldFn))
  check('…and over its own-pid rows (a deliberate skip is a landed row)', /if \(row\.pid === process\.pid\) \{\s*\n\s*advanceTo = row\.seq\s*\n\s*continue/.test(foldFn))
  check('a row whose ingest throws stops the cursor (retried next fold) and is skipped only after its bounded retry', /if \(failures < FOLD_RETRY_LIMIT\) \{[\s\S]*?break[\s\S]*?\}[\s\S]*?advanceTo = row\.seq/.test(foldFn) && /const FOLD_RETRY_LIMIT = 2/.test(fold))
  check('the cursor write is the landed seq, never the journal\'s max seq', /consumedSeq: advanceTo/.test(foldFn) && !/Math\.max\(m, r\.seq\)/.test(foldFn))
  const hook = src('src/hooks/useConcourseLifecycleSignals.ts')
  const replayBody = hook.slice(hook.indexOf('const replay = (): void => {'), hook.indexOf('replay()\n'))
  check('the receipt-journal fold runs INSIDE the re-entrancy guard (the guard clears after it, not before)', replayBody.indexOf('foldJournaledCoordinatorReceipts()') > 0 && replayBody.indexOf('foldJournaledCoordinatorReceipts()') < replayBody.lastIndexOf('replaying = false'), `fold@${replayBody.indexOf('foldJournaledCoordinatorReceipts()')} clear@${replayBody.lastIndexOf('replaying = false')}`)

  // The append side: an ingest journals its own payload (pid-stamped).
  activity._resetActivityFeedForTesting()
  receipts.ingestCoordinatorReceipts(
    [{ verb: 'attention.raise', objectRef: 'sg7:journal', outcome: 'applied', actorAgentId: 'seat-x' }],
    { crewDir },
  )
  // the append is fire-and-forget: poll the journal until the row lands, bounded 3s
  let after = { rows: [] } as { rows: Array<{ pid: number; payload: { kind: string } }> }
  for (const deadline = Date.now() + 3000; ; ) {
    after = JSON.parse(readFileSync(journalPath, 'utf8')) as typeof after
    if (after.rows.some(r => r.pid === process.pid && r.payload.kind === 'action') || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, 50))
  }
  check(
    'an ingest APPENDS a pid-stamped action row for other processes',
    after.rows.some(r => r.pid === process.pid && r.payload.kind === 'action'),
    JSON.stringify(after.rows.map(r => r.payload.kind)),
  )
}

console.log('§3 — no credential material in the channel frame path')
{
  const emitters = ['src/services/channel/frame.ts']
  const offenders = emitters.filter(p => /openai-auth|ANTHROPIC_API_KEY|apiKey|access_token|client_secret/.test(src(p)))
  check('the frame emitter references NO account-connection material', offenders.length === 0, offenders.join(','))
}

console.log('§4 — attention comes from TYPED events only')
{
  const bridge = src('src/services/crew/obligationsBridge.ts')
  check('the gatherer consumes the obligations owner (typed rows)', bridge.includes("from './obligations.js'") || bridge.includes('openObligations'))
  check('…and performs NO prose inference (no message-text scanning)', !/match\(|\.includes\('\?'\)|sounds|regex/i.test(bridge))
  const obligations = src('src/services/crew/obligations.ts')
  check('the owner mints obligations from typed upserts only (no free-text parser)', !obligations.includes('parseMessage') && !obligations.includes('inferFrom'))
}

console.log('§5 — the main REPL is managed session #1 (ruling 26)')
{
  const bridge = src('src/utils/liveCountBridge.ts')
  check('the live-count self term records ruling 26 (managed session #1)', bridge.includes('ruling 26') && bridge.includes('managed session #1'))
  check('…and the worker term reads SUPERVISOR truth', bridge.includes('countLiveConcourseWorkers') || bridge.includes('concourseSupervisor'))
  const turnMachine = src('src/run-core/turn-machine.ts')
  check("the main REPL's own turns hold counted FOREGROUND permits (the backstop)", turnMachine.includes("'foreground'") && turnMachine.includes('acquireModelPermit'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-JOURNAL-ATTRIBUTION: PASS' : `\nPROVE-JOURNAL-ATTRIBUTION: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
