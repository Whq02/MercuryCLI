#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-message-cursor-store.ts — a cursor move re-renders the
//  surfaces that paint it, never the REPL root.
//
//  Measured on a ~5,000-record session: every ↑/↓ in message-actions cursor
//  mode re-rendered the REPL root once (twice at p95) beside the one
//  transcript render that did the work, and the scroll-follow asked for
//  its move in a passive effect — after the first frame had gone out — so
//  a key cost two to three frames. The cursor now lives in its own store
//  (messageCursorStore): the transcript and the action bar subscribe to the
//  cursor, the REPL root only to whether one stands; the scroll-follow is a
//  layout effect, in the highlight's own commit.
//
//    §1 the store's laws, pure: get/set/subscribe, the identity guard (a
//       write that changes nothing notifies no one), the active-flag view,
//       the reset seam;
//    §2 the wiring, by census: the REPL keeps no cursor state and reads the
//       active flag; the transcript reads the store when it owns the cursor
//       and hands the list the store's setter; the hook and the bar read
//       the store; the scroll-follow is a layout effect; no transcript
//       mount passes a cursor prop;
//    §3 the mechanism, LIVE through the real reconciler: a root that reads
//       only the active flag and a child that paints the cursor — ten moves
//       re-render the child ten times and the root not once; enter and
//       exit re-render the root once each.
//
//  Run: bun scripts/ui/prove-message-cursor-store.ts
// ============================================================================
process.env.NODE_ENV = 'test'

import { readFileSync } from 'node:fs'
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
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const store = await import('../../src/components/messageCursorStore.ts')
type Cursor = { uuid: string; type: 'user'; expanded: boolean }
const at = (uuid: string): Cursor => ({ uuid, type: 'user', expanded: false })

section('§1 the store — one owner, identity-guarded, the active flag beside it')
{
  store._resetMessageCursorForTest()
  let notified = 0
  const off = store.subscribeMessageCursor(() => notified++)
  check('starts empty', store.getMessageCursor() === null && !store.isMessageCursorActive())
  const first = at('u1')
  store.setMessageCursor(first)
  check('a move publishes the cursor and the active flag', store.getMessageCursor() === first && store.isMessageCursorActive() && notified === 1)
  store.setMessageCursor(first)
  check('writing the same object notifies no one (the identity guard)', notified === 1)
  store.setMessageCursor(at('u2'))
  check('a different row notifies', notified === 2 && store.getMessageCursor()?.uuid === 'u2')
  store.setMessageCursor(null)
  check('clearing notifies and drops the active flag', notified === 3 && !store.isMessageCursorActive())
  store.setMessageCursor(null)
  check('clearing an empty store notifies no one', notified === 3)
  off()
  store.setMessageCursor(at('u3'))
  check('an unsubscribed listener hears nothing', notified === 3)
  store._resetMessageCursorForTest()
  check('the reset seam empties the store', store.getMessageCursor() === null)
}

section('§2 the wiring — by census at every owner')
{
  const repl = read('src/screens/REPL.tsx')
  check('the REPL keeps no cursor state of its own', !repl.includes('useState<MessageActionsState | null>') && !repl.includes('setMessageCursor'))
  check('the REPL subscribes to the active flag only', repl.includes('const messageCursorActive = useMessageCursorActive();') && repl.includes("import { useMessageCursorActive } from '../components/messageCursorStore.js';"))
  check('the bar and the key handlers mount on the active flag', repl.includes('messageCursorActive && !messageActionsDisabled ? <MessageActionsBar /> : composerGroup') && repl.includes('{fullscreen && messageCursorActive ? ('))
  check('the live transcript owns the cursor; no transcript mount passes a cursor prop', /ownsCursor\s*\n\s*cursorNavRef=\{messageNavRef\}/.test(repl) && !/\bcursor=\{/.test(repl))
  check('the hook takes the nav ref and the capabilities, reading the cursor live', repl.includes('useMessageActions(messageNavRef, {'))

  const messages = read('src/components/Messages.tsx')
  check('the transcript reads the store when it owns the cursor', messages.includes('const liveCursor = useMessageCursor()') && messages.includes('const cursor: MessageActionsState | null = ownsCursor ? liveCursor : null') && messages.includes('const setCursor = ownsCursor ? setMessageCursor : undefined'))
  check('the transcript comparator keys on ownership, never on the cursor', messages.includes('if (prev.ownsCursor !== next.ownsCursor) return false') && !messages.includes('if (prev.cursor !== next.cursor) return false'))
  const others = ['src/utils/exportRenderer.tsx', 'src/components/SessionPreview.tsx'].filter(rel => /ownsCursor|cursor=\{/.test(read(rel)))
  check('no other transcript mount claims the cursor', others.length === 0, others.join(' · '))

  const actions = read('src/components/messageActions.tsx')
  check('the hook reads and writes the store, never a cursor ref', actions.includes('const current = getMessageCursor()') && actions.includes('setMessageCursor(null)') && !actions.includes('cursorRef') && !actions.includes('setCursorRef'))
  check('the bar reads the store and paints nothing while no cursor stands', actions.includes('const live = useMessageCursor()') && actions.includes('const cursor = given ?? live') && actions.includes('if (!cursor) return null'))

  const list = read('src/components/VirtualMessageList.tsx')
  check('the scroll-follow rides a LAYOUT effect (the highlight’s own commit)', /useLayoutEffect\(\(\) => \{\s*\n\s*if \(selectedIndex === undefined\) return\s*\n\s*const el = vsRef\.current\.getItemElement\(selectedIndex\)/.test(list))
}

section('§3 the mechanism, live — ten moves, zero root renders')
{
  const React = await import('react')
  const { render, Box, Text } = await import('../../src/ink.js')
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
  check('the tree mounted in composer mode', strip(lastChunk).includes('mode composer') && strip(lastChunk).includes('cursor none'))

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
  check('the last move painted', strip(lastChunk).includes('cursor u11'))

  store.setMessageCursor(null)
  await settle()
  check('leaving cursor mode re-renders the root once', rootRenders === rootBeforeMoves + 1 && strip(lastChunk).includes('mode composer'), `root ${rootRenders - rootBeforeMoves}`)
  void childAtMount
  instance.unmount?.()
}

console.log(failures === 0 ? '\nprove-message-cursor-store: THE ROOT NEVER MOVES FOR A MOVE' : `\nprove-message-cursor-store: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
