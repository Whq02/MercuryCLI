#!/usr/bin/env bun

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}${ok ? '' : ' — to fix, see isDroppedLateStreamFrame in src/screen/messages-list/streamToScreen.ts: after an abort it must drop only stream_event and stream_request_start frames'}`)
  if (!ok) failures = 1
}


console.log('— late stream frames after abort —')
const streaming = await import('../../src/screen/messages-list/streamToScreen.ts')
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

process.exit(failures)
