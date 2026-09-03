#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SchedulerClock } from '../../src/ink/root/render-scheduler.js'

if (process.env.NODE_ENV === 'test') {
  console.error('prove-inputsched-contract must not run with NODE_ENV=test (lattice bypass)')
  process.exit(1)
}

const HERMETIC_HOME = mkdtempSync(join(tmpdir(), 'native-core-inputsched-'))
process.env.MERCURY_CONFIG_DIR = HERMETIC_HOME
process.env.MERCURY_DAEMON_DIR = join(HERMETIC_HOME, 'daemon')
process.env.MERCURY_TEAMS_DIR = join(HERMETIC_HOME, 'teams')

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

{
  const cmd = (value: string, extra: Partial<QueuedCommand> = {}): QueuedCommand =>
    ({ value, mode: 'prompt', ...extra }) as QueuedCommand

  q.resetCommandQueue()
  q.enqueue(cmd('L1', { priority: 'later' }))
  q.enqueue(cmd('N1', { priority: 'now' }))
  q.enqueue(cmd('X1', { priority: 'next' }))
  q.enqueue(cmd('N2', { priority: 'now' }))
  const order = [q.dequeue()?.value, q.dequeue()?.value, q.dequeue()?.value, q.dequeue()?.value]
  check('queue: dequeue order is now>next>later with FIFO ties', order.join(',') === 'N1,N2,X1,L1', order.join(','))
  check('queue: empty dequeue is undefined', q.dequeue() === undefined)

  q.resetCommandQueue()
  q.enqueue(cmd('user'))
  q.enqueuePendingNotification(cmd('notif', { mode: 'task-notification' }))
  const snap = q.getCommandQueueSnapshot()
  check('queue: enqueue defaults priority next', snap[0]?.priority === 'next', String(snap[0]?.priority))
  check('queue: enqueuePendingNotification defaults priority later', snap[1]?.priority === 'later', String(snap[1]?.priority))

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

  q.resetCommandQueue()
  q.enqueue(cmd('nowA', { priority: 'now' }))
  q.enqueue(cmd('nextA', { priority: 'next' }))
  q.enqueue(cmd('laterA', { priority: 'later' }))
  q.enqueue(cmd('laterN', { mode: 'task-notification', priority: 'later' }))
  check('drain view: plain boundary takes now+next only', q.getDrainableCommands(false).map(c => c.value).join(',') === 'nowA,nextA')
  check('drain view: sleep boundary adds later NOTIFICATIONS only', q.getDrainableCommands(true).map(c => c.value).join(',') === 'nowA,nextA,laterN')
  const live = q.getDrainableCommands(false)
  check('drain view: returns the queue\'s own object references', live[0] === q.getCommandQueue()[0])

  q.resetCommandQueue()
  q.enqueue(cmd('steer me', { priority: 'next' }))
  const drained = q.getDrainableCommands(false)
  q.remove(drained)
  check('drain: identity removal empties the queue', q.getCommandQueue().length === 0)
  q.remove(drained)
  check('drain: re-removing the same references is a no-op', q.getCommandQueue().length === 0)

  for (const dead of ['popAllEditable', 'popNewestEditable', 'isQueuedCommandEditable', 'isQueuedCommandVisible', 'restageNewestPrompt', 'countQueuedPrompts', 'clearCommandQueue']) {
    check(`pen-retired: ${dead} is gone from the queue surface`, !(dead in q))
  }

  check('slash: /cmd is a slash command', q.isSlashCommand(cmd('/cards')))
  check('slash: leading whitespace still classifies', q.isSlashCommand(cmd('  /cards')))
  check('slash: skipSlashCommands opts out (bridge text for the model)', !q.isSlashCommand(cmd('/cards', { skipSlashCommands: true })))
  check('slash: block-array values are never slash commands', !q.isSlashCommand(cmd('x', { value: [{ type: 'text', text: '/cards' }] } as never)))

  q.resetCommandQueue()
  q.enqueue(cmd('agent scoped', { agentId: 'agent-1' } as never))
  q.enqueue(cmd('main scoped'))
  const filtered = q.dequeue(c => (c as { agentId?: string }).agentId === undefined)
  check('queue: filtered dequeue takes the first match and leaves the rest',
    filtered?.value === 'main scoped' && q.getCommandQueue()[0]?.value === 'agent scoped')

  q.resetCommandQueue()
  q.enqueue(cmd('laterB', { priority: 'later' }))
  q.enqueue(cmd('nowB', { priority: 'now' }))
  check('queue: peek returns the highest priority without removing', q.peek()?.value === 'nowB' && q.getCommandQueue().length === 2)

  q.resetCommandQueue()
  q.enqueue(cmd('laterC', { priority: 'later' }))
  q.enqueue(cmd('nowC', { priority: 'now' }))
  const matched = q.dequeueAllMatching(() => true)
  check('queue QUIRK: dequeueAllMatching returns INSERTION order, not priority order',
    matched.map(c => c.value).join(',') === 'laterC,nowC', matched.map(c => c.value).join(','))

  q.resetCommandQueue()
}

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

  const clone = { ...heldRecord }
  q.remove([clone])
  check('identity: an equal-shaped (same-queueId) clone does NOT remove',
    q.getCommandQueue().length === 1)
  q.remove([q.getCommandQueue()[0]!])
  check('identity: the queue-obtained reference removes exactly once',
    q.getCommandQueue().length === 0)

  check('pen-retired: replaceNext is gone from the queue surface', !('replaceNext' in q))

  q.resetCommandQueue()
}

{
  const cmd = (value: string, extra: Partial<QueuedCommand> = {}): QueuedCommand =>
    ({ value, mode: 'prompt', ...extra }) as QueuedCommand

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

  let emits = 0
  const unEmit = q.subscribeToCommandQueue(() => { emits++ })
  q.rekeyCommandQueueToSession('session-C')
  const afterMove = emits
  q.rekeyCommandQueueToSession('session-C')
  q.rekeyCommandQueueToSession('session-D')
  unEmit()
  check('rekey: ONE emit per entry-moving swap; same-key and empty swaps are silent', afterMove === 1 && emits === 1, `afterMove=${afterMove} emits=${emits}`)

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

  q.resetCommandQueue()
  q.rekeyCommandQueueToSession('order-A')
  q.enqueue(cmd('n1'))
  q.enqueuePendingNotification(cmd('l1', { mode: 'task-notification' }))
  q.enqueue(cmd('n2'))
  q.rekeyCommandQueueToSession('order-B')
  q.rekeyCommandQueueToSession('order-A')
  check('rekey: submit ordering unchanged across the round trip (now>next>later, FIFO within bands)',
    q.dequeue()?.value === 'n1' && q.dequeue()?.value === 'n2' && q.dequeue()?.value === 'l1')

  const replSrc = readFileSync('src/screens/REPL.tsx', 'utf8')
  const hopBlock = replSrc.slice(replSrc.indexOf('rekeyedSessionRef.current !== focusedSessionId'))
  check('rekey: the REPL hop effect re-keys the queue beside pending-input, inside the same guard',
    hopBlock.slice(0, 600).includes("rekeyCommandQueueToSession(focusedSessionId === '' ? null : focusedSessionId, { landing })") &&
      hopBlock.includes("pendingInput.rekeyToSession(focusedSessionId === '' ? null : focusedSessionId, { landing })") &&
      hopBlock.indexOf('pendingInput.rekeyToSession') !== -1 &&
      hopBlock.indexOf('rekeyCommandQueueToSession(focusedSessionId') !== -1 &&
      hopBlock.indexOf('pendingInput.rekeyToSession') < hopBlock.indexOf('rekeyCommandQueueToSession(focusedSessionId'))
  check('rekey: the landing word is the slot-fill fact, computed once for both owners',
    replSrc.includes("const landing = rekeyedSessionRef.current === '' && focusedSessionId !== '';"))
  q.resetCommandQueue()
  q.rekeyCommandQueueToSession(null)
  q.enqueue(cmd('queued while landing'))
  q.rekeyCommandQueueToSession('landed-A', { landing: true })
  check('rekey: a landing keeps the entries queued while it landed', q.getCommandQueue().map(c => c.value).join(',') === 'queued while landing')
  q.rekeyCommandQueueToSession('hop-B')
  check('rekey: a hop after the landing still parks them whole', q.getCommandQueue().length === 0)
  q.rekeyCommandQueueToSession('landed-A')
  check('rekey: …and the return restores them', q.getCommandQueue().map(c => c.value).join(',') === 'queued while landing')

  q.resetCommandQueue()
}

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

  draft.saveDraftDebounced('sess-A', mk('hello wor', { cursorOffset: 5, mode: 'bash' }))
  check('draft: a debounced save writes nothing synchronously', draft.readDraftSync('sess-A') === null)
  await draft.flushDraftSaves()
  const a1 = draft.readDraftSync('sess-A')
  check('draft: flush lands the exact draft (text/cursor/mode)',
    a1?.text === 'hello wor' && a1?.cursorOffset === 5 && a1?.mode === 'bash', JSON.stringify(a1))

  draft.saveDraftDebounced('sess-A', mk('hello w'))
  draft.saveDraftDebounced('sess-A', mk('hello world'))
  await draft.flushDraftSaves()
  check('draft: same-session saves coalesce to the last write', draft.readDraftSync('sess-A')?.text === 'hello world')

  draft.saveDraftDebounced('sess-A', mk('alpha keystrokes'))
  draft.saveDraftDebounced('sess-B', mk('beta keystrokes'))
  await draft.flushDraftSaves()
  const aOwned = draft.readDraftSync('sess-A')
  const bOwned = draft.readDraftSync('sess-B')
  check('draft: mid-debounce session switch credits the SOURCE session', aOwned?.text === 'alpha keystrokes')
  check('draft: the new session\'s keystrokes land under the new session', bOwned?.text === 'beta keystrokes')

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

  draft.saveDraftDebounced('sess-C', mk('never lands'))
  draft.cancelPendingDraftSave()
  await draft.flushDraftSaves()
  check('draft: cancelPendingDraftSave drops the pending save', draft.readDraftSync('sess-C') === null)
  draft.saveDraftDebounced('sess-D', mk('persisted earlier'))
  await draft.flushDraftSaves()
  draft.saveDraftDebounced('sess-D', mk('typed during submit race'))
  draft.cancelPendingDraftSave()
  draft.deleteDraft('sess-D')
  draft.saveDraftDebounced('sess-D', mk(''))
  await draft.flushDraftSaves()
  check('draft: submit\'s cancel-then-delete leaves nothing to resurrect', draft.readDraftSync('sess-D') === null)

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

  const disarm2 = seed.armComposerSeed()
  disarm1()
  check('seed: releasing one of two arms keeps the seam armed', seed.trySeedComposer('b', key()))
  disarm1()
  check('seed: a double-release is idempotent (StrictMode double-invoke)', seed.trySeedComposer('c', key()))
  disarm2()
  check('seed: releasing the last arm disarms', !seed.trySeedComposer('d', key()))

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

{
  const repoRoot = resolve(import.meta.dir, '../..')
  const repl = readFileSync(join(repoRoot, 'src/screens/REPL.tsx'), 'utf8')
  const query = readFileSync(join(repoRoot, 'src/query.ts'), 'utf8')
  const promptInput = readFileSync(join(repoRoot, 'src/components/PromptInput/PromptInput.tsx'), 'utf8')

  check('lock: REPL registers the chokepoint interceptors (intercept + re-pin gate + active flip)',
    repl.includes('pendingInput.registerInterceptors({')
      && repl.includes('interceptSuggestion: () => false')
      && repl.includes('onActiveChange: setIsPromptInputActive'))
  check('lock: empty→nonempty is the re-pin gate (with the recent-scroll window)',
    repl.includes('onEmptyToNonempty: () => {')
      && repl.includes('RECENT_SCROLL_REPIN_WINDOW_MS'))
  check('lock: setInputValue rides the owner edit path',
    repl.includes('pendingInput.edit(value)'))

  check('lock: the face runs no auto-restore (no shouldAutoRestore call, no history rewind in the screen)',
    !repl.includes('shouldAutoRestore(') && !repl.includes('removeLastFromHistory'))
  check('lock: esc reaches the focused session through its connector (the one interrupt door)',
    repl.includes('getFocusedSessionConnector().interrupt()'))

  const ownerSrc = readFileSync(join(repoRoot, 'src/input-core/pending-input.ts'), 'utf8')
  const cancelIdx = ownerSrc.indexOf('cancelPendingDraftSave()')
  const deleteIdx = ownerSrc.indexOf('deleteDraft(owningSessionId ?? getSessionId())', cancelIdx)
  check('lock: submit cancels the pending save then deletes the draft (owner clearForSubmit)',
    cancelIdx !== -1 && deleteIdx !== -1 && deleteIdx - cancelIdx < 700
      && repl.includes('pendingInput.clearForSubmit(input);'))
  check('lock: saveDraftDebounced is imported ONLY by the pending-input owner',
    !repl.includes('saveDraftDebounced') && !promptInput.includes('saveDraftDebounced(')
      && ownerSrc.includes('saveDraftDebounced('))
  check('lock: PromptInput reports the durable cursor to the owner',
    /pendingInput\.reportCursor\(\w+\)/.test(promptInput))

  const onSubmitStart = repl.indexOf('const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers')
  check('lock: onSubmit exists at the expected shape', onSubmitStart !== -1)
  const captureIdx = repl.indexOf('const seatMode = pendingInput.mode();', onSubmitStart)
  const capturePasteIdx = repl.indexOf('const seatPastes = pendingInput.pastedContents();', onSubmitStart)
  const resetIdx = repl.indexOf("setInputMode('prompt');", onSubmitStart)
  check('lock: onSubmit captures mode + pastedContents at entry, before the submitsNow reset',
    captureIdx !== -1 && capturePasteIdx !== -1 && resetIdx !== -1
      && captureIdx < resetIdx && capturePasteIdx < resetIdx
      && captureIdx - onSubmitStart < 2100)
  const onSubmitBody = repl.slice(captureIdx, repl.indexOf('const onSubmitRef = useRef(onSubmit);', onSubmitStart))
  check('lock: no live pendingInput.mode()/pastedContents() read survives in the onSubmit body',
    !onSubmitBody.slice(200).includes('pendingInput.mode()')
      && !onSubmitBody.slice(200).includes('pendingInput.pastedContents()'))
  check('lock: the session send receives the captured values',
    onSubmitBody.includes('.sendWords(text, {')
      && onSubmitBody.includes('mode: seatMode,')
      && onSubmitBody.includes('pastedContents: seatPastes,'))

  check('lock: a hop never reads or flushes another session\'s draft',
    !repl.includes('readDraftFor(') && !repl.includes('flushDrafts('))

  const sendIdx = repl.indexOf('.sendWords(text, {', onSubmitStart)
  const receiptBlock = repl.slice(sendIdx, sendIdx + 900)
  check('lock: a submit rides the session door and a refused receipt returns the words',
    sendIdx !== -1 && !repl.includes('queryGuard') && receiptBlock.includes("receipt.state !== 'refused'") && receiptBlock.includes("if (pendingInput.text() === '') setInputValue(input);"))

  check('lock: the composer seeder appends through the owner chokepoint',
    repl.includes('registerComposerSeeder(seed => pendingInput.append(seed))'))

  check('lock: the queued-pop call site stays retired (or returns WITH its mode restore)',
    !repl.includes('popAllEditable(') ||
      (repl.includes('popAllEditable(pendingInput.text(), 0)') && repl.includes(`setInputMode('prompt');`)))

  check('lock: the REPL root holds NO composer subscription',
    !repl.includes('useSyncExternalStore(pendingInput.'))
  check('lock: PromptInput is the composer subscriber (input · mode · pastes · stash)',
    promptInput.includes('useSyncExternalStore(\n    pendingInput.subscribePendingInput,')
      && ['pendingInput.text()', 'pendingInput.mode()', 'pendingInput.pastedContents()', 'pendingInput.stashedPrompt()']
        .every(read => promptInput.includes(read)))

  const turnMachine = readFileSync(join(repoRoot, 'src/run-core/turn-machine.ts'), 'utf8')
  check('lock: the steering drain snapshots through the queue-owned band view and removes by identity',
    turnMachine.includes('getDrainableCommands(sleepRan)') && turnMachine.includes('...consumeDrainedCommands(')
      && turnMachine.includes('? queuedCommandsSnapshot')
      && readFileSync('src/run-core/attachment-drain.ts', 'utf8').includes('effects.removeFromQueue(consumed)'))

}

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

  pi.edit('ship it')
  pi.clearForSubmit('ship it')
  check('staged: clearForSubmit stamps the record', pi.stagedSubmit()?.text === 'ship it')
  cq.enqueue({ mode: 'prompt', value: 'ship it' } as never)
  pi.clearStaged()
  check('staged: settle-to-queue clears staged; the text has ONE home',
    pi.stagedSubmit() === null && cq.getCommandQueue().filter(c => c.value === 'ship it').length === 1)
  cq.resetCommandQueue()

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

{
  const reg = await import('../../src/ink/root/flush-registry.ts')
  const probesBefore = reg.flushProbeCount()
  const w = makeWheel()
  const bt = w.timer('batcher')
  let sunk = ''
  const b = new StreamBatcher<string>('', { sink: v => (sunk = v), setTimer: bt.set, clearTimer: bt.clear })
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

  const w3 = makeWheel()
  const bt3 = w3.timer('batcher')
  const rows = new StreamBatcher<string[]>([], {
    sink: () => {},
    flushNow: (prev, next) => prev.length !== next.length,
    setTimer: bt3.set,
    clearTimer: bt3.clear,
  })
  rows.update(cur => [...cur, 'row0'])
  rows.update(cur => [cur[0] + '.'])
  check('bound: a same-length delta arms the one trailing timer', w3.pending('batcher') === 1)
  rows.update(cur => [...cur, 'row1'])
  check('bound: an immediate flush consumes the pending trailing timer (no stack)', w3.pending('batcher') === 0)
  rows.dispose()
  rows.update(cur => [...cur, 'late'])
  check('bound: a post-dispose update never re-arms', w3.pending('batcher') === 0)

  const w4 = makeWheel()
  const tt = w4.timer('tail')
  const tail = createStreamingTailStore({ setTimer: tt.set, clearTimer: tt.clear, now: w4.now })
  tail.reset('')
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

{
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
  w.advance(150)
  tail.reset('base')
  events.length = 0
  batcher.update(cur => cur + 'delta')
  tail.update(cur => cur + '+')
  tail.subscribe(() => events.push({ t: w.now(), kind: 'tail-publish' }))
  w.advance(2)
  sched.requestFrame()
  w.flushMicro()
  const echoAt = events.find(e => e.kind === 'echo-paint')?.t
  w.advance(60)
  const kinds = events.map(e => e.kind)
  check('echo: an idle keystroke paints before every armed nonessential flush',
    kinds[0] === 'echo-paint' && kinds.includes('stream-sink') && kinds.includes('tail-publish'), kinds.join(','))
  check('echo: the idle leading edge adds zero latency', echoAt === 152, String(echoAt))
  check('echo: the nonessential flushes still land after (never starved)',
    events.filter(e => e.kind !== 'echo-paint').every(e => e.t > 152))
  tail.dispose()
  batcher.dispose()

  const w2 = makeWheel()
  const paints: number[] = []
  const sched2 = new RenderScheduler(() => paints.push(w2.now()), w2.clock)
  w2.advance(150)
  sched2.requestFrame()
  w2.flushMicro()
  paints.length = 0
  w2.advance(2)
  sched2.requestFrame()
  w2.flushMicro()
  check('echo: a keystroke inside an open window does not paint early (current policy)', paints.length === 0)
  w2.advance(8)
  sched2.requestFrame()
  w2.advance(20)
  check('echo: window keystroke + stream commit coalesce into ONE boundary paint',
    paints.length === 1 && paints[0] === 150 + FRAME_INTERVAL_MS, JSON.stringify(paints))
  check('echo: the coalesced echo wait is bounded by the frame interval',
    paints[0]! - 152 <= FRAME_INTERVAL_MS, String(paints[0]! - 152))
}

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

  handled.length = 0
  stdin.push('xyz')
  check('dispatch QUIRK: a printable run is ONE atom carrying the whole run', handled.join(',') === 'xyz', handled.join(','))
  await settle()

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
process.exit(0)
