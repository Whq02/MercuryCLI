#!/usr/bin/env bun
import { readFileSync } from 'node:fs'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

console.log('— structural: Chat / CancelRequestHandler wiring —')
const repl = readFileSync('src/screens/Chat.tsx', 'utf8')
const cancel = readFileSync('src/hooks/useCancelRequest.ts', 'utf8')

const connector = readFileSync('src/services/engine-connector/daemonConnector.ts', 'utf8')
t(
  "the cancel handler reaches the same door (settle-every-ask-then-cancel is the session's law)",
  cancel.includes('const settleAsksAndCancel = (): void => {') && cancel.includes('interruptFocusedTurn()') && cancel.includes('getFocusedSessionConnector()') && cancel.includes('focused.interrupt()'),
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
