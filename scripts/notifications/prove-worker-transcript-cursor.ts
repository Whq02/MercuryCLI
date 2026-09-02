#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-worker-transcript-cursor.ts — (the
//  cursor half): the renderer's read-only worker-transcript projection.
//
//  §1  first paint reads history once; the cursor lands at EOF.
//  §2  the torn-tail law: an in-flight partial line is CARRIED (never
//      parsed, never dropped) and completes on the next read — every record
//      folds EXACTLY ONCE across arbitrary append/read interleavings.
//  §3  re-entry exactly-once: a drained cursor answers empty;
//      re-reading the same cursor re-answers the same suffix (detach/
//      re-attach cannot double-fold).
//  §4  honest edges: a missing file answers empty (the worker may not have
//      written yet); a SHRUNKEN file rewinds with the flag (full repaint,
//      never a silent half-view); malformed complete lines count fail-soft.
//  §5  identical sessionIds in different workspaces resolve to DISTINCT
//      transcript paths (the independence law at this seam).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const t = checker()
const root = scratchRoot('worker-transcript-cursor')
const { openWorkerTranscript, readAfterCursor, workerTranscriptPath } = await import(
  '../../src/services/concourse/workerTranscript.js'
)

const dir = join(root, 'transcripts')
mkdirSync(dir, { recursive: true })
const path = join(dir, 'sess-a.jsonl')
const rec = (n: number) => `${JSON.stringify({ type: 'user', n })}\n`

t.section('§1 — first paint')
{
  writeFileSync(path, rec(1) + rec(2))
  const r = openWorkerTranscript(path)
  t.check('history folds once (2 records), cursor at EOF with an empty carry', r.records.length === 2 && r.cursor.offset > 0 && r.cursor.carry === '', JSON.stringify({ n: r.records.length, offset: r.cursor.offset }))
  t.check('no rewind, no malformed on a clean read', r.rewound === false && r.malformed === 0, JSON.stringify(r))
}

t.section('§2 — the torn-tail law across interleavings')
{
  let { cursor } = openWorkerTranscript(path)
  const half = JSON.stringify({ type: 'assistant', n: 3 })
  appendFileSync(path, `${rec(10)}${half.slice(0, 12)}`)
  let r = readAfterCursor(cursor)
  t.check('a complete appended record folds; the partial is CARRIED unparsed', r.records.length === 1 && r.cursor.carry.length > 0 && r.malformed === 0, JSON.stringify({ n: r.records.length, carry: r.cursor.carry }))
  cursor = r.cursor
  appendFileSync(path, `${half.slice(12)}\n${rec(11)}`)
  r = readAfterCursor(cursor)
  t.check('the carried line completes and folds with its successor (exactly 2)', r.records.length === 2 && (r.records[0] as { n?: number }).n === 3 && (r.records[1] as { n?: number }).n === 11, JSON.stringify(r.records))
  cursor = r.cursor
  const drained = readAfterCursor(cursor)
  t.check('a drained cursor answers empty (nothing double-folds)', drained.records.length === 0 && drained.cursor.offset === cursor.offset, JSON.stringify(drained.cursor))
}

t.section('§3 — re-entry exactly-once (detach/re-attach)')
{
  const first = openWorkerTranscript(path)
  const parked = first.cursor
  appendFileSync(path, rec(20) + rec(21))
  const a = readAfterCursor(parked)
  const b = readAfterCursor(parked)
  t.check('the same parked cursor re-answers the same suffix deterministically', a.records.length === 2 && b.records.length === 2 && JSON.stringify(a.records) === JSON.stringify(b.records), `${a.records.length}/${b.records.length}`)
  const afterA = readAfterCursor(a.cursor)
  t.check('folding from the ADVANCED cursor answers empty (exactly once per cursor line)', afterA.records.length === 0, String(afterA.records.length))
}

t.section('§4 — honest edges')
{
  const missing = openWorkerTranscript(join(dir, 'never-written.jsonl'))
  t.check('a missing transcript answers empty at offset 0 (worker not started writing)', missing.records.length === 0 && missing.cursor.offset === 0 && missing.rewound === false, JSON.stringify(missing.cursor))
  const parked = openWorkerTranscript(path).cursor
  writeFileSync(path, rec(1))
  const shrunk = readAfterCursor(parked)
  t.check('a SHRUNKEN file rewinds with the flag and refolds from zero', shrunk.rewound === true && shrunk.records.length === 1, JSON.stringify({ rewound: shrunk.rewound, n: shrunk.records.length }))
  appendFileSync(path, 'NOT-JSON-AT-ALL\n')
  const bad = readAfterCursor(shrunk.cursor)
  t.check('a malformed COMPLETE line counts fail-soft (never a crash, never silent)', bad.malformed === 1 && bad.records.length === 0, JSON.stringify({ malformed: bad.malformed }))
}

t.section('§5 — workspace-independent transcript identity')
{
  const wsA = join(root, 'ws-a')
  const wsB = join(root, 'ws-b')
  mkdirSync(wsA, { recursive: true })
  mkdirSync(wsB, { recursive: true })
  const pA = workerTranscriptPath({ sessionId: 'same-id', workspaceId: wsA })
  const pB = workerTranscriptPath({ sessionId: 'same-id', workspaceId: wsB })
  t.check('identical sessionIds in different workspaces resolve to DISTINCT paths', pA !== pB && pA.endsWith('same-id.jsonl') && pB.endsWith('same-id.jsonl'), JSON.stringify({ pA, pB }))
}

t.finish('prove-worker-transcript-cursor')
