#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { Readable, Writable } from 'node:stream'


let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  const settleHint = 'change the store subscription that flushes in src/screen/messages/LiveStreamingTail.tsx, or how the settle updates the tail store in handleMessageFromStream (src/screen/messages-list/streamToScreen.ts) and src/engine/message-shapes/streamingTailStore.ts: a delta flushes synchronously, the settle clears the tail with no flush and keeps the text for readSettled'
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok ? ` — ${detail ? `${detail} | ` : ''}${settleHint}` : ''}`)
  if (!ok) failures = 1
}


const React = (await import('react')).default
const { render } = await import('../../src/screen/themedRenderer.ts')
const { default: reconciler } = await import('../../src/screen/renderer/reconciler.ts')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createStreamingTailStore } = await import('../../src/engine/message-shapes/streamingTailStore.ts')
const { handleMessageFromStream } = await import('../../src/screen/messages-list/streamToScreen.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { LiveStreamingTail } = await import('../../src/screen/messages/LiveStreamingTail.tsx')

let flushes = 0
const flushSyncWork = reconciler.flushSyncWork.bind(reconciler)
reconciler.flushSyncWork = (() => {
  flushes++
  return flushSyncWork()
}) as typeof reconciler.flushSyncWork

let written = ''
const stdout = Object.assign(
  new Writable({
    write(chunk: Buffer, _encoding, done) {
      written += chunk.toString()
      done()
    },
  }),
  { columns: 80, rows: 24, isTTY: false },
) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
const settle = (ms = 150): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const h = React.createElement as (...args: unknown[]) => React.ReactElement

const store = createStreamingTailStore()
const instance = await render(
  h(AppStateProvider as never, { initialState: { ...getDefaultAppState(), foregroundTurnActive: true } }, h(LiveStreamingTail as never, { store })),
  { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
)
await settle(300)

type StreamMessage = Parameters<typeof handleMessageFromStream>[0]
const feed = (message: unknown): void => handleMessageFromStream(message as StreamMessage, () => {}, () => {}, () => {}, () => {}, undefined, undefined, undefined, store.update)
const textDelta = (text: string): unknown => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
const REPLY = 'a reply that streams and then settles'

let before = flushes
feed(textDelta(REPLY))
const onText = flushes - before
await settle()
t('§3 a streamed delta reaches the mounted tail through a synchronous flush, so the counter reads the living road', onText >= 1 && store.read() === REPLY && written.includes(REPLY), `flushes on the delta ${onText}, store ${JSON.stringify(store.read())}`)

before = flushes
feed({ type: 'assistant', uuid: 'settled-row', message: { id: 'settled-message', role: 'assistant', content: [{ type: 'text', text: REPLY }] } })
const onSettle = flushes - before
t('§3 the settle of that reply through handleMessageFromStream clears the tail with no synchronous flush', onSettle === 0 && store.read() === null, `flushes on the settle ${onSettle}, store ${JSON.stringify(store.read())}`)
t('§3 and the settled text is held for the ghost, not dropped', store.readSettled() === REPLY, JSON.stringify(store.readSettled()))
await settle()

instance.unmount?.()
console.log(failures === 0 ? 'SETTLE NO SYNC FLUSH: ALL PASS' : 'SETTLE NO SYNC FLUSH: RED')
process.exit(failures)
