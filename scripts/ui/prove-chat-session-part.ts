#!/usr/bin/env bun
import { settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { mountPart, openSessionPart } from './chatScenarios.ts'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const rekeyWhere = ' | change the effect on focusedSessionId in useChatSession, src/screen/chat/useChatSession.ts'
const warmthWhere = ' | change paintedTranscriptOf, entryLoadingLineOf or enteringWarmth in src/screen/concourse-model/sessionWarmth.ts, or their use in useChatSession, src/screen/chat/useChatSession.ts'
const settleWhere = ' | change the settle effect (slotHasSession, landing, chatSurfaceCovered, localJsx, armedMessage) in useChatSession, src/screen/chat/useChatSession.ts'
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const t = await openSessionPart('sess-a')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const row = (text: string): never => createAssistantMessage({ content: text }) as never
const asked = (text: string): never => createUserMessage({ content: text }) as never
const taken = (): string => {
  const said = t.calls.join(' · ')
  t.calls.length = 0
  return said
}
const moved = (): string => {
  const said = t.rekeys.join(' · ')
  t.rekeys.length = 0
  return said
}

section('§1 the rekey on a change of session')
const atMount = taken()
check('on mount the part puts the compact focus on the composer, takes the fold line away, pins the view, names the conversation and clears the dialog', atMount === 'compactWork.set composer · unseen.onRepin · repinToBottom · setConversationId sess-a · setToolJSX null', atMount + rekeyWhere)
check('and moves neither the draft nor the queue: the session is the one it was mounted with', moved() === '', `rekeys on mount: ${moved()}${rekeyWhere}`)
await t.plant({ messages: [asked('a question')] })
check('a render with the same session does none of it again', taken() === '' && moved() === '', `${t.calls.join()} · ${t.rekeys.join()}${rekeyWhere}`)
await t.focus('sess-b')
const onSwitch = taken()
const switched = moved()
check('another session does all five again', onSwitch === 'compactWork.set composer · unseen.onRepin · repinToBottom · setConversationId sess-b · setToolJSX null', onSwitch + rekeyWhere)
check('and re-keys the draft store first, then the command queue, to that session and not as a landing', switched === 'draft sess-b landing=false · queue sess-b landing=false', switched + rekeyWhere)
await t.focus(null)
const onRest = taken()
check('a slot that rests re-keys both owners to no session', onRest.includes("setConversationId ''") && onRest.includes('setToolJSX null') && moved() === 'draft null landing=false · queue null landing=false', `${onRest} · ${t.rekeys.join()}${rekeyWhere}`)
await t.focus('sess-c')
const onLanding = taken()
const landed = moved()
check('a session that fills the resting slot is a landing: both owners hear the landing word, computed once', landed === 'draft sess-c landing=true · queue sess-c landing=true', landed + rekeyWhere)
check('and a landing leaves the dialog that is up where it is', onLanding === 'compactWork.set composer · unseen.onRepin · repinToBottom · setConversationId sess-c', onLanding + rekeyWhere)

section('§2 the entry warmth: what is painted while a session is entered')
const live = [asked('what the session in view was asked'), row('LIVE-1 its own answer')]
await t.plant({ messages: live })
check('with no entry armed the rows of the session are painted as they are, and nothing says it is loading', t.part.value().paintedMessages === live && t.part.value().displayedMessages === live && t.part.value().entryLoadingLine === null, `painted rows ${t.part.value().paintedMessages.length}, loading line ${JSON.stringify(t.part.value().entryLoadingLine)}${warmthWhere}`)
const kept = [asked('what the warm session was asked'), row('WARM-1 an answer kept from the last visit')]
t.warmth.rememberSessionWarmth('sess-w', kept, 0)
t.warmth.armEntryWarmth('sess-w', 'the warm session', 'sess-c')
await settle(80)
check('an entry armed over the session in view paints the kept rows of the session being entered, never the rows it covers', t.part.value().paintedMessages.length === 2 && t.part.value().paintedMessages[1] === kept[1] && t.part.value().entryLoadingLine === null, `${t.part.value().paintedMessages.length} rows${warmthWhere}`)
taken()
moved()
await t.focus('sess-w', { messages: [] })
check('the entered session with no rows yet keeps painting what was kept, and the entry stays armed', t.part.value().paintedMessages.length === 2 && t.warmth.enteringWarmth()?.sessionId === 'sess-w', `${t.part.value().paintedMessages.length} rows · ${JSON.stringify(t.warmth.enteringWarmth()?.sessionId)}${warmthWhere}`)
const arrived = [...kept, row('WARM-2 a row that arrived since')]
await t.plant({ messages: arrived })
await settle(80)
check('its own rows arriving settle the entry and drop what was kept: the rows are painted as they are', t.warmth.enteringWarmth() === null && t.part.value().paintedMessages === arrived, JSON.stringify(t.warmth.enteringWarmth()) + warmthWhere)
t.warmth.armEntryWarmth('sess-w', 'the warm session again')
const stillKept = t.warmth.enteringWarmth()?.rows.length
t.warmth.settleEntryWarmth('sess-w')
check('and nothing of that session is kept any longer', stillKept === 0, String(stillKept) + warmthWhere)
t.warmth.armEntryWarmth('sess-x', 'the cold session')
await t.focus('sess-x', { messages: [] })
check('a session with nothing kept says it is opening, by its title', t.part.value().entryLoadingLine === 'opening the cold session — loading the conversation…' && t.part.value().paintedMessages.length === 0, String(t.part.value().entryLoadingLine) + warmthWhere)
await t.focus('sess-y')
await settle(80)
check('focusing a third session instead settles the entry', t.warmth.enteringWarmth() === null && t.part.value().entryLoadingLine === null, JSON.stringify(t.warmth.enteringWarmth()) + warmthWhere)
const frozen = [asked('a frozen row')]
await t.plant({ messages: live, inVirtualTranscript: true, transcriptMessages: frozen })
check('in the transcript view the rows shown are the transcript part\'s own', t.part.value().displayedMessages === frozen && t.part.value().paintedMessages === live, `displayed and painted rows must stay separate in the transcript view${warmthWhere}`)
await t.plant({ inVirtualTranscript: false })

section('§3 the settle when no chat is here')
const stays = async (label: string, over: Parameters<typeof t.plant>[0]): Promise<void> => {
  await t.plant(over)
  await settle(450)
  check(label, t.route.currentSurfaceRoute().kind === 'repl', t.route.currentSurfaceRoute().kind + settleWhere)
}
await t.plant({ landing: true })
await t.focus(null)
await settle(450)
check('while a session is landing the screen stays, though no session is in the slot', t.route.currentSurfaceRoute().kind === 'repl', t.route.currentSurfaceRoute().kind + settleWhere)
await stays('while a local dialog is up it stays', { landing: false, localJsx: true })
await stays('while another surface covers the chat it stays', { localJsx: false, chatSurfaceCovered: true })
await stays('while a line is armed for the landing it stays', { chatSurfaceCovered: false, armedMessage: { message: asked('an armed line') } as never })
await stays('a dialog that mounted while the beat ran is read when it fires, and the screen stays', { armedMessage: null, toolJSXRef: { current: { jsx: null, shouldHidePromptInput: false, isLocalJSXCommand: true } as never } })
await t.plant({ localJsx: true })
await t.plant({ localJsx: false, toolJSXRef: { current: null } })
check('with none of them and no session in the slot the screen hands the frame to the landing for an absent chat, one beat later', await waitFor(() => t.route.currentSurfaceRoute().kind !== 'repl', 3000), t.route.currentSurfaceRoute().kind + settleWhere)
await t.close()

section('§4 the conversation the screen names')
{
  const { useChatConversation } = t.module
  const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
  const connector = Object.assign(new NoSessionConnector(), { sessionId: () => 'sess-named' }) as never
  const named = await mountPart(() => useChatConversation(connector))
  check('it starts as the session in focus at mount', named.value().conversationId === 'sess-named', named.value().conversationId + ' | change useChatConversation in src/screen/chat/useChatSession.ts')
  named.value().setConversationId('sess-other')
  await settle(80)
  check('and is set through the setter the part hands on', named.value().conversationId === 'sess-other', named.value().conversationId + ' | change useChatConversation in src/screen/chat/useChatSession.ts')
  named.unmount()
}

console.log(`\n${failures === 0 ? 'prove-chat-session-part: ALL PASS' : `prove-chat-session-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
