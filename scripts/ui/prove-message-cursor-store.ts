#!/usr/bin/env bun
process.env.NODE_ENV = 'test'

import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const store = await import('../../src/screen/messages/messageCursorStore.ts')
type Cursor = { uuid: string; type: 'user'; expanded: boolean }
const at = (uuid: string): Cursor => ({ uuid, type: 'user', expanded: false })

section('§1 the store — one owner, identity-guarded, the active flag beside it')
{
  store._resetMessageCursorForTest()
  let notified = 0
  const off = store.subscribeMessageCursor(() => notified++)
  check('starts empty', store.getMessageCursor() === null && !store.isMessageCursorActive(), 'the store must start with no cursor; see _resetMessageCursorForTest and the initial state in src/screen/messages/messageCursorStore.ts')
  const first = at('u1')
  store.setMessageCursor(first)
  check('a move publishes the cursor and the active flag', store.getMessageCursor() === first && store.isMessageCursorActive() && notified === 1, `notified ${notified}; setMessageCursor in src/screen/messages/messageCursorStore.ts must store the cursor, set the active flag and notify subscribers once`)
  store.setMessageCursor(first)
  check('writing the same object notifies no one (the identity guard)', notified === 1, `notified ${notified}; setMessageCursor in src/screen/messages/messageCursorStore.ts must return early when the object is the one already stored`)
  store.setMessageCursor(at('u2'))
  check('a different row notifies', notified === 2 && store.getMessageCursor()?.uuid === 'u2', `notified ${notified}; setMessageCursor in src/screen/messages/messageCursorStore.ts must notify when a different cursor object is written`)
  store.setMessageCursor(null)
  check('clearing notifies and drops the active flag', notified === 3 && !store.isMessageCursorActive(), `notified ${notified}; setMessageCursor(null) in src/screen/messages/messageCursorStore.ts must notify and clear the active flag`)
  store.setMessageCursor(null)
  check('clearing an empty store notifies no one', notified === 3, `notified ${notified}; setMessageCursor(null) on an empty store in src/screen/messages/messageCursorStore.ts must not notify`)
  off()
  store.setMessageCursor(at('u3'))
  check('an unsubscribed listener hears nothing', notified === 3, `notified ${notified}; the function subscribeMessageCursor returns in src/screen/messages/messageCursorStore.ts must remove the listener`)
  store._resetMessageCursorForTest()
  check('the reset seam empties the store', store.getMessageCursor() === null, '_resetMessageCursorForTest in src/screen/messages/messageCursorStore.ts must clear the stored cursor')
}

section('§2 the wiring — by census at every owner')
{
  {
    const { mountPart } = await import('./chatScenarios.ts')
    const { useChatScroll } = await import('../../src/screen/chat/useChatScroll.ts')
    const jumps: string[] = []
    const box = { scrollToBottom: () => void jumps.push('bottom') }
    const pill = await mountPart(() => useChatScroll({ messages: [], fullscreen: true, scrollRef: { current: box as never }, scrollRestoreRef: { current: null }, noteUserScroll: () => {} }))
    store.setMessageCursor(at('u7'))
    pill.value().onPillClick()
    const cleared = store.getMessageCursor() === null
    pill.unmount()
    store._resetMessageCursorForTest()
    process.chdir(ROOT)
  }
  const { openSelectorPart } = await import('./chatScenarios.ts')
  const selector = await openSelectorPart('message-cursor-store-selector', { keepHome: true })
  const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 80))
  const idle = selector.part.value().messageCursorActive
  const rendersIdle = selector.part.renders()
  store.setMessageCursor(at('u1'))
  await settled()
  const active = selector.part.value().messageCursorActive
  const rendersActive = selector.part.renders()
  for (const uuid of ['u2', 'u3', 'u4']) store.setMessageCursor(at(uuid))
  await settled()
  const rendersMoved = selector.part.renders()
  const navRef = selector.part.value().messageNavRef
  const cursorActions = selector.part.value().messageActions
  let asked = 0
  navRef.current = { enter: () => void asked++, prev: () => {}, next: () => {}, prevUser: () => {}, nextUser: () => {}, top: () => {}, bottom: () => {}, getSelected: () => undefined }
  cursorActions.enter()
  cursorActions.handlers['messageActions:escape']!()
  const leftByEscape = store.getMessageCursor() === null
  await selector.close()
  store._resetMessageCursorForTest()
  process.chdir(ROOT)
  check('the Chat subscribes to the active flag only', idle === false && active === true && rendersActive === rendersIdle + 1 && rendersMoved === rendersActive, `idle ${idle} · active ${active} · renders on entering ${rendersActive - rendersIdle} · renders over three moves ${rendersMoved - rendersActive}`)
  {
    const { openKeysPart } = await import('./chatScenarios.ts')
    const keys = await openKeysPart('message-cursor-store-keys', { keepHome: true })
    const withoutCursor = keys.handed.actions === null
    await keys.plant({ messageCursorActive: true })
    const withCursor = keys.handed.actions !== null
    await keys.plant({ fullscreen: false })
    const outsideFullscreen = keys.handed.actions === null
    await keys.close()
    process.chdir(ROOT)
  }
  check('the hook takes the nav ref and the capabilities, reading the cursor live', asked === 1 && leftByEscape, `enter reached the nav ref ${asked} times · escape cleared the cursor it read ${leftByEscape}`)

}

section('§3 the mechanism, live — ten moves, zero root renders')
{
  const React = await import('react')
  const { render, Box, Text } = await import('../../src/screen/themedRenderer.js')
  const h = React.createElement as (...a: unknown[]) => React.ReactElement

  let lastChunk = ''
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        lastChunk = chunk.toString()
        cb()
      },
    }),
    { columns: 80, rows: 24, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    setRawMode() {},
    ref() {},
    unref() {},
  }) as unknown as NodeJS.ReadStream
  const strip = (x: string): string => x.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

  let rootRenders = 0
  let childRenders = 0
  function Child(): React.ReactNode {
    childRenders++
    const cursor = store.useMessageCursor()
    return h(Text as never, {}, `cursor ${cursor?.uuid ?? 'none'}`)
  }
  function Root(): React.ReactNode {
    rootRenders++
    const active = store.useMessageCursorActive()
    return h(Box as never, { flexDirection: 'column' }, h(Text as never, {}, `mode ${active ? 'cursor' : 'composer'}`), h(Child as never, {}))
  }
  store._resetMessageCursorForTest()
  const instance = await render(h(Root as never, {}), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  const settle = (): Promise<void> => new Promise(r => setTimeout(r, 30))
  await settle()
  const rootAtMount = rootRenders
  const childAtMount = childRenders
  check('the tree mounted in composer mode', strip(lastChunk).includes('mode composer') && strip(lastChunk).includes('cursor none'), `last frame ${JSON.stringify(strip(lastChunk))}; useMessageCursorActive and useMessageCursor in src/screen/messages/messageCursorStore.ts must read an empty store as composer mode with no cursor`)

  store.setMessageCursor(at('u1'))
  await settle()
  check('entering cursor mode re-renders the root once (the composer swaps for the bar)', rootRenders === rootAtMount + 1 && strip(lastChunk).includes('mode cursor') && strip(lastChunk).includes('cursor u1'), `root ${rootRenders - rootAtMount}`)

  const rootBeforeMoves = rootRenders
  const childBeforeMoves = childRenders
  for (let i = 2; i <= 11; i++) {
    store.setMessageCursor(at(`u${i}`))
    await settle()
  }
  check('ten moves re-render the child ten times', childRenders - childBeforeMoves === 10, `${childRenders - childBeforeMoves}`)
  check('ten moves re-render the root NOT ONCE', rootRenders === rootBeforeMoves, `${rootRenders - rootBeforeMoves}`)
  check('the last move painted', strip(lastChunk).includes('cursor u11'), `last frame ${JSON.stringify(strip(lastChunk))}; useMessageCursor in src/screen/messages/messageCursorStore.ts must re-render its subscriber on every move`)

  store.setMessageCursor(null)
  await settle()
  check('leaving cursor mode re-renders the root once', rootRenders === rootBeforeMoves + 1 && strip(lastChunk).includes('mode composer'), `root ${rootRenders - rootBeforeMoves}; useMessageCursorActive in src/screen/messages/messageCursorStore.ts must notify only when the active flag flips`)
  void childAtMount
  instance.unmount?.()
}

console.log(failures === 0 ? '\nprove-message-cursor-store: THE ROOT NEVER MOVES FOR A MOVE' : `\nprove-message-cursor-store: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
