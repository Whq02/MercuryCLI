#!/usr/bin/env bun
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
  h.ac.abort()
  await tick()
  t('no double settlement on repeat abort', h.resolutions.length === 1)
}
{
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
  const h = makeHarness()
  h.ac.abort()
  h.start()
  await tick()
  t('already-aborted signal settles immediately', h.resolutions.length === 1)
  t('no queue residue for a dead turn', h.queue.length === 0)
}
{
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
