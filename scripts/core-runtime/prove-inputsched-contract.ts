#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-inputsched-contract.ts —
//  (typed pending-input owner) + (input-first scheduling boundary):
//  characterization laws GREEN ON THE OLD BODIES, from the characterization set
//  (both halves).
//
//  law families (the owner cut moves these bodies behind one store —
//  every law here is a behavior the new owner must reproduce):
//    • QUEUE-LAWS — messageQueueManager priority/FIFO/identity (the pen's
//      pop/restage/count surface died with the steer-removal ruling)
//      semantics, incl. the CLONE-ON-ENQUEUE identity mint, the T8 steering
//      drain's exactly-once identity removal, drain↔pop mutual exclusion,
//      dequeueAllMatching's
//      INSERTION-order return (its docstring says priority order — quirk).
//    • DRAFT-DURABILITY — promptDraft debounce/flush lifecycle: owning-
//      session capture on a mid-debounce switch, EMPTY-DRAFT-DELETE
//      (submitted drafts can never resurrect), cancel-then-delete submit
//      ordering, the ALL-pastes shed at the 256KB budget (not just the
//      oversized one — characterized), MAX_DRAFTS=20 eviction, sanitize
//      defaults. NOTE: promptDraft has NO injectable clock (a recorded quirk
//      over-described this) — laws drive flushDraftSaves() explicitly and
//      monkeypatch Date.now only around savedAt capture.
//    • SEED-CHOKEPOINT — composerSeed arm-counting + the seedable-input
//      predicate matrix + stale-unregister hygiene.
//    • RESTORE-EXACTNESS — textForResubmit shape recovery (prose, !bash,
//      /command args incl. the args-less TRAILING-SPACE quirk, IDE-tag
//      strip). The 5-guard auto-restore matrix is REPL-closure state
//      (bun-unloadable) — pinned below as SOURCE-LOCKS; the on/off matrix
//      as behavior lands with the extracted owner.
//    • SOURCE-LOCKS — REPL.tsx/query.ts/PromptInput.tsx text anchors for the
//      bodies a bun rig cannot load (prove-stream-commit-throttle precedent):
//      the setInputValue chokepoint's FIVE effects in order (an earlier
//      count had three — intercept, re-pin, ref-sync — the body also flips
//      isPromptInputActive and marks typing activity), the auto-restore
//      five-guard conjunction + history rewind, submit's cancel-then-delete,
//      the session-switch flush-before-read, the concurrent-submit enqueue,
//      the T8 drain pair.
//
//  law families (the policy swaps inside T6's RenderScheduler seam —
//  characterized so the swap is conscious):
//    • BOUNDED-QUEUES — StreamBatcher + streamingTailStore each hold ≤1
//      pending flush timer under a delta storm (the declared-bound
//      law; cadence semantics stay pinned by prove-stream-commit-throttle +
//      prove-tail-store — not duplicated here).
//    • ECHO-PRIORITY — one shared fake-timer wheel hosting RenderScheduler +
//      batcher + tail store: an idle-scheduler keystroke paints BEFORE every
//      armed nonessential flush (leading edge ≈ 0ms — the verdict's
//      mechanism); a keystroke inside an OPEN throttle window waits for the
//      16ms boundary and COALESCES with stream frames (the CURRENT no-input-
//      priority policy — the exact behavior T14's FramePriority swap will
//      consciously change or keep).
//    • DISPATCH — real Ink mount over a fake TTY: one stdin chunk of N
//      decoded atoms ⇒ N InputEvent listener invocations in order inside ONE
//      discrete batch (one React commit); a plain printable run is ONE atom
//      (decoder-level coalescing — characterized; the "N key
//      events ⇒ N InputEvents" holds at ATOM granularity); sibling subtrees
//      do not re-render on an input commit (the store-granularity isolation
//      mechanism T13's ownership move relies on); a multi-atom chunk paints
//      ≤2 frames (leading+trailing), never per-atom; no blank intermediate
//      frame across input-driven content swaps.
//    NOT here: LAW COALESCE / boot-lattice exact timing (T6 owns them in
//    prove-root-contract — the boot-window echo hold is the input-relevant
//    corollary of T6's boot law); the REPL-scale zero-transcript-rerender
//    acceptance (composer state lives IN the REPL root today — that law
//    lands with the cut); echo p50/p95 receipts (bench-baseline.ts).
//
//  Deterministic: injected wheels for every timing-shaped assertion; the Ink
//  rig uses the same settle() the T6 contract uses. No src/** edits, no PTY,
//  no network; drafts + queue-op logs land in a throwaway MERCURY_CONFIG_DIR.
//
//  NODE_ENV must NOT be 'test' (lattice bypass in the Ink rig).
//
//  Run: ~/.bun/bin/bun run scripts/core-runtime/prove-inputsched-contract.ts
// ============================================================================
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SchedulerClock } from '../../src/ink/root/render-scheduler.js'

if (process.env.NODE_ENV === 'test') {
  console.error('prove-inputsched-contract must not run with NODE_ENV=test (lattice bypass)')
  process.exit(1)
}

// Hermetic home BEFORE any src value-module loads (drafts, queue-op session
// logs). getMercuryHome memoizes keyed on this env var, so the very
// first resolution already lands here.
const HERMETIC_HOME = mkdtempSync(join(tmpdir(), 'native-core-inputsched-'))
process.env.MERCURY_CONFIG_DIR = HERMETIC_HOME
process.env.MERCURY_DAEMON_DIR = join(HERMETIC_HOME, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(HERMETIC_HOME, 'teams')

// S1: the queue's owner is input-core/command-queue.ts (the old
// utils/messageQueueManager path is a pure re-export shim over it).
const q = await import('../../src/input-core/command-queue.js')
const draft = await import('../../src/utils/promptDraft.js')
const seed = await import('../../src/utils/cockpit/composerSeed.js')
const { textForResubmit } = await import('../../src/utils/messages/text.js')
const { StreamBatcher } = await import('../../src/utils/messages/streamBatcher.js')
const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.js')
const { RenderScheduler } = await import('../../src/ink/root/render-scheduler.js')
const { FRAME_INTERVAL_MS } = await import('../../src/ink/constants.js')
const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { Box, Text, useInput } = await import('../../src/ink.js')
const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')

import type { QueuedCommand } from '../../src/types/textInputTypes.js'
import type { Key } from '../../src/ink/events/input-event.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('native-core T13/T14 — input-scheduling contract')

// ════════════════════════════════════════════════════════════════════════════
// A — QUEUE-LAWS (messageQueueManager: pure module state)
// ════════════════════════════════════════════════════════════════════════════
{
  const cmd = (value: string, extra: Partial<QueuedCommand> = {}): QueuedCommand =>
    ({ value, mode: 'prompt', ...extra }) as QueuedCommand

  // Priority order now > next > later, FIFO within a priority.
  q.resetCommandQueue()
  q.enqueue(cmd('L1', { priority: 'later' }))
  q.enqueue(cmd('N1', { priority: 'now' }))
  q.enqueue(cmd('X1', { priority: 'next' }))
  q.enqueue(cmd('N2', { priority: 'now' }))
  const order = [q.dequeue()?.value, q.dequeue()?.value, q.dequeue()?.value, q.dequeue()?.value]
  check('queue: dequeue order is now>next>later with FIFO ties', order.join(',') === 'N1,N2,X1,L1', order.join(','))
  check('queue: empty dequeue is undefined', q.dequeue() === undefined)

  // Priority defaults: enqueue ⇒ 'next'; enqueuePendingNotification ⇒ 'later'.
  q.resetCommandQueue()
  q.enqueue(cmd('user'))
  q.enqueuePendingNotification(cmd('notif', { mode: 'task-notification' }))
  const snap = q.getCommandQueueSnapshot()
  check('queue: enqueue defaults priority next', snap[0]?.priority === 'next', String(snap[0]?.priority))
  check('queue: enqueuePendingNotification defaults priority later', snap[1]?.priority === 'later', String(snap[1]?.priority))

  // CLONE-ON-ENQUEUE: queue identity is MINTED at enqueue ({...command}) —
  // the caller's object is NOT the queue entry, so remove() by the caller's
  // reference is a no-op; only queue-obtained references remove. The WeakMap
  // row cache + the T8 drain both depend on the QUEUE-side identity.
  q.resetCommandQueue()
  const mine = cmd('identity probe')
  q.enqueue(mine)
  const inQueue = q.getCommandQueue()
  check('queue: enqueue clones — the entry is not the caller reference', inQueue[0] !== mine && inQueue[0]?.value === 'identity probe')
  q.remove([mine])
  check('queue: remove() by the caller reference is a no-op (identity, not equality)', q.getCommandQueue().length === 1)
  const equalClone = { ...inQueue[0]! }
  q.remove([equalClone])
  check('queue: remove() by an equal-shaped clone is a no-op', q.getCommandQueue().length === 1)
  q.remove([inQueue[0]!])
  check('queue: remove() by the queue-obtained reference removes', q.getCommandQueue().length === 0)

  // Snapshot laws (useSyncExternalStore contract).
  q.resetCommandQueue()
  const s0 = q.getCommandQueueSnapshot()
  check('queue: snapshot is frozen', Object.isFrozen(s0))
  check('queue: snapshot reference is stable between mutations', q.getCommandQueueSnapshot() === s0)
  let notifications = 0
  const unsub = q.subscribeToCommandQueue(() => notifications++)
  q.enqueue(cmd('snap probe'))
  const s1 = q.getCommandQueueSnapshot()
  check('queue: a mutation replaces the snapshot reference and notifies once', s1 !== s0 && notifications === 1, String(notifications))
  const missingRemove = q.getCommandQueueSnapshot()
  q.remove([cmd('not in queue')])
  check('queue: a no-hit remove does not notify or reroll the snapshot',
    notifications === 1 && q.getCommandQueueSnapshot() === missingRemove)
  unsub()

  // The drain's band view (getDrainableCommands — the one exported band
  // read since the pen died): a plain boundary takes now+next; a Sleep
  // boundary adds 'later' TASK-NOTIFICATIONS only (a held prompt in the
  // later band belongs to internal producers now, and still never folds
  // into a sleeping turn).
  q.resetCommandQueue()
  q.enqueue(cmd('nowA', { priority: 'now' }))
  q.enqueue(cmd('nextA', { priority: 'next' }))
  q.enqueue(cmd('laterA', { priority: 'later' }))
  q.enqueue(cmd('laterN', { mode: 'task-notification', priority: 'later' }))
  check('drain view: plain boundary takes now+next only', q.getDrainableCommands(false).map(c => c.value).join(',') === 'nowA,nextA')
  check('drain view: sleep boundary adds later NOTIFICATIONS only', q.getDrainableCommands(true).map(c => c.value).join(',') === 'nowA,nextA,laterN')
  const live = q.getDrainableCommands(false)
  check('drain view: returns the queue\'s own object references', live[0] === q.getCommandQueue()[0])

  // T8 DRAIN exactly-once: snapshot the band view → remove by identity;
  // re-removing the same references is a strict no-op.
  q.resetCommandQueue()
  q.enqueue(cmd('steer me', { priority: 'next' }))
  const drained = q.getDrainableCommands(false)
  q.remove(drained)
  check('drain: identity removal empties the queue', q.getCommandQueue().length === 0)
  q.remove(drained)
  check('drain: re-removing the same references is a no-op', q.getCommandQueue().length === 0)

  // (RETIRED WITH THE PEN — steer-removal: popAllEditable /
  // popNewestEditable, the editable/visible classifiers and their
  // composition/cursor quirks died with the operator-facing holding pen.
  // POISON: their return reds the census below.)
  for (const dead of ['popAllEditable', 'popNewestEditable', 'isQueuedCommandEditable', 'isQueuedCommandVisible', 'restageNewestPrompt', 'countQueuedPrompts', 'clearCommandQueue']) {
    check(`pen-retired: ${dead} is gone from the queue surface`, !(dead in q))
  }

  // Slash-command classification (the steering drain's exclusion primitive).
  check('slash: /cmd is a slash command', q.isSlashCommand(cmd('/cards')))
  check('slash: leading whitespace still classifies', q.isSlashCommand(cmd('  /cards')))
  check('slash: skipSlashCommands opts out (bridge text for the model)', !q.isSlashCommand(cmd('/cards', { skipSlashCommands: true })))
  check('slash: block-array values are never slash commands', !q.isSlashCommand(cmd('x', { value: [{ type: 'text', text: '/cards' }] } as never)))

  // dequeue(filter): non-matching entries stay untouched (the SDK/between-
  // turn drain restricts to main-thread commands).
  q.resetCommandQueue()
  q.enqueue(cmd('agent scoped', { agentId: 'agent-1' } as never))
  q.enqueue(cmd('main scoped'))
  const filtered = q.dequeue(c => (c as { agentId?: string }).agentId === undefined)
  check('queue: filtered dequeue takes the first match and leaves the rest',
    filtered?.value === 'main scoped' && q.getCommandQueue()[0]?.value === 'agent scoped')

  // peek is non-destructive and priority-aware.
  q.resetCommandQueue()
  q.enqueue(cmd('laterB', { priority: 'later' }))
  q.enqueue(cmd('nowB', { priority: 'now' }))
  check('queue: peek returns the highest priority without removing', q.peek()?.value === 'nowB' && q.getCommandQueue().length === 2)

  // dequeueAllMatching QUIRK (characterized): returns matches in INSERTION
  // order — its docstring says "preserving priority order", but the body
  // walks the queue array; a later-priority entry enqueued first comes back
  // first.
  q.resetCommandQueue()
  q.enqueue(cmd('laterC', { priority: 'later' }))
  q.enqueue(cmd('nowC', { priority: 'now' }))
  const matched = q.dequeueAllMatching(() => true)
  check('queue QUIRK: dequeueAllMatching returns INSERTION order, not priority order',
    matched.map(c => c.value).join(',') === 'laterC,nowC', matched.map(c => c.value).join(','))

  q.resetCommandQueue()
}

// ════════════════════════════════════════════════════════════════════════════
// A2 — IMMUTABLE RECORDS UNDER RESTAGE (store-foundation fix 2)
//  The queue never mutates a record after minting it: a restage REPLACES the
//  record with a new one carrying the same stable queueId. The guarded class: a
//  restage writing cmd.priority in place — every frozen snapshot returned to
//  React changes retroactively (the uSES immutable-snapshot violation) and
//  record-identity memoizers ride the mutated reference.
// ════════════════════════════════════════════════════════════════════════════
{
  const cmd = (value: string, extra: Partial<QueuedCommand> = {}): QueuedCommand =>
    ({ value, mode: 'prompt', ...extra }) as QueuedCommand

  q.resetCommandQueue()
  const original = cmd('immutable probe')
  q.enqueue(original)
  const heldSnap = q.getCommandQueueSnapshot()
  const heldRecord = heldSnap[0]!
  check('restage: enqueue mints a stable queueId on the queue entry (never on the caller object)',
    typeof heldRecord.queueId === 'string' && heldRecord.queueId.length > 0 && original.queueId === undefined,
    JSON.stringify({ entry: heldRecord.queueId, caller: original.queueId }))

  // (Restage itself is RETIRED — the pen's band-move gesture died with the
  // steer-removal ruling; the immutability laws it exercised survive on
  // the surviving verbs.) An equal-shaped clone of the queue entry never
  // removes (reference identity IS the remove law); the queue-obtained
  // reference removes exactly once.
  const clone = { ...heldRecord }
  q.remove([clone])
  check('identity: an equal-shaped (same-queueId) clone does NOT remove',
    q.getCommandQueue().length === 1)
  q.remove([q.getCommandQueue()[0]!])
  check('identity: the queue-obtained reference removes exactly once',
    q.getCommandQueue().length === 0)

  // (replaceNext retired with the attention re-route — steer-removal
  // follow-up: no queued entry exists to replace under instant delivery.)
  check('pen-retired: replaceNext is gone from the queue surface', !('replaceNext' in q))

  q.resetCommandQueue()
}

// ════════════════════════════════════════════════════════════════════════════
// A2 — QUEUE-REKEY (AGENTDIALS C6, Law 9: the queue is the SESSION's own —
//      the W4/pending-input sibling). Before this seam, ONE module-global
//      band store served whichever session was focused: words typed while A
//      was busy were drained by B's next turn after a hop. The REPL's hop
//      effect now re-keys the store at the slot swap. THE SAME-SESSION ROAD
//      IS BYTE-IDENTICAL BY CONSTRUCTION: every QUEUE-LAWS check in section
//      A above ran with NO rekey call and stands green — that section IS
//      the road's proof, untouched.
// ════════════════════════════════════════════════════════════════════════════
{
  const cmd = (value: string, extra: Partial<QueuedCommand> = {}): QueuedCommand =>
    ({ value, mode: 'prompt', ...extra }) as QueuedCommand

  // 1 THE HOP NEVER FIRES FOREIGN QUEUED WORDS: A's words park with A at
  //   the swap; B's queue and drain see NOTHING; the return restores them
  //   byte-identical — order, band, and the minted queueId all survive.
  q.resetCommandQueue()
  q.rekeyCommandQueueToSession('session-A')
  q.enqueue(cmd('for A only'))
  q.enqueue(cmd('also A'))
  const aIds = q.getCommandQueue().map(c => c.queueId).join(',')
  q.rekeyCommandQueueToSession('session-B')
  check("rekey: the hop parks A's words whole — B's queue is EMPTY", q.getCommandQueue().length === 0)
  check("rekey: B's turn-start drain fires NOTHING foreign (the operator's hazard, dead)",
    q.getDrainableCommands(false).length === 0 && q.getDrainableCommands(true).length === 0 && q.dequeue() === undefined)
  q.enqueue(cmd('for B'))
  check("rekey: B's own words queue normally beside A's parked bank", q.getCommandQueue().map(c => c.value).join(',') === 'for B')
  q.rekeyCommandQueueToSession('session-A')
  check("rekey: the return restores A's words byte-identical (order · queueId)",
    q.getCommandQueue().map(c => c.value).join(',') === 'for A only,also A' &&
      q.getCommandQueue().map(c => c.queueId).join(',') === aIds)
  q.rekeyCommandQueueToSession('session-B')
  check("rekey: B's word waited in B's own bank through the round trip", q.getCommandQueue().map(c => c.value).join(',') === 'for B')

  // 2 THE NOTIFICATION LAW HOLDS: one emit per swap that MOVES entries; a
  //   same-key rekey and an empty↔empty swap are silent (no reroll).
  let emits = 0
  const unEmit = q.subscribeToCommandQueue(() => { emits++ })
  q.rekeyCommandQueueToSession('session-C') // B's word parks; C's bank empty ⇒ ONE commit
  const afterMove = emits
  q.rekeyCommandQueueToSession('session-C') // same key ⇒ silent
  q.rekeyCommandQueueToSession('session-D') // empty ⇒ empty ⇒ silent
  unEmit()
  check('rekey: ONE emit per entry-moving swap; same-key and empty swaps are silent', afterMove === 1 && emits === 1, `afterMove=${afterMove} emits=${emits}`)

  // 3 THE DRAIN CORNER (the ruled bound): entries the turn machine
  //   snapshotted (markDraining) STAY live at the swap so its exactly-once
  //   reference-identity remove finds them; a reference removed while
  //   PARKED is swept from the bank — consumed words never resurrect.
  q.resetCommandQueue()
  q.rekeyCommandQueueToSession('drain-A')
  q.enqueue(cmd('draining'))
  q.enqueue(cmd('parked-behind'))
  const drainingRef = q.getDrainableCommands(false).find(c => c.value === 'draining')!
  q.markDraining([drainingRef])
  q.rekeyCommandQueueToSession('drain-B')
  check('rekey: the drain-window entry STAYS live at the swap (exactly-once remove must find it)',
    q.getCommandQueue().length === 1 && q.getCommandQueue()[0] === drainingRef)
  q.remove([drainingRef])
  check('rekey: …and the in-flight remove consumes it there', q.getCommandQueue().length === 0)
  q.rekeyCommandQueueToSession('drain-A')
  check('rekey: the return restores ONLY the un-drained word — no resurrection', q.getCommandQueue().map(c => c.value).join(',') === 'parked-behind')
  q.resetCommandQueue()
  q.rekeyCommandQueueToSession('bank-A')
  q.enqueue(cmd('to-die-parked'))
  const bankRef = q.getCommandQueue()[0]!
  q.rekeyCommandQueueToSession('bank-B')
  q.remove([bankRef])
  q.rekeyCommandQueueToSession('bank-A')
  check('rekey: a reference removed while parked never resurrects (the bank sweep)', q.getCommandQueue().length === 0)
  q.markDraining([])

  // 4 SUBMIT ORDERING UNCHANGED: priority bands and FIFO survive a
  //   park/restore round trip exactly.
  q.resetCommandQueue()
  q.rekeyCommandQueueToSession('order-A')
  q.enqueue(cmd('n1'))
  q.enqueuePendingNotification(cmd('l1', { mode: 'task-notification' }))
  q.enqueue(cmd('n2'))
  q.rekeyCommandQueueToSession('order-B')
  q.rekeyCommandQueueToSession('order-A')
  check('rekey: submit ordering unchanged across the round trip (now>next>later, FIFO within bands)',
    q.dequeue()?.value === 'n1' && q.dequeue()?.value === 'n2' && q.dequeue()?.value === 'l1')

  // 5 THE WIRING: the REPL hop effect re-keys the queue at the SAME swap
  //   moment as the draft store (mount-skip guarded — the W4 sibling law).
  const replSrc = readFileSync('src/screens/REPL.tsx', 'utf8')
  const hopBlock = replSrc.slice(replSrc.indexOf('rekeyedSessionRef.current !== focusedSessionId'))
  check('rekey: the REPL hop effect re-keys the queue beside pending-input, inside the same guard',
    hopBlock.slice(0, 600).includes("rekeyCommandQueueToSession(focusedSessionId === '' ? null : focusedSessionId)") &&
      hopBlock.includes('pendingInput.rekeyToSession') &&
      hopBlock.indexOf('pendingInput.rekeyToSession') < hopBlock.indexOf('rekeyCommandQueueToSession(focusedSessionId'))

  q.resetCommandQueue()
}

// ════════════════════════════════════════════════════════════════════════════
// B — DRAFT-DURABILITY (promptDraft over the hermetic home)
// ════════════════════════════════════════════════════════════════════════════
{
  const draftDir = join(HERMETIC_HOME, 'drafts')
  const draftFileRaw = (): Record<string, { text?: string; savedAt?: number }> => {
    if (!existsSync(draftDir)) return {}
    for (const f of require('node:fs').readdirSync(draftDir) as string[]) {
      if (f.endsWith('.json')) return JSON.parse(readFileSync(join(draftDir, f), 'utf8'))
    }
    return {}
  }
  const mk = (text: string, extra: Partial<{ cursorOffset: number; mode: string; pastedContents: Record<number, unknown> }> = {}) => ({
    text,
    cursorOffset: extra.cursorOffset ?? text.length,
    mode: extra.mode ?? 'prompt',
    pastedContents: (extra.pastedContents ?? {}) as never,
  })

  // Debounce: no synchronous write; flushDraftSaves() lands it; exact
  // round-trip through the sync boot seed (the store's one read path).
  draft.saveDraftDebounced('sess-A', mk('hello wor', { cursorOffset: 5, mode: 'bash' }))
  check('draft: a debounced save writes nothing synchronously', draft.readDraftSync('sess-A') === null)
  await draft.flushDraftSaves()
  const a1 = draft.readDraftSync('sess-A')
  check('draft: flush lands the exact draft (text/cursor/mode)',
    a1?.text === 'hello wor' && a1?.cursorOffset === 5 && a1?.mode === 'bash', JSON.stringify(a1))

  // Coalesce: the pending save is last-write-wins within one session.
  draft.saveDraftDebounced('sess-A', mk('hello w'))
  draft.saveDraftDebounced('sess-A', mk('hello world'))
  await draft.flushDraftSaves()
  check('draft: same-session saves coalesce to the last write', draft.readDraftSync('sess-A')?.text === 'hello world')

  // OWNING-SESSION capture: a pending save for a DIFFERENT session flushes
  // immediately on the next save — a fast A→B switch never drops A's last
  // keystrokes, and each draft lands under the session the keystrokes
  // belonged to. (Same-process store mutations serialize on the fileStore
  // chain, so awaiting B's flush orders A's before it.)
  draft.saveDraftDebounced('sess-A', mk('alpha keystrokes'))
  draft.saveDraftDebounced('sess-B', mk('beta keystrokes'))
  await draft.flushDraftSaves()
  const aOwned = draft.readDraftSync('sess-A')
  const bOwned = draft.readDraftSync('sess-B')
  check('draft: mid-debounce session switch credits the SOURCE session', aOwned?.text === 'alpha keystrokes')
  check('draft: the new session\'s keystrokes land under the new session', bOwned?.text === 'beta keystrokes')

  // EMPTY-DRAFT-DELETE: an empty save DELETES the entry (submit clears the
  // prompt — a submitted draft can never resurrect). Whitespace-only text
  // with no pastes counts as empty.
  draft.saveDraftDebounced('sess-A', mk(''))
  await draft.flushDraftSaves()
  check('draft: an empty save deletes the entry', draft.readDraftSync('sess-A') === null && !('sess-A' in draftFileRaw()))
  draft.saveDraftDebounced('sess-WS', mk('   \n  '))
  await draft.flushDraftSaves()
  check('draft: whitespace-only counts as empty (never created)', !('sess-WS' in draftFileRaw()))
  const beforeNoop = JSON.stringify(draftFileRaw())
  draft.saveDraftDebounced('sess-ABSENT', mk(''))
  await draft.flushDraftSaves()
  check('draft: an empty save for an absent session is a no-op publish', JSON.stringify(draftFileRaw()) === beforeNoop)

  // cancelPendingDraftSave + the submit ordering (REPL.tsx:3535-3536):
  // cancel the pending keystroke save FIRST, then delete — a late flush can
  // never resurrect the just-submitted draft.
  draft.saveDraftDebounced('sess-C', mk('never lands'))
  draft.cancelPendingDraftSave()
  await draft.flushDraftSaves()
  check('draft: cancelPendingDraftSave drops the pending save', draft.readDraftSync('sess-C') === null)
  draft.saveDraftDebounced('sess-D', mk('persisted earlier'))
  await draft.flushDraftSaves()
  draft.saveDraftDebounced('sess-D', mk('typed during submit race'))
  draft.cancelPendingDraftSave()
  draft.deleteDraft('sess-D')
  // deleteDraft is fire-and-forget; a follow-up mutation SERIALIZES behind it
  // on the same-process store chain (fileStore.ts:253) — the empty save is a
  // no-op publish, so awaiting it is a pure ordering barrier.
  draft.saveDraftDebounced('sess-D', mk(''))
  await draft.flushDraftSaves()
  check('draft: submit\'s cancel-then-delete leaves nothing to resurrect', draft.readDraftSync('sess-D') === null)

  // SHED (characterized): when the SERIALIZED draft exceeds 256KB, EVERY
  // paste is shed — including small ones riding alongside — each recorded in
  // missingPastes ('pasted text #k' / 'pasted image #k'); the text survives.
  draft.saveDraftDebounced('sess-BIG', mk('text survives the shed', {
    pastedContents: {
      1: { id: 1, type: 'text', content: 'x'.repeat(300_000) },
      2: { id: 2, type: 'image', content: 'tiny', mediaType: 'image/png', filename: 'small.png' },
    },
  }))
  await draft.flushDraftSaves()
  const big = draft.readDraftSync('sess-BIG')
  check('draft: oversized draft keeps the text', big?.text === 'text survives the shed')
  check('draft QUIRK: the shed drops ALL pastes, not just the oversized one',
    big !== null && Object.keys(big.pastedContents).length === 0)
  check('draft: missingPastes names both shed payloads honestly',
    JSON.stringify(big?.missingPastes) === JSON.stringify(['pasted text #1', 'pasted image #2']), JSON.stringify(big?.missingPastes))

  // MAX_DRAFTS=20 eviction by savedAt (oldest out). savedAt is captured via
  // Date.now() at saveDraftDebounced time — patched per save for a strict
  // total order, restored before each flush.
  const realNow = Date.now
  const base = realNow()
  for (let i = 0; i < 21; i++) {
    Date.now = () => base + i * 1000
    draft.saveDraftDebounced(`evict-${i}`, mk(`draft ${i}`))
    Date.now = realNow
    await draft.flushDraftSaves()
  }
  const rawAll = draftFileRaw()
  check('draft: the 21st session evicts the OLDEST by savedAt', !('evict-0' in rawAll))
  check('draft: the newest 20 all survive', Array.from({ length: 20 }, (_, i) => `evict-${i + 1}` in rawAll).every(Boolean))
  check('draft: the store holds exactly MAX_DRAFTS entries (meta keys _v/_rev excluded)',
    Object.keys(rawAll).filter(k => !k.startsWith('_')).length === 20, JSON.stringify(Object.keys(rawAll)))

  // Sanitize: defaults + per-entry corruption tolerance (the boot seed path).
  const fs = require('node:fs') as typeof import('node:fs')
  const file = fs.readdirSync(draftDir).find(f => f.endsWith('.json'))!
  const path = join(draftDir, file)
  const doc = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>
  doc['sess-DEFAULTS'] = { text: 'bare', savedAt: base }
  doc['sess-BADMODE'] = { text: 'm', savedAt: base, mode: 42, cursorOffset: 'nope' }
  doc['sess-CORRUPT'] = { text: 99, savedAt: base }
  fs.writeFileSync(path, JSON.stringify(doc))
  const d1 = draft.readDraftSync('sess-DEFAULTS')
  check('draft: missing cursorOffset defaults to text end; missing mode to prompt',
    d1?.cursorOffset === 4 && d1?.mode === 'prompt', JSON.stringify(d1))
  const d2 = draft.readDraftSync('sess-BADMODE')
  check('draft: wrong-typed mode/cursor sanitize to defaults', d2?.mode === 'prompt' && d2?.cursorOffset === 1)
  check('draft: a corrupt entry reads as null (fail-soft)', draft.readDraftSync('sess-CORRUPT') === null)
  check('draft: unknown session reads as null', draft.readDraftSync('sess-NEVER') === null)
}

// ════════════════════════════════════════════════════════════════════════════
// C — SEED-CHOKEPOINT
// ════════════════════════════════════════════════════════════════════════════
{
  const key = (over: Partial<Key> = {}): Key => ({
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
    home: false, end: false, return: false, escape: false, ctrl: false,
    shift: false, fn: false, tab: false, backspace: false, delete: false,
    meta: false, super: false, ...over,
  })
  seed.__composerSeedResetForTest()
  const seeds: string[] = []
  seed.registerComposerSeeder(s => seeds.push(s))

  check('seed: unarmed ⇒ never consumes', !seed.trySeedComposer('a', key()) && seeds.length === 0)
  const disarm1 = seed.armComposerSeed()
  check('seed: armed printable seeds through the registered seeder',
    seed.trySeedComposer('a', key()) && seeds.join('') === 'a')
  check('seed: digits stay Select hotkeys (never seed)', !seed.trySeedComposer('2', key()))
  check('seed: whitespace-only never seeds (would not flip isPromptInputActive)', !seed.trySeedComposer('  ', key()))
  check('seed: ctrl-modified input never seeds', !seed.trySeedComposer('a', key({ ctrl: true })))
  check('seed: return never seeds', !seed.trySeedComposer('\r', key({ return: true })))
  check('seed: arrows never seed', !seed.trySeedComposer('x', key({ upArrow: true })))
  check('seed: raw control bytes never seed (slipped ESC fragments)', !seed.trySeedComposer('\u001b[A', key()))
  check('seed: shift-modified printable DOES seed (typed text)', seed.trySeedComposer('A', key({ shift: true })))

  // Overlapping consent cards: arm is COUNTED; each disarm idempotent.
  const disarm2 = seed.armComposerSeed()
  disarm1()
  check('seed: releasing one of two arms keeps the seam armed', seed.trySeedComposer('b', key()))
  disarm1() // double-release of the same arm must not steal the second arm
  check('seed: a double-release is idempotent (StrictMode double-invoke)', seed.trySeedComposer('c', key()))
  disarm2()
  check('seed: releasing the last arm disarms', !seed.trySeedComposer('d', key()))

  // Registration hygiene: a stale unregister never clobbers the live seeder.
  seed.__composerSeedResetForTest()
  const staleUnreg = seed.registerComposerSeeder(() => seeds.push('STALE'))
  const liveSeeds: string[] = []
  seed.registerComposerSeeder(s => liveSeeds.push(s))
  staleUnreg()
  const disarm3 = seed.armComposerSeed()
  check('seed: a stale unregister does not clobber the live seeder',
    seed.trySeedComposer('z', key()) && liveSeeds.join('') === 'z')
  disarm3()
  seed.__composerSeedResetForTest()
}

// ════════════════════════════════════════════════════════════════════════════
// D — RESTORE-EXACTNESS (textForResubmit shape recovery)
// ════════════════════════════════════════════════════════════════════════════
{
  type UM = Parameters<typeof textForResubmit>[0]
  const um = (content: unknown): UM => ({ type: 'user', message: { role: 'user', content }, uuid: 'u-1' }) as never

  check('resubmit: plain prose round-trips as prompt', (() => {
    const r = textForResubmit(um('fix the flaky test'))
    return r?.text === 'fix the flaky test' && r?.mode === 'prompt'
  })())
  check('resubmit: bash-input recovers the !command shape', (() => {
    const r = textForResubmit(um('<bash-input>rg -n "foo" src/</bash-input>'))
    return r?.text === 'rg -n "foo" src/' && r?.mode === 'bash'
  })())
  check('resubmit: command-name + args reconstruct the slash line', (() => {
    const r = textForResubmit(um('<command-name>/party</command-name><command-args>board</command-args>'))
    return r?.text === '/party board' && r?.mode === 'prompt'
  })())
  // QUIRK (characterized): an args-less command reconstructs WITH a trailing
  // space — `${cmd} ${'' }` — the composer receives '/party '.
  check('resubmit QUIRK: an args-less command carries a trailing space', (() => {
    const r = textForResubmit(um('<command-name>/party</command-name>'))
    return r?.text === '/party ' && r?.mode === 'prompt'
  })())
  check('resubmit: IDE context tags are stripped, user HTML survives', (() => {
    const r = textForResubmit(um('<ide_opened_file>noise</ide_opened_file>keep <code>this</code>'))
    return r?.text === 'keep <code>this</code>'
  })())
  check('resubmit: content-block text extracts', (() => {
    const r = textForResubmit(um([{ type: 'text', text: 'block prose' }]))
    return r?.text === 'block prose' && r?.mode === 'prompt'
  })())
  check('resubmit: a tool-result-only message yields null', textForResubmit(um([{ type: 'tool_result', tool_use_id: 't1', content: [] }])) === null)
}

// ════════════════════════════════════════════════════════════════════════════
// E — SOURCE-LOCKS (REPL.tsx / query.ts / PromptInput.tsx are
//  bun-unloadable — text anchors pin the seams the owner cut must carry;
//  the behavior-level matrix lands with the extracted owner)
// ════════════════════════════════════════════════════════════════════════════
{
  const repoRoot = resolve(import.meta.dir, '../..')
  const repl = readFileSync(join(repoRoot, 'src/screens/REPL.tsx'), 'utf8')
  const query = readFileSync(join(repoRoot, 'src/query.ts'), 'utf8')
  const promptInput = readFileSync(join(repoRoot, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')

  // S2: the chokepoint moved into the pending-input OWNER (loadable —
  // the five-effect ORDER is now a BEHAVIOR LAW in the.S2 section
  // below; the source-locks here pin only the REPL-side wiring: the
  // interceptors register with their gates, and setInputValue rides the
  // owner's one edit path).
  // The suggestion intercept is inert on the face (an accepted suggestion
  // rides the plain edit path; the engine that once intercepted it lives in
  // the session's runner).
  check('lock: REPL registers the chokepoint interceptors (intercept + re-pin gate + active flip)',
    repl.includes('pendingInput.registerInterceptors({')
      && repl.includes('interceptSuggestion: () => false')
      && repl.includes('onActiveChange: setIsPromptInputActive'))
  check('lock: empty→nonempty is the re-pin gate (with the recent-scroll window)',
    repl.includes('onEmptyToNonempty: () => {')
      && repl.includes('RECENT_SCROLL_REPIN_WINDOW_MS'))
  check('lock: setInputValue rides the owner edit path',
    repl.includes('pendingInput.edit(value)'))

  // The auto-restore five-guard conjunction stays the owner's PURE predicate
  // (shouldAutoRestore — matrix-proved in S4 below). The face runs no
  // restore of its own: esc reaches the session's runner, whose interrupted
  // turn keeps the words as a sent row — the composer-restore door for a
  // managed session is a named follow-up, and its return here is a
  // deliberate, prover-updating act.
  check('lock: the face runs no auto-restore (no shouldAutoRestore call, no history rewind in the screen)',
    !repl.includes('shouldAutoRestore(') && !repl.includes('removeLastFromHistory'))
  check('lock: esc reaches the focused session through its connector (the one interrupt door)',
    repl.includes('getFocusedSessionConnector().interrupt()'))

  // Submit clears the durable draft deterministically (S3: the owner's
  // clearForSubmit — cancel FIRST, delete second; REPL calls the verb).
  const ownerSrc = readFileSync(join(repoRoot, 'src/input-core/pending-input.ts'), 'utf8')
  const cancelIdx = ownerSrc.indexOf('cancelPendingDraftSave()')
  // W4 re-key: the delete keys by the OWNING session (the bootstrap id
  // does not follow the focused slot) — the cancel-then-delete lock holds.
  const deleteIdx = ownerSrc.indexOf('deleteDraft(owningSessionId ?? getSessionId())', cancelIdx)
  check('lock: submit cancels the pending save then deletes the draft (owner clearForSubmit)',
    cancelIdx !== -1 && deleteIdx !== -1 && deleteIdx - cancelIdx < 700
      && repl.includes('pendingInput.clearForSubmit(input);'))
  // S3: the owner is promptDraft's ONLY writer (the grep-lock).
  check('lock: saveDraftDebounced is imported ONLY by the pending-input owner',
    !repl.includes('saveDraftDebounced') && !promptInput.includes('saveDraftDebounced(')
      && ownerSrc.includes('saveDraftDebounced('))
  check('lock: PromptInput reports the durable cursor to the owner',
    /pendingInput\.reportCursor\(\w+\)/.test(promptInput))

  // SUBMIT-CAPTURE: the owner's
  // setters are SYNCHRONOUS module-store writes — the submitsNow resets
  // (setInputMode('prompt') / setPastedContents({})) land before
  // handlePromptSubmit reads, so a LIVE mode/pastedContents read inside
  // onSubmit routes a bang shell as a prompt and drops pasted content. The
  // law: onSubmit captures both AT ENTRY and the body never live-reads them
  // again. The behavioral pin is scripts/ui/prove-tasks-mission.ts leg B.
  const onSubmitStart = repl.indexOf('const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers')
  check('lock: onSubmit exists at the expected shape', onSubmitStart !== -1)
  const captureIdx = repl.indexOf('const seatMode = pendingInput.mode();', onSubmitStart)
  const capturePasteIdx = repl.indexOf('const seatPastes = pendingInput.pastedContents();', onSubmitStart)
  const resetIdx = repl.indexOf("setInputMode('prompt');", onSubmitStart)
  // Proximity bound re-anchored: onSubmit's entry
  // now opens with the documented Enter-boundary capture (`pulseEnterAt`
  // + comment, ~340 chars) BEFORE the mode/paste capture — the law (capture at
  // entry, before any submitsNow reset, no live re-read) is unchanged; only
  // the window widens to admit the preamble. Widened again
  // (the follow gate): a pure reader-mode early-return (~650 chars,
  // no capture, no reset, nothing executes) now precedes the stamp —
  // the capture-before-reset law itself is untouched.
  check('lock: onSubmit captures mode + pastedContents at entry, before the submitsNow reset',
    captureIdx !== -1 && capturePasteIdx !== -1 && resetIdx !== -1
      && captureIdx < resetIdx && capturePasteIdx < resetIdx
      && captureIdx - onSubmitStart < 2100)
  const onSubmitBody = repl.slice(captureIdx, repl.indexOf('const onSubmitRef = useRef(onSubmit);', onSubmitStart))
  check('lock: no live pendingInput.mode()/pastedContents() read survives in the onSubmit body',
    !onSubmitBody.slice(200).includes('pendingInput.mode()')
      && !onSubmitBody.slice(200).includes('pendingInput.pastedContents()'))
  // The words reach the session through the focused connector's send door
  // with the captured mode and pastes (the runner's own submit path reads
  // them from the envelope, never live).
  check('lock: the session send receives the captured values',
    onSubmitBody.includes('.sendWords(text, {')
      && onSubmitBody.includes('mode: seatMode,')
      && onSubmitBody.includes('pastedContents: seatPastes,'))

  // A hop never touches the composer: views are not sessions, so the draft
  // stays where the operator left it (no per-session draft swap, no
  // cross-session read on the face).
  check('lock: a hop never reads or flushes another session\'s draft',
    !repl.includes('readDraftFor(') && !repl.includes('flushDrafts('))

  // A submit under a live turn rides the session door: the runner queues
  // or steers it and answers with a receipt; a refused receipt hands the
  // words back — the face never double-submits and holds no query guard.
  const sendIdx = repl.indexOf('.sendWords(text, {', onSubmitStart)
  const receiptBlock = repl.slice(sendIdx, sendIdx + 900)
  check('lock: a submit rides the session door and a refused receipt returns the words',
    sendIdx !== -1 && !repl.includes('queryGuard') && receiptBlock.includes("receipt.state !== 'refused'") && receiptBlock.includes("if (pendingInput.text() === '') setInputValue(input);"))

  // The composer seeder registration rides the SAME chokepoint.
  check('lock: the composer seeder appends through the owner chokepoint',
    repl.includes('registerComposerSeeder(seed => pendingInput.append(seed))'))

  // (The queued-pop call site is RETIRED — the pen died with the
  // steer-removal ruling. POISON: its return must arrive with its
  // mode-restore discipline or this lock reds.)
  check('lock: the queued-pop call site stays retired (or returns WITH its mode restore)',
    !repl.includes('popAllEditable(') ||
      (repl.includes('popAllEditable(pendingInput.text(), 0)') && repl.includes(`setInputMode('prompt');`)))

  // S5 — the descent acceptance: the REPL ROOT holds no composer
  // subscription (keystrokes never re-render it); the subscribers are the
  // leaves that need the live value (PromptInput + the open surveys).
  check('lock: the REPL root holds NO composer subscription',
    !repl.includes('useSyncExternalStore(pendingInput.'))
  check('lock: PromptInput is the composer subscriber (input · mode · pastes · stash)',
    promptInput.includes('useSyncExternalStore(\n    pendingInput.subscribePendingInput,')
      && ['pendingInput.text()', 'pendingInput.mode()', 'pendingInput.pastedContents()', 'pendingInput.stashedPrompt()']
        .every(read => promptInput.includes(read)))

  // The T8 mid-turn drain consumes by identity through the module API —
  // re-anchored twice (S2c extraction, then the T8 TurnMachine cut moved
  // the drain wiring into run-core/turn-machine.ts): the snapshot reads
  // the queue owner's band view (getDrainableCommands) and the removal
  // rides the attachment-drain owner's removeFromQueue effect
  // (run-core/attachment-drain.ts, whose consumeDrainedCommands filters to
  // prompt/task-notification and removes the SNAPSHOT OBJECTS by identity).
  const turnMachine = readFileSync(join(repoRoot, 'src/run-core/turn-machine.ts'), 'utf8')
  check('lock: the steering drain snapshots through the queue-owned band view and removes by identity',
    // re-audit: band semantics moved INTO the queue owner
    // (getDrainableCommands — the sleep boundary wakes task-notifications
    // only), so the drain lock follows its subject there. Consumption
    // re-anchored once more (the delivery law): consumeDrainedCommands now
    // runs in the drain's own finally — teardown-atomic with the mark
    // clear, over the yielded subset on teardown and the whole snapshot on
    // completion.
    turnMachine.includes('getDrainableCommands(sleepRan)') && turnMachine.includes('...consumeDrainedCommands(')
      && turnMachine.includes('? queuedCommandsSnapshot')
      && readFileSync('src/run-core/attachment-drain.ts', 'utf8').includes('effects.removeFromQueue(consumed)'))

  // (S3: the per-edit debounced save moved into the owner's mutation
  //  verbs — the writer-exclusivity grep-lock above replaced the old
  //  "PromptInput writes the debounced draft" pin.)
}

// ════════════════════════════════════════════════════════════════════════════
// S2 — the pending-input OWNER's chokepoint behavior laws (the
//  source-locked effect ORDER, now proven over the loadable module —
//  src/input-core/pending-input.ts)
// ════════════════════════════════════════════════════════════════════════════
{
  const pi = await import('../../src/input-core/pending-input.ts')
  pi.resetPendingInputForTests()
  pi.initOnce({ text: '', mode: 'prompt', pastedContents: {} })
  const journal: string[] = []
  let consumeNext = false
  pi.registerInterceptors({
    interceptSuggestion: (prev, next) => {
      journal.push(`intercept:${prev}->${next}`)
      return consumeNext
    },
    onEmptyToNonempty: () => journal.push('empty->nonempty'),
    onActiveChange: a => journal.push(`active:${a}`),
  })

  pi.edit('a')
  check('choke: order — intercept ≺ empty→nonempty ≺ commit ≺ active flip',
    journal[0] === 'intercept:->a' && journal[1] === 'empty->nonempty'
      && journal[2] === 'active:true' && pi.text() === 'a',
    JSON.stringify(journal))

  journal.length = 0
  pi.edit('ab')
  check('choke: nonempty→nonempty never fires the re-pin transition',
    !journal.includes('empty->nonempty') && pi.text() === 'ab', JSON.stringify(journal))

  journal.length = 0
  consumeNext = true
  pi.edit('SWALLOWED')
  check('choke: a consuming intercept leaves the store untouched (no commit, no flip)',
    pi.text() === 'ab' && journal.length === 1 && journal[0] === 'intercept:ab->SWALLOWED',
    JSON.stringify({ text: pi.text(), journal }))
  consumeNext = false

  journal.length = 0
  pi.edit('')
  check('choke: clearing flips active:false and never fires the transition',
    journal.includes('active:false') && !journal.includes('empty->nonempty'),
    JSON.stringify(journal))

  journal.length = 0
  pi.append('X')
  check('choke: append() rides the SAME chokepoint (seed = edit(text + seed))',
    pi.text() === 'X' && journal[0] === 'intercept:->X' && journal.includes('empty->nonempty'),
    JSON.stringify(journal))

  // The suppression un-suppress timer moved INTO the owner (the old REPL
  // useEffect keyed on [inputValue]) — after the last keystroke it fires
  // active:false once, real-timer verified.
  journal.length = 0
  pi.edit('typing')
  await new Promise(r => setTimeout(r, 1700))
  check('choke: the suppression timer un-suppresses after the typing pause',
    journal.filter(e => e === 'active:false').length === 1,
    JSON.stringify(journal))

  pi.initOnce({ text: 'CLOBBER', mode: 'bash', pastedContents: {} })
  check('choke: initOnce is idempotent (a StrictMode double-mount seeds once)',
    pi.text() === 'typing' && pi.mode() === 'prompt')

  pi.resetPendingInputForTests()
}

// ════════════════════════════════════════════════════════════════════════════
// S4 — the auto-restore five-guard MATRIX + stash/staged accounting
//  (the pure predicate + the NO-LOST-INPUT / NO-DOUBLE-SUBMIT laws over
//  the loadable owner + queue)
// ════════════════════════════════════════════════════════════════════════════
{
  const pi = await import('../../src/input-core/pending-input.ts')
  const cq = await import('../../src/input-core/command-queue.ts')
  pi.resetPendingInputForTests()
  cq.resetCommandQueue()
  pi.initOnce({ text: '', mode: 'prompt', pastedContents: {} })

  const ALL_TRUE = { reason: 'user-cancel', queryActive: false, queueLength: 0, viewingAgent: false }
  check('restore-matrix 1: all five guards true ⇒ restore', pi.shouldAutoRestore(ALL_TRUE))
  check('restore-matrix 2: a steer/interrupt reason never restores',
    !pi.shouldAutoRestore({ ...ALL_TRUE, reason: 'interrupt' }) && !pi.shouldAutoRestore({ ...ALL_TRUE, reason: undefined }))
  check('restore-matrix 3: an active turn never restores', !pi.shouldAutoRestore({ ...ALL_TRUE, queryActive: true }))
  pi.edit('typed since')
  check('restore-matrix 4: typed-during-loading never restores (composer nonempty)', !pi.shouldAutoRestore(ALL_TRUE))
  pi.edit('')
  check('restore-matrix 5: a queued follow-up owns the next turn (never restores)',
    !pi.shouldAutoRestore({ ...ALL_TRUE, queueLength: 1 }))
  check('restore-matrix 6: viewing a teammate never restores', !pi.shouldAutoRestore({ ...ALL_TRUE, viewingAgent: true }))

  // NO-DOUBLE-SUBMIT + staged accounting: clearForSubmit stamps the staged
  // record; settling (turn start OR concurrent enqueue) clears it exactly
  // once; the text is never simultaneously staged AND queued.
  pi.edit('ship it')
  pi.clearForSubmit('ship it')
  check('staged: clearForSubmit stamps the record', pi.stagedSubmit()?.text === 'ship it')
  cq.enqueue({ mode: 'prompt', value: 'ship it' } as never)
  pi.clearStaged()
  check('staged: settle-to-queue clears staged; the text has ONE home',
    pi.stagedSubmit() === null && cq.getCommandQueue().filter(c => c.value === 'ship it').length === 1)
  cq.resetCommandQueue()

  // NO-LOST-INPUT: a scripted sequence over {draft, stash, staged, queue} —
  // at every step each character set lives in exactly one home.
  const homes = (): Record<string, number> => {
    const inDraft = pi.text() ? 1 : 0
    const inStash = pi.stashedPrompt()?.text ? 1 : 0
    const inStaged = pi.stagedSubmit()?.text ? 1 : 0
    const inQueue = cq.getCommandQueue().length
    return { inDraft, inStash, inStaged, inQueue }
  }
  pi.edit('alpha')
  check('no-lost 1: typed text lives in the draft alone',
    JSON.stringify(homes()) === JSON.stringify({ inDraft: 1, inStash: 0, inStaged: 0, inQueue: 0 }))
  pi.setStash({ text: pi.text(), cursorOffset: 2, pastedContents: {} })
  pi.edit('')
  check('no-lost 2: stashing moves the text draft→stash',
    JSON.stringify(homes()) === JSON.stringify({ inDraft: 0, inStash: 1, inStaged: 0, inQueue: 0 })
      && pi.stashedPrompt()?.text === 'alpha')
  const st = pi.stashedPrompt()!
  pi.edit(st.text)
  pi.setStash(undefined)
  check('no-lost 3: unstash round-trips stash→draft (cursor carried)',
    pi.text() === 'alpha' && st.cursorOffset === 2
      && JSON.stringify(homes()) === JSON.stringify({ inDraft: 1, inStash: 0, inStaged: 0, inQueue: 0 }))
  pi.clearForSubmit(pi.text())
  pi.edit('')
  check('no-lost 4: submit moves the text draft→staged',
    JSON.stringify(homes()) === JSON.stringify({ inDraft: 0, inStash: 0, inStaged: 1, inQueue: 0 }))
  pi.clearStaged()
  check('no-lost 5: turn-start settles staged (the turn owns it now)',
    JSON.stringify(homes()) === JSON.stringify({ inDraft: 0, inStash: 0, inStaged: 0, inQueue: 0 }))

  pi.resetPendingInputForTests()
  cq.resetCommandQueue()
}

// ════════════════════════════════════════════════════════════════════════════
// the shared fake-timer wheel
// ════════════════════════════════════════════════════════════════════════════
type Wheel = {
  clock: SchedulerClock
  timer: (tag: string) => { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void }
  pending: (tag?: string) => number
  advance: (ms: number) => void
  flushMicro: () => void
  now: () => number
}
function makeWheel(): Wheel {
  let now = 0
  let nextId = 1
  type T = { at: number; fn: () => void; id: number; tag: string }
  let timers: T[] = []
  const micro: Array<() => void> = []
  const flushMicro = (): void => {
    while (micro.length > 0) micro.shift()!()
  }
  const set = (tag: string) => (fn: () => void, ms: number): unknown => {
    const id = nextId++
    timers.push({ at: now + ms, fn, id, tag })
    return id
  }
  const clear = (h: unknown): void => {
    timers = timers.filter(t => t.id !== h)
  }
  const advance = (ms: number): void => {
    const target = now + ms
    for (;;) {
      const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      timers = timers.filter(t => t.id !== due.id)
      now = due.at
      due.fn()
      flushMicro()
    }
    now = target
    flushMicro()
  }
  return {
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => set('sched')(fn, ms) as never,
      clearTimeout: h => clear(h as never),
      queueMicrotask: fn => {
        micro.push(fn)
      },
    },
    timer: tag => ({ set: set(tag), clear }),
    pending: tag => timers.filter(t => !tag || t.tag === tag).length,
    advance,
    flushMicro,
    now: () => now,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// F — BOUNDED-QUEUES (≤1 pending flush per client, any delta rate;
//  cadence semantics live in prove-stream-commit-throttle / prove-tail-store)
// ════════════════════════════════════════════════════════════════════════════
{
  // StreamBatcher: 200 updates at 1ms cadence — the pending-timer bound
  // holds at EVERY step; the trailing flush lands the complete value.
  const reg = await import('../../src/ink/root/flush-registry.ts')
  const probesBefore = reg.flushProbeCount()
  const w = makeWheel()
  const bt = w.timer('batcher')
  let sunk = ''
  const b = new StreamBatcher<string>('', { sink: v => (sunk = v), setTimer: bt.set, clearTimer: bt.clear })
  // the estate-wide flush REGISTRY (observability only — the scheduler
  // never consults it): construction registers a probe, an armed trailing
  // flush is visible by name, the ≤1 bound holds estate-wide at every step,
  // and dispose unregisters.
  check('registry: batcher construction registers a probe', reg.flushProbeCount() === probesBefore + 1)
  let maxPending = 0
  let maxRegistryPending = 0
  for (let i = 0; i < 200; i++) {
    b.update(cur => cur + 'x')
    maxPending = Math.max(maxPending, w.pending('batcher'))
    for (const p of reg.pendingFlushes()) {
      maxRegistryPending = Math.max(maxRegistryPending, p.pending)
    }
    w.advance(1)
  }
  check('registry: the armed flush is visible by name mid-storm', maxRegistryPending === 1)
  w.advance(20)
  check('registry: the settled estate reports zero pending flushes',
    reg.pendingFlushes().every(p => p.name !== 'stream-batcher'))
  check('bound: the batcher holds ≤1 pending flush across a 200-delta storm', maxPending <= 1, String(maxPending))
  check('bound: the storm settles with zero timers armed', w.pending('batcher') === 0)
  check('bound: the trailing flush carries the complete value', sunk === 'x'.repeat(200) && b.current === sunk)
  check('bound: frame-cadence commits over the storm (~1/16ms)', b.sinkCalls >= 11 && b.sinkCalls <= 14, String(b.sinkCalls))
  b.dispose()
  check('registry: dispose unregisters the probe', reg.flushProbeCount() === probesBefore)

  // updateSilent: zero timers, zero sinks — flushSilent commits exactly once.
  const w2 = makeWheel()
  const bt2 = w2.timer('batcher')
  let silentSinks = 0
  const bs = new StreamBatcher<string>('', { sink: () => silentSinks++, setTimer: bt2.set, clearTimer: bt2.clear })
  for (let i = 0; i < 100; i++) bs.updateSilent(cur => cur + 'y')
  check('bound: silent updates arm nothing and sink nothing', w2.pending('batcher') === 0 && silentSinks === 0)
  bs.flushSilent()
  check('bound: flushSilent commits the accumulation once', silentSinks === 1 && bs.current === 'y'.repeat(100))
  bs.flushSilent()
  check('bound: a clean flushSilent is a no-op', silentSinks === 1)

  // flushNow (a new tool row) consumes the pending trailing timer — the two
  // paths never stack.
  const w3 = makeWheel()
  const bt3 = w3.timer('batcher')
  const rows = new StreamBatcher<string[]>([], {
    sink: () => {},
    flushNow: (prev, next) => prev.length !== next.length,
    setTimer: bt3.set,
    clearTimer: bt3.clear,
  })
  rows.update(cur => [...cur, 'row0']) // length change ⇒ immediate flush
  rows.update(cur => [cur[0] + '.'])   // same length ⇒ trailing armed
  check('bound: a same-length delta arms the one trailing timer', w3.pending('batcher') === 1)
  rows.update(cur => [...cur, 'row1']) // length change mid-window
  check('bound: an immediate flush consumes the pending trailing timer (no stack)', w3.pending('batcher') === 0)
  rows.dispose()
  rows.update(cur => [...cur, 'late'])
  check('bound: a post-dispose update never re-arms', w3.pending('batcher') === 0)

  // streamingTailStore: same ≤1 bound under a 100-delta storm at 1ms.
  const w4 = makeWheel()
  const tt = w4.timer('tail')
  const tail = createStreamingTailStore({ setTimer: tt.set, clearTimer: tt.clear, now: w4.now })
  tail.reset('') // boundary noise out of the way
  let maxTail = 0
  for (let i = 0; i < 100; i++) {
    tail.update(cur => (cur ?? '') + 'z')
    maxTail = Math.max(maxTail, w4.pending('tail'))
    w4.advance(1)
  }
  w4.advance(50)
  check('bound: the tail store holds ≤1 pending publish across the storm', maxTail <= 1, String(maxTail))
  check('bound: the tail settles complete with zero timers', w4.pending('tail') === 0 && tail.getSnapshot() === 'z'.repeat(100))
  tail.update(() => null)
  check('bound: the clear boundary publishes immediately (no timer)', tail.getSnapshot() === null && w4.pending('tail') === 0)
  tail.dispose()
}

// ════════════════════════════════════════════════════════════════════════════
// G — ECHO-PRIORITY (scheduler + batcher + tail on ONE wheel)
// ════════════════════════════════════════════════════════════════════════════
{
  // Scene IDLE: with a stream flush AND a tail publish both armed, an
  // idle-scheduler keystroke paints FIRST, at its own tick (leading edge
  // adds zero latency — the mechanism behind the idle measurement).
  const w = makeWheel()
  const events: Array<{ t: number; kind: string }> = []
  const sched = new RenderScheduler(() => events.push({ t: w.now(), kind: 'echo-paint' }), w.clock)
  const bt = w.timer('batcher')
  const batcher = new StreamBatcher<string>('', {
    sink: () => events.push({ t: w.now(), kind: 'stream-sink' }),
    setTimer: bt.set,
    clearTimer: bt.clear,
  })
  const tt = w.timer('tail')
  const tail = createStreamingTailStore({ setTimer: tt.set, clearTimer: tt.clear, now: w.now })
  w.advance(150) // boot window exits quietly
  tail.reset('base') // publish (setup)
  events.length = 0
  batcher.update(cur => cur + 'delta') // arms the stream sink at now+16
  tail.update(cur => cur + '+')        // mid-interval ⇒ trailing publish armed
  tail.subscribe(() => events.push({ t: w.now(), kind: 'tail-publish' }))
  w.advance(2) // t = 152
  sched.requestFrame() // the keystroke: idle scheduler ⇒ leading edge
  w.flushMicro()
  const echoAt = events.find(e => e.kind === 'echo-paint')?.t
  w.advance(60) // land both nonessential flushes
  const kinds = events.map(e => e.kind)
  check('echo: an idle keystroke paints before every armed nonessential flush',
    kinds[0] === 'echo-paint' && kinds.includes('stream-sink') && kinds.includes('tail-publish'), kinds.join(','))
  check('echo: the idle leading edge adds zero latency', echoAt === 152, String(echoAt))
  check('echo: the nonessential flushes still land after (never starved)',
    events.filter(e => e.kind !== 'echo-paint').every(e => e.t > 152))
  tail.dispose()
  batcher.dispose()

  // Scene OPEN-WINDOW (the CURRENT policy, pinned so T14's FramePriority
  // swap changes it consciously or not at all): a keystroke landing INSIDE
  // an open throttle window waits for the 16ms boundary and COALESCES with
  // stream-driven frame requests into ONE paint — echo latency is bounded
  // by the window remainder, never dropped, never double-painted.
  const w2 = makeWheel()
  const paints: number[] = []
  const sched2 = new RenderScheduler(() => paints.push(w2.now()), w2.clock)
  w2.advance(150)
  sched2.requestFrame() // a stream frame opens the window at t=150
  w2.flushMicro()
  paints.length = 0
  w2.advance(2)
  sched2.requestFrame() // the keystroke at t=152 — inside the open window
  w2.flushMicro()
  check('echo: a keystroke inside an open window does not paint early (current policy)', paints.length === 0)
  w2.advance(8)
  sched2.requestFrame() // a stream commit at t=160 joins the same trailing edge
  w2.advance(20)
  check('echo: window keystroke + stream commit coalesce into ONE boundary paint',
    paints.length === 1 && paints[0] === 150 + FRAME_INTERVAL_MS, JSON.stringify(paints))
  check('echo: the coalesced echo wait is bounded by the frame interval',
    paints[0]! - 152 <= FRAME_INTERVAL_MS, String(paints[0]! - 152))
}

// ════════════════════════════════════════════════════════════════════════════
// H — DISPATCH (real Ink mount over a fake TTY)
// ════════════════════════════════════════════════════════════════════════════
const COLS = 40
const ROWS = 10
class FakeStdout extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  writes: string[] = []
  write(s: string): boolean {
    this.writes.push(s)
    return true
  }
  markerAt(): number {
    return this.writes.length
  }
}
class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  private chunks: string[] = []
  setEncoding(): this {
    return this
  }
  setRawMode(v: boolean): this {
    this.isRaw = v
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  read(): string | null {
    return this.chunks.shift() ?? null
  }
  get readableLength(): number {
    return this.chunks.reduce((n, c) => n + c.length, 0)
  }
  push(data: string): void {
    this.chunks.push(data)
    this.emit('readable')
  }
}
const ESC = '\u001b'
function stripEsc(w: string): string {
  // eslint-disable-next-line no-control-regex
  return w.replace(/\u001b(?:\[[0-9;?<>=$ ]*[a-zA-Z@`]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][0-9A-B])/g, '')
}
function isFrameWrite(w: string): boolean {
  return stripEsc(w).trim().length > 0 || /\u001b\[\d+;\d+H/.test(w) || w === `${ESC}[H` || w.includes(`${ESC}[?2026h`)
}
{
  const stdout = new FakeStdout()
  const stdin = new FakeStdin()
  const ink = new Ink({
    stdout: stdout as never,
    stdin: stdin as never,
    stderr: new FakeStdout() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  instances.set(stdout as never, ink)
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 130))

  const counters = { probe: 0, sibling: 0 }
  const handled: string[] = []
  const InputProbe = (): React.ReactElement => {
    counters.probe++
    const [text, setText] = React.useState('ready')
    useInput((input: string, key: Key) => {
      handled.push(key.upArrow ? '<up>' : key.downArrow ? '<down>' : input)
      setText(prev => `${prev}|${key.upArrow ? 'U' : key.downArrow ? 'D' : input}`)
    })
    return React.createElement(Text, null, `probe ${text}`)
  }
  const Sibling = (): React.ReactElement => {
    counters.sibling++
    return React.createElement(Text, null, 'sibling static row')
  }
  ink.render(
    React.createElement(
      Box,
      { flexDirection: 'column' },
      React.createElement(InputProbe),
      React.createElement(Sibling),
    ),
  )
  await settle()
  check('dispatch: the probe mounted and raw mode armed the readable listener',
    stdin.listeners('readable').length > 0 && stdin.isRaw)

  // DISTINCT-ATOMS: one chunk of four decoded atoms ⇒ four listener
  // invocations, in byte order. Since the TASK-009 fold the dispatch
  // SEGMENTS at each acting named key (arrows here) with the sync work
  // flushed between — an actor always reads the state its same-read
  // predecessors committed (sequential-with-commit-between IS the
  // physical cadence). Four atoms with two actors ⇒ four commits.
  const probe0 = counters.probe
  const sibling0 = counters.sibling
  const m0 = stdout.markerAt()
  stdin.push(`a${ESC}[Ab${ESC}[B`)
  check('dispatch: four atoms in one chunk dispatch four InputEvents in order',
    handled.join(',') === 'a,<up>,b,<down>', handled.join(','))
  await settle()
  check('dispatch: acting keys segment the chunk — text flushes BEFORE each actor reads', counters.probe - probe0 === 4, String(counters.probe - probe0))
  check('dispatch: an input commit never re-renders the sibling subtree', counters.sibling === sibling0, String(counters.sibling - sibling0))
  const chunkFrames = stdout.writes.slice(m0).filter(isFrameWrite)
  check('dispatch: a four-atom chunk paints ≤2 frames (leading+trailing), never per-atom',
    chunkFrames.length >= 1 && chunkFrames.length <= 2, String(chunkFrames.length))

  // PRINTABLE-RUN COALESCE (characterized): a plain text run in one chunk is
  // ONE decoded atom — the decoder coalesces it deliberately (paste-like
  // burst inserts as one edit); the "N key events ⇒ N InputEvents" rule
  // holds at ATOM granularity, and T14's input-priority policy must keep the
  // run atomic or change it consciously.
  handled.length = 0
  stdin.push('xyz')
  check('dispatch QUIRK: a printable run is ONE atom carrying the whole run', handled.join(',') === 'xyz', handled.join(','))
  await settle()

  // Two SEPARATE same-tick chunks: the dispatches stay distinct (two
  // listener invocations) but React batches the two discrete batches into
  // ONE commit (characterized — same-tick discrete updates flush together
  // on the concurrent root); a chunk arriving in a LATER tick commits alone.
  handled.length = 0
  const probe1 = counters.probe
  stdin.push('p')
  stdin.push('q')
  check('dispatch: separate chunks dispatch separately', handled.join(',') === 'p,q', handled.join(','))
  await settle()
  check('dispatch QUIRK: same-tick chunks batch into ONE commit', counters.probe - probe1 === 1, String(counters.probe - probe1))
  const probe2 = counters.probe
  stdin.push('r')
  await settle()
  check('dispatch: a later-tick chunk commits on its own', counters.probe - probe2 === 1, String(counters.probe - probe2))
  check('dispatch: the sibling never re-rendered across the whole journey', counters.sibling === sibling0)

  // NO-BLANK-INTERMEDIATE: replay every frame write cumulatively — no
  // composed frame between two non-empty frames is empty (the in-process leg
  // of the viewport-continuity law, over the input-driven commits).
  // Frame writes only (the T6 alt-screen replay precedent): the raw-mode
  // arming + XTVERSION/DECRQM probe writes carry no grid content and the
  // emulator refuses their query CSIs by design.
  const emu = new AnsiEmulator(COLS, ROWS, false)
  const frameStates: boolean[] = []
  for (const wrt of stdout.writes) {
    if (!isFrameWrite(wrt)) continue
    emu.feed(wrt)
    const grid = Array.from({ length: ROWS }, (_, y) => emu.rowText(y)).join('')
    frameStates.push(grid.trim().length > 0)
  }
  const firstContent = frameStates.indexOf(true)
  const lastContent = frameStates.lastIndexOf(true)
  check('dispatch: no blank intermediate frame across input-driven commits',
    firstContent !== -1 && frameStates.slice(firstContent, lastContent + 1).every(Boolean),
    JSON.stringify(frameStates))
  const finalGrid = Array.from({ length: ROWS }, (_, y) => emu.rowText(y)).join('\n')
  check('dispatch: the final frame carries every dispatched key in order',
    finalGrid.includes('probe ready|a|U|b|D|xyz|p|q') && finalGrid.includes('sibling static row'),
    JSON.stringify(finalGrid.split('\n').slice(0, 2)))

  // Unmount BEFORE the verdict prints: the old body's teardown writes the
  // mode-restore suite via a hard writeSync(1) (the T6 fd-1 finding, LAW
  // TEARDOWN in prove-root-contract) — unavoidable rig noise on this body;
  // unmounting here keeps the verdict as the log's final line.
  const exited = ink.waitUntilExit()
  ink.unmount()
  await exited
}

rmSync(HERMETIC_HOME, { recursive: true, force: true })

if (failures > 0) {
  console.log(`\nnative-core inputsched contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core inputsched contract: green (${checks} checks)`)
// The Ink rig holds signal-exit subscriptions, throttle timers, and the
// querier's unresolved terminal probes — end the process deterministically
// (the prove-root-contract precedent).
process.exit(0)
