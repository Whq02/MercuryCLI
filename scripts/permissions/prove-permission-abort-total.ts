#!/usr/bin/env bun
// ============================================================================
//  prove-permission-abort-total — cancellation & permission arbitration is
//  TOTAL: every interactive permission promise settles when its turn's
//  AbortSignal aborts, even if the dialog was suppressed (user typing),
//  unmounted, hidden behind another surface, or removed from the queue.
//
//  Repro class:
//   - handleInteractivePermission wiring settlement ONLY through queue-entry
//     callbacks. A suppressed dialog + Esc/Ctrl+C wiped the queue without
//     calling onAbort → the useCanUseTool promise hung forever (orphaned
//     resolver; tool executor wedged; interrupt marker never justified).
//   - REPL onCancel aborted only toolUseConfirmQueue[0]; entries 2..n leaked.
//   - CancelRequestHandler cleared the queue with NO settlement at all, and
//     swallowed Esc during an MCP elicitation (stopImmediatePropagation in
//     the keybinding layer) while wiping unrelated pending asks.
//
//  Behavioral proofs drive the real handleInteractivePermission with a real
//  AbortController; structural pins hold the REPL/CancelRequestHandler wiring
//  (REPL.tsx is not bun-loadable — Ink/JSX).
// ============================================================================
import { readFileSync } from 'node:fs'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const { handleInteractivePermission } = await import(
  '../../src/hooks/toolPermission/handlers/interactiveHandler.ts'
)

type QueueEntry = {
  toolUseID: string
  onAbort: () => void
  onAllow: (
    updatedInput: Record<string, unknown>,
    updates: unknown[],
  ) => Promise<void> | void
  onReject: (feedback?: string) => void
}

function makeHarness() {
  const ac = new AbortController()
  const queue: QueueEntry[] = []
  const resolutions: unknown[] = []
  const ctx = {
    tool: { name: 'FakeTool' },
    input: { fake: true },
    toolUseContext: {
      abortController: ac,
      agentId: undefined,
      getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    },
    assistantMessage: { message: { id: 'msg-1' } },
    messageId: 'msg-1',
    toolUseID: 'tu-1',
    pushToQueue(item: QueueEntry) {
      queue.push(item)
    },
    removeFromQueue() {
      const i = queue.findIndex(e => e.toolUseID === 'tu-1')
      if (i !== -1) queue.splice(i, 1)
    },
    updateQueueItem() {},
    logCancelled() {},
    logDecision() {},
    cancelAndAbort(_feedback?: string, isAbort?: boolean) {
      if (isAbort) ac.abort()
      return { behavior: 'ask', message: 'INTERRUPTED_SENTINEL' }
    },
    async handleUserAllow(updatedInput: Record<string, unknown>) {
      return { behavior: 'allow', updatedInput }
    },
    buildAllow(updatedInput: Record<string, unknown>) {
      return { behavior: 'allow', updatedInput }
    },
    async runHooks() {
      return null
    },
  }
  const start = () =>
    handleInteractivePermission(
      {
        ctx: ctx as never,
        description: 'fake',
        result: { behavior: 'ask', message: '' } as never,
        // true ⇒ skip the async PermissionRequest-hook race — these proofs
        // isolate the abort/user arbitration.
        awaitAutomatedChecksBeforeDialog: true,
        channelCallbacks: undefined,
      },
      (decision: unknown) => resolutions.push(decision),
    )
  return { ac, queue, resolutions, start }
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

console.log('— behavioral: settle-on-abort is total —')
{
  // 1. Suppressed dialog (no callback ever invoked) + turn abort → the
  //    promise settles, the queue entry is removed, exactly once.
  const h = makeHarness()
  h.start()
  t('ask queued', h.queue.length === 1)
  t('unsettled while pending', h.resolutions.length === 0)
  h.ac.abort()
  await tick()
  t(
    'turn abort settles a suppressed ask',
    h.resolutions.length === 1,
    `resolutions=${h.resolutions.length}`,
  )
  t(
    'settlement is the interruption decision',
    (h.resolutions[0] as { message?: string })?.message ===
      'INTERRUPTED_SENTINEL',
  )
  t('queue entry removed on abort', h.queue.length === 0)
  h.ac.abort() // idempotent — no double settle
  await tick()
  t('no double settlement on repeat abort', h.resolutions.length === 1)
}
{
  // 2. Abort racing Allow — whichever claims first wins; exactly one
  //    resolution either way.
  const h = makeHarness()
  h.start()
  const entry = h.queue[0]!
  void entry.onAllow({ fake: true }, [])
  h.ac.abort()
  await tick()
  t('allow-then-abort resolves exactly once', h.resolutions.length === 1)
  t(
    'allow won the race',
    (h.resolutions[0] as { behavior?: string })?.behavior === 'allow',
  )

  const h2 = makeHarness()
  h2.start()
  const entry2 = h2.queue[0]!
  h2.ac.abort()
  void entry2.onAllow({ fake: true }, [])
  await tick()
  t('abort-then-allow resolves exactly once', h2.resolutions.length === 1)
  t(
    'abort won the race',
    (h2.resolutions[0] as { message?: string })?.message ===
      'INTERRUPTED_SENTINEL',
  )
}
{
  // 3. Signal already aborted when the interactive handler is reached
  //    (abort landed in the async gap after the last resolveIfAborted check).
  const h = makeHarness()
  h.ac.abort()
  h.start()
  await tick()
  t('already-aborted signal settles immediately', h.resolutions.length === 1)
  t('no queue residue for a dead turn', h.queue.length === 0)
}
{
  // 4. Reject still settles once with the abort listener armed.
  const h = makeHarness()
  h.start()
  h.queue[0]!.onReject()
  h.ac.abort()
  await tick()
  t('reject-then-abort resolves exactly once', h.resolutions.length === 1)
}

console.log('— structural: REPL / CancelRequestHandler wiring —')
const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
const cancel = readFileSync('src/hooks/useCancelRequest.ts', 'utf8')

// The screen is the FACE over the focused chat: esc reaches the session
// through its connector's interrupt door; the session's runner settles its
// own pending asks when its turn stops (the asks feed empties), and the
// screen's consent cards fold from that feed — no ask store of the screen's
// own to sweep.
const connector = readFileSync('src/services/engine-connector/daemonConnector.ts', 'utf8')
t(
  "the screen's cancel reaches the focused connector's interrupt door (no ask store of its own)",
  repl.includes('getFocusedSessionConnector().interrupt()') &&
    !repl.includes('getInProcessAsks') &&
    connector.includes('interrupt(): boolean'),
)
t(
  "the cancel handler reaches the same door (settle-every-ask-then-cancel is the session's law)",
  cancel.includes('getFocusedSessionConnector().interrupt()'),
)
t(
  'CancelRequestHandler never wipes the queue without settlement',
  !/setToolUseConfirmQueue\(\(\) => \[\]\)/.test(cancel),
)
t(
  'Esc is released to the elicitation dialog (not swallowed)',
  cancel.includes('isElicitationFocused') &&
    /isEscapeActive\s*=[\s\S]{0,240}!isElicitationFocused/.test(cancel),
)
t(
  "the screen mounts no elicitation dialog of its own (a managed session's MCP elicitation is its runner's — a named follow-up); the cancel handler's gate defaults closed",
  !repl.includes('isElicitationFocused:') && cancel.includes('isElicitationFocused = false'),
)

console.log('— late stream frames after abort —')
const streaming = await import('../../src/utils/messages/streaming.ts')
t(
  'isDroppedLateStreamFrame exported',
  typeof streaming.isDroppedLateStreamFrame === 'function',
)
if (typeof streaming.isDroppedLateStreamFrame === 'function') {
  const drop = streaming.isDroppedLateStreamFrame as (
    m: { type: string },
    aborted: boolean,
  ) => boolean
  t('late stream_event dropped', drop({ type: 'stream_event' }, true) === true)
  t(
    'late stream_request_start dropped',
    drop({ type: 'stream_request_start' }, true) === true,
  )
  t(
    'interrupt marker (user) flows through after abort',
    drop({ type: 'user' }, false) === false &&
      drop({ type: 'user' }, true) === false,
  )
  t(
    'final settlement messages flow through after abort',
    drop({ type: 'assistant' }, true) === false &&
      drop({ type: 'attachment' }, true) === false,
  )
  t(
    'live stream frames untouched pre-abort',
    drop({ type: 'stream_event' }, false) === false,
  )
}
t(
  "the screen runs no query loop of its own (the session's runner owns its stream; no late-frame gate in the face)",
  !repl.includes('isDroppedLateStreamFrame('),
)

console.log('— the transcript arms carry the focused chat\'s live state only —')
// The REPL renders three <Messages> arms over the focused chat: no arm
// carries an engine's streaming tool-use set (a session's tool progress
// folds from its live feed), and every arm paints the focused chat's live
// tail under the one motion gate.
t(
  'every arm carries the empty streaming tool-use set (the live feed owns tool progress)',
  (repl.match(/streamingToolUses=\{NO_STREAMING_TOOL_USES\}/g) ?? []).length === 3,
)
t(
  "every arm paints the focused chat's live tail under the one motion gate (the gate suppresses the text half; the tail mounts on every surface — FN-016 R12)",
  (repl.match(/streamingTail=\{focusedTail\}/g) ?? []).length === 3 &&
    (repl.match(/streamingTextSuppressed=\{streamingSuppressed\}/g) ?? []).length === 3,
)

process.exit(failures)
