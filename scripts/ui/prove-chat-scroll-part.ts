#!/usr/bin/env bun
import { mock } from 'bun:test'
import { pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'
import { mountPart } from './chatScenarios.ts'

const HOME = pinScratchHome('chat-scroll-part')

let failures = 0
let sectionHint = ''
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  const shown = [detail, sectionHint].filter(Boolean).join(' — ')
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && shown ? ` — ${shown}` : ''}`)
}
function section(title: string, hint = ''): void {
  sectionHint = hint
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const cursorStore = { ...(await import('../../src/screen/messages/messageCursorStore.ts')) }
const cursorWrites: unknown[] = []
mock.module('../../src/screen/messages/messageCursorStore.ts', () => ({
  ...cursorStore,
  setMessageCursor: (next: Parameters<typeof cursorStore.setMessageCursor>[0]) => {
    cursorWrites.push(next)
    cursorStore.setMessageCursor(next)
  },
}))
const { useChatScroll, useChatScrollFollow, useChatScrollPin } = await import('../../src/screen/chat/useChatScroll.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
type Message = import('../../src/engine/message-shapes/message.ts').Message
type ScrollRestore = import('../../src/screen/chat/useChatScroll.ts').ScrollRestore

const box = { height: 100, viewport: 20, top: 80, sticky: false, calls: [] as string[] }
const handle = {
  getScrollHeight: () => box.height,
  getFreshScrollHeight: () => box.height,
  getViewportHeight: () => box.viewport,
  getScrollTop: () => box.top,
  getPendingDelta: () => 0,
  isSticky: () => box.sticky,
  scrollTo: (y: number) => {
    box.calls.push(`scrollTo ${y}`)
    box.top = y
  },
  scrollToBottom: () => {
    box.calls.push('scrollToBottom')
    box.top = Math.max(0, box.height - box.viewport)
  },
}
const user = (text: string): Message => createUserMessage({ content: text }) as Message
const assistant = (text: string): Message => createAssistantMessage({ content: text }) as Message

section('§1 the pin alone: the handle of the scroll box and the way back to the bottom', 'what to change: useChatScrollPin (repinToBottom, noteUserScroll and the refs) in src/screen/chat/useChatScroll.ts')
{
  const pin = await mountPart(() => useChatScrollPin())
  const first = pin.value()
  first.scrollRef.current = handle as never
  first.scrollRestoreRef.current = { gap: 3, sticky: false }
  first.repinToBottom()
  check('the pin drops the kept scroll and sends the box to its bottom', first.scrollRestoreRef.current === null && box.calls.join() === 'scrollToBottom', box.calls.join())
  const before = Date.now()
  first.noteUserScroll()
  check('a scroll of the user is stamped with the time', first.lastUserScrollAtRef.current >= before && first.lastUserScrollAtRef.current <= Date.now())
  await pin.set(() => useChatScrollPin())
  const second = pin.value()
  check('the refs and the two handlers are the same from one render to the next', second.scrollRef === first.scrollRef && second.scrollRestoreRef === first.scrollRestoreRef && second.modalScrollRef === first.modalScrollRef && second.repinToBottom === first.repinToBottom && second.noteUserScroll === first.noteUserScroll)
  pin.unmount()
}

section('§2 the fold line: what is unseen below a reader who scrolled away', 'what to change: onScroll, onPillClick, unseenDivider and newMessageCount in useChatScroll, src/screen/chat/useChatScroll.ts')
{
  let rows: Message[] = [user('first question'), assistant('first answer')]
  let fullscreen = true
  let noted = 0
  const scrollRef = { current: handle as never }
  const scrollRestoreRef: { current: ScrollRestore | null } = { current: null }
  const use = (): ReturnType<typeof useChatScroll> => useChatScroll({ messages: rows, fullscreen, scrollRef, scrollRestoreRef, noteUserScroll: () => void noted++ })
  const part = await mountPart(use)
  const act = async (run: () => void): Promise<void> => {
    run()
    await settle(80)
  }
  check('at the tail nothing is unseen and no fold line is drawn', part.value().newMessageCount === 0 && part.value().unseenDivider === undefined)
  box.calls.length = 0
  box.top = 40
  scrollRestoreRef.current = { gap: 9, sticky: false }
  cursorStore.setMessageCursor({ uuid: 'u0', type: 'user', expanded: false } as never)
  await act(() => part.value().onScroll(false, handle as never))
  check('a scroll away from the tail drops the kept scroll, stamps the user and plants the fold line at the row count', scrollRestoreRef.current === null && noted === 1 && part.value().unseen.dividerIndex === 2, `${noted} · ${String(part.value().unseen.dividerIndex)}`)
  check('a scroll leaves the message cursor where it stands and writes nothing to its store', (cursorStore.getMessageCursor() as { uuid?: string } | null)?.uuid === 'u0' && cursorWrites.length === 0, `${JSON.stringify(cursorStore.getMessageCursor())} · ${cursorWrites.length} writes`)
  rows = [...rows, assistant('an answer the reader has not seen'), assistant('and another')]
  await part.set(use)
  check('answers that arrive below the fold line are counted and the fold line is drawn above them', part.value().newMessageCount >= 1 && part.value().unseenDivider !== undefined, `${part.value().newMessageCount} · ${JSON.stringify(part.value().unseenDivider)}`)
  fullscreen = false
  await part.set(use)
  check('outside the fullscreen layout no fold line is drawn', part.value().unseenDivider === undefined)
  fullscreen = true
  await part.set(use)
  cursorStore.setMessageCursor({ uuid: 'u1', type: 'user', expanded: false } as never)
  box.calls.length = 0
  scrollRestoreRef.current = { gap: 9, sticky: false }
  await act(() => part.value().onPillClick())
  check('the pill drops the kept scroll, clears the message cursor in its store and goes to the bottom', scrollRestoreRef.current === null && cursorStore.getMessageCursor() === null && box.calls.join() === 'scrollToBottom', `${box.calls.join()} · ${JSON.stringify(cursorStore.getMessageCursor())}`)
  cursorStore.setMessageCursor({ uuid: 'u2', type: 'user', expanded: false } as never)
  await act(() => part.value().onScroll(true, handle as never))
  check('a scroll that lands on the tail takes the fold line away', part.value().unseen.dividerIndex === null && part.value().newMessageCount === 0 && noted === 2)
  check('and it too leaves the message cursor where it stands', (cursorStore.getMessageCursor() as { uuid?: string } | null)?.uuid === 'u2', JSON.stringify(cursorStore.getMessageCursor()))
  cursorStore.setMessageCursor(null)

  section('§3 the scroll kept across a flip of the view', 'what to change: captureScrollForFlip and the setFlipGeneration restore effect in useChatScroll, src/screen/chat/useChatScroll.ts')
  scrollRef.current = null as never
  part.value().captureScrollForFlip()
  check('with no scroll box there is nothing to keep', scrollRestoreRef.current === null)
  scrollRef.current = handle as never
  box.height = 100
  box.viewport = 20
  box.top = 50
  box.sticky = false
  part.value().captureScrollForFlip()
  check('the gap to the tail is kept: 30 rows above the bottom, not sticky', JSON.stringify(scrollRestoreRef.current) === '{"gap":30,"sticky":false}', JSON.stringify(scrollRestoreRef.current))
  box.height = 160
  box.top = 0
  box.calls.length = 0
  await act(() => part.value().setFlipGeneration(generation => generation + 1))
  await settle(200)
  check('after the flip the view is put back the same gap above the new tail', box.top === 110 && box.calls.includes('scrollTo 110'), `${box.top} · ${box.calls.join()}`)
  check('and the kept scroll is spent once the box stands there', scrollRestoreRef.current === null, JSON.stringify(scrollRestoreRef.current))
  box.top = 140
  box.sticky = true
  part.value().captureScrollForFlip()
  check('a view at its tail is kept as sticky', JSON.stringify(scrollRestoreRef.current) === '{"gap":0,"sticky":true}', JSON.stringify(scrollRestoreRef.current))
  box.calls.length = 0
  await act(() => part.value().setFlipGeneration(generation => generation + 1))
  await settle(200)
  check('and a sticky view is sent to the bottom after the flip', box.calls.includes('scrollToBottom') && scrollRestoreRef.current === null, box.calls.join())
  box.sticky = false
  box.top = 10
  part.value().captureScrollForFlip()
  box.height = 12
  box.calls.length = 0
  await act(() => part.value().setFlipGeneration(generation => generation + 1))
  check('a view that fits its box after the flip is pinned to the bottom and holds no fold line', box.calls.includes('scrollToBottom') && scrollRestoreRef.current === null && part.value().unseen.dividerYRef.current === null, box.calls.join())
  check('over all of this the part wrote the message cursor once: the pill cleared it', cursorWrites.length === 1 && cursorWrites[0] === null, JSON.stringify(cursorWrites))
  part.unmount()
}

section('§4 the pin on a human turn', 'what to change: useChatScrollFollow in src/screen/chat/useChatScroll.ts')
{
  let rows: Message[] = [assistant('an answer')]
  let pins = 0
  const repinToBottom = (): void => void pins++
  const use = (): void => useChatScrollFollow({ messages: rows, repinToBottom })
  const follow = await mountPart(use)
  check('an answer as the last row pins nothing', pins === 0, String(pins))
  rows = [...rows, user('a new question')]
  await follow.set(use)
  check('a human turn as the last row pins the view to the bottom once', pins === 1, String(pins))
  await follow.set(use)
  check('the same last row on a later render pins nothing more', pins === 1, String(pins))
  rows = [...rows, assistant('the answer to it')]
  await follow.set(use)
  check('the answer that follows pins nothing', pins === 1, String(pins))
  follow.unmount()
}

await releaseScratchHome(HOME)
console.log(`\n${failures === 0 ? 'prove-chat-scroll-part: ALL PASS' : `prove-chat-scroll-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
