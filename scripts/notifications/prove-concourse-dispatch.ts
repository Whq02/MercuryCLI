#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-concourse-dispatch.ts — (the
//  basis): idempotent prompt-to-session dispatch over the supervisor.
//
//  §1  the reservation law: the ledger row is written 'queued' BEFORE any
//      admission/worker use; receipts progress queued → starting → working
//      through the ONE adjudicator, with distinct state revisions.
//  §2  the clientMessageId law: a replay returns the SAME receipt — zero
//      second admissions, zero second deliveries; an edited replay (same id,
//      different digest) REFUSES with the draft-preserved contract.
//  §3  refusal truth: an admission refusal settles 'failed' with the reason,
//      consumes no delivery, and the id stays replay-stable.
//  §4  content hygiene: the ledger stores the prompt DIGEST only — the raw
//      prompt text never lands in the dispatch records (shape-only law).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'
import type { ConcourseAdmitResult } from '../../src/daemon/concourseSupervisor.ts'

const t = checker()
const root = scratchRoot('concourse-dispatch')
const dir = join(root, 'daemon')
const { makeConcourseDispatchHandler, readConcourseDispatches, concourseDispatchesPath } = await import(
  '../../src/daemon/concourseDispatch.js'
)

let admits = 0
let delivers = 0
let refuseNext = false
const ledgerStatesAtAdmit: string[] = []
const handler = makeConcourseDispatchHandler({
  admit: async (): Promise<ConcourseAdmitResult> => {
    // §1 witness: the reservation must already be durable when admission runs.
    const rec = readConcourseDispatches(dir)['cm-1'] ?? readConcourseDispatches(dir)['cm-2']
    if (rec) ledgerStatesAtAdmit.push(rec.state)
    admits++
    if (refuseNext) {
      return { ok: false, code: 'runtime-ceiling', error: 'concourse runtime ceiling reached (5 live sessions) — the request and its draft are preserved' }
    }
    return { ok: true, runnerId: `concourse-w${admits}`, sessionId: `sess-${admits}`, workspaceId: '/ws/a' }
  },
  deliver: async () => {
    delivers++
    return true
  },
  dir,
})

t.section('§1 — reservation-first + the receipt ladder')
{
  const r = await handler({ clientMessageId: 'cm-1', prompt: 'fix the OAuth callback', workspaceDir: '/tmp' })
  t.check('the dispatch settles working with its worker/session identities', r.ok === true && r.state === 'working' && r.runnerId === 'concourse-w1' && r.sessionId === 'sess-1', JSON.stringify(r))
  t.check('the reservation was DURABLE before admission ran (queued at admit time)', ledgerStatesAtAdmit[0] === 'queued', JSON.stringify(ledgerStatesAtAdmit))
  const rec = readConcourseDispatches(dir)['cm-1']!
  t.check('the ledger row advanced queued→starting→working (revision 3)', rec.state === 'working' && rec.stateRevision === 3 && rec.deliveredAt !== undefined, JSON.stringify({ state: rec.state, rev: rec.stateRevision }))
}

t.section('§2 — the clientMessageId law')
{
  const replay = await handler({ clientMessageId: 'cm-1', prompt: 'fix the OAuth callback', workspaceDir: '/tmp' })
  t.check('a replay returns the SAME receipt (replayed marker, same identities)', replay.ok === true && replay.replay === 'replayed' && replay.runnerId === 'concourse-w1' && replay.state === 'working', JSON.stringify(replay))
  t.check('a replay admits nothing and delivers nothing', admits === 1 && delivers === 1, `admits=${admits} delivers=${delivers}`)
  const edited = await handler({ clientMessageId: 'cm-1', prompt: 'fix the OAuth callback DIFFERENTLY', workspaceDir: '/tmp' })
  t.check('an EDITED replay refuses (material edit needs a new identity)', edited.ok === false && edited.replay === 'edited-replay' && admits === 1, JSON.stringify(edited))
}

t.section('§3 — refusal truth (the hold valve + FN-008 held-replay)')
{
  // The valve evolution (I-wave + R7 C-HIGH-2): a RETRYABLE admission
  // refusal (runtime ceiling / workspace collision) HOLDS the reservation —
  // 'queued' with the preserved reason, painted as the board's QUEUED band
  // — and the SAME id's replay RE-ATTEMPTS admission, delivering exactly
  // once when a seat frees. Settling 'failed' was the pre-valve posture.
  refuseNext = true
  const refused = await handler({ clientMessageId: 'cm-2', prompt: 'a sixth session', workspaceDir: '/tmp' })
  t.check(
    'a RETRYABLE refusal HOLDS the reservation (queued + preserved reason, no delivery — never failed)',
    refused.ok === false && refused.state === 'queued' && delivers === 1 && /preserved/.test(refused.error ?? ''),
    JSON.stringify(refused),
  )
  refuseNext = false
  const replay = await handler({ clientMessageId: 'cm-2', prompt: 'a sixth session', workspaceDir: '/tmp' })
  t.check(
    'the held id replays into RE-ADMISSION and delivers EXACTLY once when a seat frees (the round-trip)',
    replay.ok === true && replay.state === 'working' && admits === 3 && delivers === 2,
    JSON.stringify({ state: replay.state, admits, delivers }),
  )
}

t.section('§4 — content hygiene (shape-only digests)')
{
  const raw = readFileSync(concourseDispatchesPath(dir), 'utf8')
  t.check('the raw prompt text never lands in the ledger', !raw.includes('OAuth callback') && !raw.includes('sixth session'), 'digest-only')
  const rec = readConcourseDispatches(dir)['cm-1']!
  t.check('the row carries a sha256 digest', /^[0-9a-f]{64}$/.test(rec.promptDigest), rec.promptDigest.slice(0, 12))
}

t.section('§5 — the delivery valve + redirect')
{
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { pauseConcourseWorker, resumeConcourseWorker } = await import('../../src/daemon/concourseSupervisor.ts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'concourse-workers.json'),
    JSON.stringify({
      version: 1,
      workers: {
        'rd-live': { schema: 1, runnerId: 'rd-live', sessionId: 'sess-live', workspaceId: '/ws/a', isolation: 'exclusive', modelKey: 'fable', spawnedAt: Date.now(), lastLiveAt: Date.now(), pid: process.pid },
        'rd-dead': { schema: 1, runnerId: 'rd-dead', sessionId: 'sess-dead', workspaceId: '/ws/b', isolation: 'exclusive', modelKey: 'fable', spawnedAt: Date.now(), lastLiveAt: Date.now(), pid: 4194999 },
      },
    }),
  )
  const sent: Array<{ runnerId: string; frame: string }> = []
  const rhandler = makeConcourseDispatchHandler({
    admit: async () => {
      throw new Error('redirect must NEVER admit')
    },
    deliver: async (runnerId, frame) => {
      sent.push({ runnerId, frame })
      return true
    },
    dir,
  })
  const ok = await rhandler({ clientMessageId: 'rd-1', prompt: 'focus the failing tests first', workspaceDir: '', targetSessionId: 'sess-live' })
  t.check('redirect to a LIVE session delivers through the one door (admit skipped)', ok.ok === true && ok.state === 'working' && sent.length === 1 && sent[0]!.runnerId === 'rd-live', JSON.stringify(ok))
  t.check('…as a framed stream-json instruction (never a raw string)', sent[0]!.frame.startsWith('{') && sent[0]!.frame.includes('focus the failing tests first'))
  t.check('…and the ledger keeps the digest only', !readFileSync(concourseDispatchesPath(dir), 'utf8').includes('focus the failing tests first'))

  pauseConcourseWorker('rd-live', 'operator', dir)
  const held = await rhandler({ clientMessageId: 'rd-2', prompt: 'second instruction', workspaceDir: '', targetSessionId: 'sess-live' })
  const heldRow = readConcourseDispatches(dir)['rd-2']!
  // Re-pinned (copy wave): the OPERATOR copy speaks plain
  // ("paused by … — resume …"); the typed truth rides heldReason on both
  // the receipt and the row.
  t.check('THE VALVE: a paused target HOLDS typed — row stays queued, never failed', held.ok === false && held.heldReason === 'session-paused' && /paused/.test(held.error ?? '') && heldRow.state === 'queued' && heldRow.heldReason === 'session-paused', JSON.stringify({ held, heldRow }))
  t.check('…and nothing was delivered through the closed valve', sent.length === 1)

  const editedReplay = await rhandler({ clientMessageId: 'rd-2', prompt: 'DIFFERENT instruction', workspaceDir: '', targetSessionId: 'sess-live' })
  t.check('a held row still enforces the digest law (edited replay refused)', editedReplay.ok === false && editedReplay.replay === 'edited-replay')

  // The replay is the COMPLETE envelope (envelopeDigestOf spans
  // every field that changes WHAT the dispatch does, incl. targetSessionId
  // — a target-less 'replay' would mean a fresh-session dispatch, a
  // DIFFERENT intent, and must refuse as edited). Production replays
  // always re-supply the target.
  const stillHeld = await rhandler({ clientMessageId: 'rd-2', prompt: 'second instruction', workspaceDir: '', targetSessionId: 'sess-live' })
  t.check('a same-content replay while STILL paused holds again (no delivery)', stillHeld.ok === false && stillHeld.heldReason === 'session-paused' && sent.length === 1)

  resumeConcourseWorker('rd-live', 'operator', dir)
  const resumed = await rhandler({ clientMessageId: 'rd-2', prompt: 'second instruction', workspaceDir: '', targetSessionId: 'sess-live' })
  const resumedRow = readConcourseDispatches(dir)['rd-2']!
  t.check('RESUME + same-id replay DELIVERS exactly once (the round-trip)', resumed.ok === true && resumed.state === 'working' && sent.length === 2 && sent[1]!.runnerId === 'rd-live' && resumedRow.heldReason === undefined, JSON.stringify(resumed))

  const dead = await rhandler({ clientMessageId: 'rd-3', prompt: 'to nobody', workspaceDir: '', targetSessionId: 'sess-dead' })
  // Re-pinned (live-drive ruling): a crash-dead target REVIVES
  // when the daemon wires deps.revive; this proof passes no revive dep, so
  // the honest settle is failed + the revive-move copy (never the retired
  // 'target-not-live' noun).
  t.check('a dead target refuses typed and settles failed', dead.ok === false && /no live runner|revives/.test(dead.error ?? '') && readConcourseDispatches(dir)['rd-3']!.state === 'failed')
}

t.finish('prove-concourse-dispatch')
