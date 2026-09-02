#!/usr/bin/env bun

import {
  handleMessageFromStream,
  isDroppedLateStreamFrame,
  type StreamingToolUse,
  type StreamingToolUseUpdateOpts,
} from '../../src/utils/messages/streaming.js'
import { StreamBatcher } from '../../src/utils/messages/streamBatcher.js'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const streamEvent = (event: Record<string, unknown>) =>
  ({ type: 'stream_event', event }) as never
const textDelta = (text: string, index = 0) =>
  streamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  })
const inputJsonDelta = (partial: string, index: number) =>
  streamEvent({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partial },
  })
const blockStart = (content_block: Record<string, unknown>, index = 0) =>
  streamEvent({ type: 'content_block_start', index, content_block })
const blockStop = (index = 0) => streamEvent({ type: 'content_block_stop', index })

type TextReducer = (current: string | null) => string | null

function drive(frames: never[]) {
  let streamingText: string | null = null
  const textCommits: (string | null)[] = []
  const modes: string[] = []
  const appended: unknown[] = []
  const toolUses = new StreamBatcher<StreamingToolUse[]>([], {
    sink: v => toolCommits.push(v),
    flushNow: (prev, next) => prev.length !== next.length,
    setTimer: fn => {
      pending.push(fn)
      return pending.length
    },
    clearTimer: h => {
      pending[(h as number) - 1] = null as never
    },
  })
  const pending: (() => void)[] = []
  const toolCommits: StreamingToolUse[][] = []
  const onStreamingToolUses = (
    f: (cur: StreamingToolUse[]) => StreamingToolUse[],
    opts?: StreamingToolUseUpdateOpts,
  ) => {
    if (opts?.silent) toolUses.updateSilent(f)
    else toolUses.update(f)
    if (opts?.flushSilent) toolUses.flushSilent()
  }
  for (const frame of frames) {
    handleMessageFromStream(
      frame,
      m => appended.push(m),
      () => {},
      mode => modes.push(mode),
      onStreamingToolUses,
      undefined,
      undefined,
      undefined,
      (f: TextReducer) => {
        streamingText = f(streamingText)
        textCommits.push(streamingText)
      },
    )
  }
  const pump = () => {
    for (const fn of pending.splice(0)) fn?.()
  }
  return {
    get streamingText() {
      return streamingText
    },
    textCommits,
    modes,
    appended,
    toolUses,
    toolCommits,
    pump,
  }
}

console.log('── FLUX S0 stream-contract characterization ──')

{
  const source =
    'Streaming prose with a long single logical line that never breaks, ' +
    'then a list:\n- one\n- two\n\n```ts\nconst x = 1\n```\nand a tail without newline'
  const chunkings: [string, string[]][] = [
    ['char-by-char', [...source]],
    ['bursty-7', Array.from({ length: Math.ceil(source.length / 7) }, (_, i) => source.slice(i * 7, i * 7 + 7))],
    ['whole', [source]],
  ]
  for (const [name, chunks] of chunkings) {
    const d = drive([
      blockStart({ type: 'text' }),
      ...chunks.map(c => textDelta(c)),
    ] as never[])
    check(`text byte-equality (${name})`, d.streamingText === source,
      `got ${JSON.stringify(d.streamingText)?.slice(0, 80)}`)
  }
}

{
  const d = drive([
    blockStart({ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }, 1),
    inputJsonDelta('{"comm', 1),
    blockStart({ type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }, 2),
    inputJsonDelta('and":"ls"}', 1),
    inputJsonDelta('{"file_path":"/x"}', 2),
    blockStop(1),
    blockStop(2),
  ] as never[])
  const rows = d.toolUses.current
  check('tool rows open in stream order', rows.length === 2 && rows[0]!.index === 1 && rows[1]!.index === 2)
  check('deltas land on the right row, in place',
    rows[0]!.unparsedToolInput === '{"command":"ls"}' &&
    rows[1]!.unparsedToolInput === '{"file_path":"/x"}')
}

{
  const d = drive([
    blockStart({ type: 'text' }),
    textDelta('hello'),
    blockStart({ type: 'text' }),
  ] as never[])
  check('content_block_start clears streaming text', d.streamingText === null)

  const d2 = drive([blockStart({ type: 'text' }), textDelta('partial ')] as never[])
  handleMessageFromStream(
    { type: 'assistant', message: { content: [] }, uuid: 'u1' } as never,
    () => {},
    () => {},
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    (f: TextReducer) => {
      const next = f(d2.streamingText)
      check('message append clears streaming text in the SAME fan-out call', next === null)
    },
  )
}

{
  const commits: number[] = []
  const b = new StreamBatcher<string>('', {
    sink: () => commits.push(1),
    setTimer: () => 1,
    clearTimer: () => {},
  })
  for (let i = 0; i < 100; i++) b.updateSilent(cur => cur + 'x')
  check('100 silent deltas schedule zero commits', commits.length === 0)
  check('silent value stays ref-fresh', b.current.length === 100)
  b.flushSilent()
  check('boundary commits exactly once', commits.length === 1)
  b.flushSilent()
  check('clean boundary is a no-op (no double commit)', commits.length === 1)
}

{
  check('late stream_event dropped after abort',
    isDroppedLateStreamFrame({ type: 'stream_event' }, true))
  check('late stream_request_start dropped after abort',
    isDroppedLateStreamFrame({ type: 'stream_request_start' }, true))
  check('settlement message NEVER dropped',
    !isDroppedLateStreamFrame({ type: 'assistant' }, true) &&
    !isDroppedLateStreamFrame({ type: 'user' }, true))
  check('nothing dropped pre-abort',
    !isDroppedLateStreamFrame({ type: 'stream_event' }, false))
}

{
  const sunk: string[] = []
  let trailing: (() => void) | null = null
  const b = new StreamBatcher<string>('', {
    sink: v => sunk.push(v),
    setTimer: fn => {
      trailing = fn
      return 1
    },
    clearTimer: () => {
      trailing = null
    },
  })
  b.update(() => 'partial fin')
  check('esc-interrupt read sees the un-flushed tail', b.current === 'partial fin')
  b.flush()
  b.dispose()
  check('flush-before-dispose commits the final value', sunk[sunk.length - 1] === 'partial fin')
  check('no trailing timer survives dispose', trailing === null)
  b.update(cur => cur + ' late')
  check('post-dispose update never resurrects the sink', sunk.length === 1 && b.current === 'partial fin late')
}

if (failures > 0) {
  console.error(`❌ FLUX stream-contract: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ FLUX stream-contract GREEN')
