#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-dispatch-ledger-hot-path.ts — FN-020 row 3:
//  the dispatch ledger is off the per-message hot path in the daemon.
//
//  Every Enter is a sessionDispatch RPC answered by the dispatch handler.
//  Before: the handler re-read and re-parsed the WHOLE ledger from disk per
//  message, then published it durably (fsync'd temp → rename) THREE times on
//  the reply path — the reservation, the pre-delivery 'starting' row and the
//  post-delivery 'working' row — blocking the daemon's event loop while the
//  screen waited for the reply.
//
//    §1 READS PER ENTER — the parsed ledger is memoized and validated by a
//       stat stamp: over N dispatches the ledger is parsed 0 times (was 1
//       per Enter by construction of the replaced code).
//    §2 PUBLISHES ON THE REPLY PATH — 2 per new-session Enter (reservation +
//       'starting'); the 'working' publish lands AFTER the reply (was 3).
//    §3 THE DURABILITY LAWS KEPT — the reservation is on disk at admit time
//       ('queued'), the 'starting' row is on disk at delivery time, the
//       in-process read sees 'working' the moment the reply is minted, and
//       the after-reply publish lands 'working' (revision 3, deliveredAt) on
//       disk within one event-loop turn.
//    §4 CROSS-PROCESS TRUTH — a publish from outside this process (the UI's
//       daemon-less withdraw fallback rides the same primitive) is seen on
//       the very next read; an in-place rewrite is seen too.
//    §5 ORDER + COALESCING — back-to-back dispatches never regress a row on
//       disk; a sync publish of the same map makes the scheduled one
//       redundant (one fewer fsync), and the flush leaves every row settled.
//    §6 WIRING — the two post-delivery sites ride the after-reply spelling,
//       the pre-delivery sites stay synchronous, the memo carries its
//       stale-registry row.
//
//  Instruments are operation-shaped (parse and publish counts by global spy)
//  — the box is contended; no wall clock decides a verdict.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'
import type { ConcourseAdmitResult } from '../../src/daemon/concourseSupervisor.ts'

const t = checker()
const root = scratchRoot('dispatch-ledger-hot-path')
const dir = join(root, 'daemon')
const ROOT = join(import.meta.dir, '..', '..')

// ── the spies (globals — robust under ESM bindings) ─────────────────────────
const rawParse = JSON.parse.bind(JSON)
const rawStringify = JSON.stringify.bind(JSON)
let ledgerParses = 0
let ledgerPublishes = 0
const LEDGER_HEAD = /^\{\s*"version":\s*1,\s*"dispatches"/
JSON.parse = function (text: string, reviver?: never) {
  if (typeof text === 'string' && LEDGER_HEAD.test(text.slice(0, 64))) ledgerParses++
  return rawParse(text, reviver)
} as unknown as typeof JSON.parse
JSON.stringify = function (value: unknown, replacer?: never, space?: never) {
  const v = value as { version?: unknown; dispatches?: unknown } | null
  if (v !== null && typeof v === 'object' && v.version === 1 && 'dispatches' in v) ledgerPublishes++
  return rawStringify(value as never, replacer, space)
} as unknown as typeof JSON.stringify

const { makeConcourseDispatchHandler, readConcourseDispatches, concourseDispatchesPath, flushDeferredDispatchPublishes } = await import(
  '../../src/daemon/concourseDispatch.js'
)
const { durableAtomicPublishSync } = await import('../../src/substrate/durablePublish.js')

type Row = { state?: string; stateRevision?: number; deliveredAt?: number; title?: string }
/** The row as the DISK says it — bypasses the memo and the parse spy. */
const disk = (id: string): Row | undefined => {
  try {
    return (rawParse(readFileSync(concourseDispatchesPath(dir), 'utf8')) as { dispatches: Record<string, Row> }).dispatches[id]
  } catch {
    return undefined
  }
}

let admits = 0
let currentId = ''
const stateAtAdmit: string[] = []
const stateAtDeliver: string[] = []
const handler = makeConcourseDispatchHandler({
  admit: async (): Promise<ConcourseAdmitResult> => {
    admits++
    stateAtAdmit.push(disk(currentId)?.state ?? 'absent')
    return { ok: true, runnerId: `w${admits}`, sessionId: `s${admits}`, workspaceId: '/ws/a' }
  },
  deliver: async () => {
    stateAtDeliver.push(disk(currentId)?.state ?? 'absent')
    return true
  },
  dir,
})
const dispatch = async (id: string) => {
  currentId = id
  return handler({ clientMessageId: id, prompt: `task ${id}`, workspaceDir: '/tmp' })
}

t.section('§1 READS PER ENTER — the memo serves the handler; the disk is parsed once')
{
  const p0 = ledgerParses
  await dispatch('cm-0')
  await flushDeferredDispatchPublishes()
  const warm = ledgerParses
  t.check('the cold path parsed the ledger at most once (an absent file parses nothing; the memo is minted by the first publish)', warm - p0 <= 1, `${warm - p0}`)
  const N = 5
  for (let i = 1; i <= N; i++) await dispatch(`cm-${i}`)
  await flushDeferredDispatchPublishes()
  t.check(`${N} warm dispatches parsed the ledger 0 times (was 1 per Enter — every read re-parsed the file)`, ledgerParses === warm, `${ledgerParses - warm}`)
  console.log(`  BEFORE (by construction of the replaced code): 1 whole-ledger read+parse per Enter · AFTER: 0 (one stat per read)`)
}

t.section('§2 PUBLISHES ON THE REPLY PATH — two before the reply, one after')
{
  const before = ledgerPublishes
  currentId = 'cm-6'
  const reply = await handler({ clientMessageId: 'cm-6', prompt: 'task cm-6', workspaceDir: '/tmp' })
  const onReplyPath = ledgerPublishes - before
  await flushDeferredDispatchPublishes()
  const total = ledgerPublishes - before
  t.check('the reply carries the working receipt', reply.ok === true && reply.state === 'working' && reply.runnerId === 'w7', JSON.stringify(reply))
  t.check('exactly 2 fsync-publishes rode the reply path (reservation + starting) — was 3', onReplyPath === 2, `${onReplyPath}`)
  t.check('…and the working publish landed after the reply (3 in total per Enter, unchanged on disk)', total === 3, `${total}`)
  console.log(`  BEFORE: 3 fsync'd whole-ledger publishes on the reply path per Enter · AFTER: ${onReplyPath} on the reply path + ${total - onReplyPath} after the reply`)
}

t.section('§3 THE DURABILITY LAWS KEPT')
{
  t.check('the reservation was on disk at admit time on every dispatch (queued)', stateAtAdmit.length === 7 && stateAtAdmit.every(s => s === 'queued'), stateAtAdmit.join(','))
  t.check("the 'starting' row was on disk at delivery time on every dispatch", stateAtDeliver.length === 7 && stateAtDeliver.every(s => s === 'starting'), stateAtDeliver.join(','))
  currentId = 'cm-7'
  const reply = await handler({ clientMessageId: 'cm-7', prompt: 'task cm-7', workspaceDir: '/tmp' })
  const memoNow = readConcourseDispatches(dir)['cm-7']
  const diskNow = disk('cm-7')
  t.check("the in-process read sees 'working' the moment the reply is minted", reply.state === 'working' && memoNow?.state === 'working' && memoNow.stateRevision === 3 && memoNow.deliveredAt !== undefined)
  t.check("the disk still reads 'starting' inside the reply turn (the widened window: one event-loop turn)", diskNow?.state === 'starting', diskNow?.state)
  await flushDeferredDispatchPublishes()
  const settled = disk('cm-7')
  t.check("after the turn the disk reads 'working', revision 3, deliveredAt set (exactly what it read before, one turn later)", settled?.state === 'working' && settled.stateRevision === 3 && typeof settled.deliveredAt === 'number', JSON.stringify(settled))
}

t.section('§4 CROSS-PROCESS TRUTH — another writer moves the stamp; the next read sees it')
{
  const path = concourseDispatchesPath(dir)
  const foreign = rawParse(readFileSync(path, 'utf8')) as { version: 1; dispatches: Record<string, Row> }
  foreign.dispatches['cm-1']!.title = 'edited out of process'
  const parsesBefore = ledgerParses
  // The UI fallback's shape: the same durable primitive from a map this
  // process never held (temp → rename: a new inode, a new mtime).
  durableAtomicPublishSync(path, `${rawStringify(foreign, null, 1)}\n`)
  const seen = readConcourseDispatches(dir)['cm-1']
  t.check('a rename-publish from outside is seen on the next read (one re-parse)', seen?.title === 'edited out of process' && ledgerParses === parsesBefore + 1, `${seen?.title} parses+${ledgerParses - parsesBefore}`)
  const again = readConcourseDispatches(dir)
  t.check('…and the read after that is served from the memo (no further parse)', ledgerParses === parsesBefore + 1 && again['cm-1']?.title === 'edited out of process')
  // An in-place rewrite (same inode): mtime and size move the stamp too.
  foreign.dispatches['cm-2']!.title = 'rewritten in place'
  writeFileSync(path, `${rawStringify(foreign, null, 1)}\n`)
  t.check('an in-place rewrite is seen too (mtime + size are part of the stamp)', readConcourseDispatches(dir)['cm-2']?.title === 'rewritten in place' && ledgerParses === parsesBefore + 2, `parses+${ledgerParses - parsesBefore}`)
}

t.section('§5 ORDER + COALESCING — back-to-back dispatches never regress a row; one fewer fsync')
{
  const before = ledgerPublishes
  currentId = 'cm-8'
  const p8 = handler({ clientMessageId: 'cm-8', prompt: 'task cm-8', workspaceDir: '/tmp' })
  currentId = 'cm-9'
  const p9 = handler({ clientMessageId: 'cm-9', prompt: 'task cm-9', workspaceDir: '/tmp' })
  await Promise.all([p8, p9])
  await flushDeferredDispatchPublishes()
  const total = ledgerPublishes - before
  t.check("cm-9's reservation publish carried cm-8's working row (the scheduled publish coalesced): 5 publishes for two Enters, not 6", total === 5, `${total}`)
  const d8 = disk('cm-8')
  const d9 = disk('cm-9')
  t.check('both rows settled working on disk, revision 3 — no regression', d8?.state === 'working' && d8.stateRevision === 3 && d9?.state === 'working' && d9.stateRevision === 3, JSON.stringify({ d8, d9 }))
  const all = readConcourseDispatches(dir)
  t.check('every dispatched row reads working in the memo and on disk', ['cm-0', 'cm-1', 'cm-2', 'cm-3', 'cm-4', 'cm-5', 'cm-6', 'cm-7', 'cm-8', 'cm-9'].every(id => all[id]?.state === 'working' && disk(id)?.state === 'working'))
}

t.section('§6 WIRING')
{
  const src = readFileSync(join(ROOT, 'src/daemon/concourseDispatch.ts'), 'utf8')
  const afterReply = src.match(/publishDispatchesAfterReply\(dispatches, deps\.dir\)/g) ?? []
  t.check('exactly the two post-delivery sites ride the after-reply publish', afterReply.length === 2, `${afterReply.length}`)
  const sites = [...src.matchAll(/advance\(rec, 'working', \{ deliveredAt: Date\.now\(\) \}\)[\s\S]{0,400}?publishDispatches(AfterReply)?\(dispatches, deps\.dir\)/g)]
  t.check("…and each follows its advance(rec, 'working') (never a pre-delivery publish)", sites.length === 2 && sites.every(m => m[1] === 'AfterReply'))
  t.check('the reservation and the starting publishes stay synchronous', /dispatches\[req\.clientMessageId\] = rec\n\s*publishDispatches\(dispatches, deps\.dir\)/.test(src) && /advance\(rec, 'starting', \{ workerId: admitted\.runnerId[\s\S]{0,1200}?\n\s*publishDispatches\(dispatches, deps\.dir\)\n/.test(src))
  t.check('the read is stamp-validated (ino · mtimeMs · size) and the publish refreshes the memo with the map it wrote', /const stamp = ledgerStamp\(path\)[\s\S]{0,200}memo\.stamp === stamp\) return memo\.map/.test(src) && /st\.ino\}:\$\{st\.mtimeMs\}:\$\{st\.size\}/.test(src) && /ledgerMemo\.set\(path, \{ stamp, map: dispatches \}\)/.test(src))
  t.check('a publish that did not land drops the memo and rethrows (the next read re-parses the disk — discard-on-failure kept)', /durableAtomicPublishSync\(\n\s*path,[\s\S]{0,200}?\} catch \(err\) \{[\s\S]{0,400}?ledgerMemo\.delete\(path\)\n\s*throw err\n\s*\}/.test(src))
  const registry = readFileSync(join(ROOT, 'scripts/staleness/prove-stale-registry.ts'), 'utf8')
  t.check('the memo carries its stale-registry row (keyed-by-truth)', registry.includes('src/daemon/concourseDispatch.ts :: ledgerMemo :: keyed-by-truth'))
}

t.finish('prove-dispatch-ledger-hot-path')
