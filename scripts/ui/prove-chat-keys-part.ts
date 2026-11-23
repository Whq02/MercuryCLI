#!/usr/bin/env bun
import { openKeysPart } from './chatScenarios.ts'

let failures = 0
const keysPartFix = 'fix what ChatKeys hands its handlers, the Escape hold and the suspend and resume writes in src/screen/chat/ChatKeys.tsx'
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} · ` : ''}${keysPartFix}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const t = await openKeysPart('chat-keys-part')
const { isVimModeEnabled } = await import('../../src/screen/composer/composerConfig.ts')
const { ASK_USER_QUESTION_TOOL_NAME } = await import('../../src/tools/ask-question/prompt.ts')
const { createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
const said = (name: 'global' | 'command' | 'scroll' | 'actions' | 'cancel'): string => JSON.stringify(t.handed[name], (_key, value) => (typeof value === 'function' ? 'fn' : value))

section('§1 the five handlers the part mounts, and what it hands each')
check('with the chat in view the part mounts the global, command, scroll and cancel handlers and no message actions', t.handed.global !== null && t.handed.command !== null && t.handed.scroll !== null && t.handed.cancel !== null && t.handed.actions === null, Object.entries(t.handed).map(([name, props]) => `${name} ${props === null ? 'absent' : 'mounted'}`).join(' · '))
const enter = (): void => {}
const leave = (): void => {}
const rows = [createUserMessage({ content: 'one' }), createUserMessage({ content: 'two' }), createUserMessage({ content: 'three' })] as never[]
await t.plant({ messages: rows, handleEnterTranscript: enter, handleExitTranscript: leave, inVirtualTranscriptMode: true, searchBarOpen: true, screen: 'transcript', showAllInTranscript: true })
check(
  'the global handler is handed the screen, the show-all flag, how many rows there are, the two ways of the transcript, whether the scroll is virtual and whether the search field is open',
  t.handed.global?.screen === 'transcript' && t.handed.global.showAllInTranscript === true && t.handed.global.messageCount === 3 && t.handed.global.onEnterTranscript === enter && t.handed.global.onExitTranscript === leave && t.handed.global.virtualScrollActive === true && t.handed.global.searchBarOpen === true && t.handed.global.compactWork === t.props().compactWork && t.handed.global.setScreen === t.props().setScreen && t.handed.global.setShowAllInTranscript === t.props().setShowAllInTranscript,
  said('global'),
)
const submit = async (): Promise<void> => {}
await t.plant({ onSubmit: submit, dialogOwnsKeys: false, screen: 'prompt', searchBarOpen: false })
check('the command handler is handed the submit and the commands, and is active while no dialog owns the keys', t.handed.command?.onSubmit === submit && t.handed.command.commands === t.props().commands && t.handed.command.isActive === true, said('command'))
await t.plant({ dialogOwnsKeys: true })
check('a dialog that owns the keys stands the command handler down', t.handed.command?.isActive === false, said('command'))
await t.plant({ dialogOwnsKeys: false })

const scrollCase = async (label: string, over: Parameters<typeof t.plant>[0], want: { isActive: boolean; onScroll: unknown; isModal: boolean; modalUp: boolean }): Promise<void> => {
  await t.plant({ fullscreen: true, inVirtualTranscript: false, centredModalUp: false, dialogOwnsKeys: false, focusedInputDialog: undefined, permissionOverlay: null, searchBarOpen: false, ...over })
  const got = t.handed.scroll
  check(`the scroll handler, ${label}`, got !== null && got.isActive === want.isActive && got.onScroll === want.onScroll && got.isModal === want.isModal && got.modalUp === want.modalUp && got.scrollRef === t.props().scrollRef && got.modalScrollRef === t.props().modalScrollRef, said('scroll'))
}
const onScroll = t.props().onScroll
const onTranscriptScroll = t.props().onTranscriptScroll
await scrollCase('with the composer in focus: active, the chat scroll', {}, { isActive: true, onScroll, isModal: false, modalUp: false })
await scrollCase('with a permission card in focus: active, and the card takes the scroll report', { focusedInputDialog: 'tool-permission', permissionOverlay: 'a card' }, { isActive: true, onScroll: undefined, isModal: false, modalUp: false })
await scrollCase('with another dialog in focus: not active', { focusedInputDialog: 'elicitation' }, { isActive: false, onScroll, isModal: false, modalUp: false })
await scrollCase('with a centred modal that owns the keys: active on the modal, no scroll report', { focusedInputDialog: 'cost-threshold', centredModalUp: true, dialogOwnsKeys: true }, { isActive: true, onScroll: undefined, isModal: false, modalUp: true })
await scrollCase('outside the fullscreen layout: not active', { fullscreen: false }, { isActive: false, onScroll, isModal: false, modalUp: false })
await scrollCase('in the transcript: active, modal, the transcript scroll', { inVirtualTranscript: true, focusedInputDialog: 'elicitation' }, { isActive: true, onScroll: onTranscriptScroll, isModal: true, modalUp: false })
await scrollCase('in the transcript with the search field open: not modal', { inVirtualTranscript: true, searchBarOpen: true }, { isActive: true, onScroll: onTranscriptScroll, isModal: false, modalUp: false })

const handlers = { 'messageActions:copy': (): void => {} }
await t.plant({ fullscreen: true, inVirtualTranscript: false, searchBarOpen: false, messageCursorActive: true, messageActions: { handlers }, focusedInputDialog: undefined })
check('the message actions are mounted while the message cursor is active in the fullscreen layout, with the handlers of the cursor', t.handed.actions?.handlers === handlers && t.handed.actions.isActive === true, said('actions'))
await t.plant({ focusedInputDialog: 'tool-permission' })
check('and stand down while a dialog has the focus', t.handed.actions?.isActive === false, said('actions'))
await t.plant({ focusedInputDialog: undefined, messageActionsDisabled: true })
check('and while they are disabled', t.handed.actions?.isActive === false, said('actions'))
await t.plant({ messageActionsDisabled: false, fullscreen: false })
check('outside the fullscreen layout they are not mounted', t.handed.actions === null, said('actions'))
await t.plant({ fullscreen: true, messageCursorActive: false })
check('nor without a message cursor', t.handed.actions === null, said('actions'))

const ask = { tool: { name: ASK_USER_QUESTION_TOOL_NAME } } as never
const other = { tool: { name: 'Bash' } } as never
await t.plant({ focusedInputDialog: 'tool-permission', toolUseConfirmQueue: [ask], showMessageSelector: false, showBashesDialog: false, screen: 'prompt', vimMode: 'NORMAL', dialogOwnsKeys: true, isSearchingHistory: true, helpOpen: true, viewStreamMode: 'tool-use', seatLive: { ...IDLE_LIVE, inFlight: true } })
check(
  'the cancel handler is handed the dialog-focus truth, the interview, the turn in flight, the stream mode and the composer modes',
  t.handed.cancel?.isInputDialogFocused === true && t.handed.cancel.isInterviewFocused === true && t.handed.cancel.focusedTurnActive === true && t.handed.cancel.streamMode === 'tool-use' && t.handed.cancel.isLocalJSXCommand === true && t.handed.cancel.isSearchingHistory === true && t.handed.cancel.isHelpOpen === true && t.handed.cancel.isMessageSelectorVisible === false && t.handed.cancel.screen === 'prompt' && t.handed.cancel.vimMode === (isVimModeEnabled() ? 'NORMAL' : undefined) && t.handed.cancel.compactWork === t.props().compactWork,
  said('cancel'),
)
await t.plant({ toolUseConfirmQueue: [other] })
check('a card of another tool is no interview', t.handed.cancel?.isInterviewFocused === false && t.handed.cancel.isInputDialogFocused === true, said('cancel'))
await t.plant({ focusedInputDialog: undefined, toolUseConfirmQueue: [ask], seatLive: IDLE_LIVE, dialogOwnsKeys: false, isSearchingHistory: false, helpOpen: false })
check('with no dialog in focus the handler is told so, and that no turn is in flight', t.handed.cancel?.isInputDialogFocused === false && t.handed.cancel.isInterviewFocused === false && t.handed.cancel.focusedTurnActive === false, said('cancel'))
await t.plant({ showMessageSelector: true })
const withSelector = t.handed.cancel?.isMessageSelectorVisible
await t.plant({ showMessageSelector: false, showBashesDialog: 'shell-1' })
const withShells = t.handed.cancel?.isMessageSelectorVisible
await t.plant({ showBashesDialog: true })
check('the message selector and the shells dialog both read as a selector to the cancel handler', withSelector === true && withShells === true && t.handed.cancel?.isMessageSelectorVisible === true, `${String(withSelector)} · ${String(withShells)} · ${said('cancel')}`)
await t.plant({ showBashesDialog: false })

section('§2 Escape is held for the three that take the key and register no overlay')
check('with none of them up Escape is not held', t.escapeHeld() === false)
for (const [label, on, off] of [
  ['the shortcuts help', { helpOpen: true }, { helpOpen: false }],
  ['the history search', { isSearchingHistory: true }, { isSearchingHistory: false }],
  ['the message cursor', { messageCursorActive: true }, { messageCursorActive: false }],
] as const) {
  await t.plant(on)
  const held = t.escapeHeld()
  await t.plant(off)
  check(`${label} holds Escape while it is up and lets go when it closes`, held === true && t.escapeHeld() === false, `${String(held)} · ${String(t.escapeHeld())}`)
}

section('§3 suspend and resume')
const mountedOnce = t.bodyMounts()
await t.emit('suspend')
check('in the fullscreen layout a suspend writes nothing to the terminal', t.written.length === 0 && t.bodyMounts() === mountedOnce, JSON.stringify(t.written))
await t.emit('resume')
check('a resume mounts what the part wraps once more and keeps its handlers', mountedOnce === 1 && t.bodyMounts() === 2 && t.handed.global !== null && t.handed.cancel !== null, `${mountedOnce} → ${t.bodyMounts()}`)
await t.plant({ fullscreen: false })
await t.emit('suspend')
check('outside the fullscreen layout a suspend writes how to come back', t.written.length === 1 && t.written[0]!.includes('Mercury suspended') && t.written[0]!.includes('`fg` brings it back'), JSON.stringify(t.written))
await t.plant({ fullscreen: true })

section('§4 the dump of the transcript: three handlers and no layout of the part')
await t.plant({ legacyTranscript: true, messageCursorActive: true })
check('the dump mounts the global, command and cancel handlers and neither the scroll handler nor the message actions', t.handed.global !== null && t.handed.command !== null && t.handed.cancel !== null && t.handed.scroll === null && t.handed.actions === null, Object.entries(t.handed).map(([name, props]) => `${name} ${props === null ? 'absent' : 'mounted'}`).join(' · '))
const mountedInDump = t.bodyMounts()
await t.emit('resume')
check('and a resume there mounts nothing again', t.bodyMounts() === mountedInDump, `${mountedInDump} → ${t.bodyMounts()}`)

await t.close()
console.log(`\n${failures === 0 ? 'prove-chat-keys-part: ALL PASS' : `prove-chat-keys-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
