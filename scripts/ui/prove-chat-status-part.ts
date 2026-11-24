#!/usr/bin/env bun
import { settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { openStatusPart } from './chatScenarios.ts'

const STATUS_PART_HINT = 'change the status part in src/screen/chat/useChatStatus.tsx (the turn boundary, seat clock, tip, signals and spinner rows this check reads)'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${STATUS_PART_HINT}${detail ? `: ${detail}` : ''}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const t = await openStatusPart('chat-status-part')
const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
const { FOLD_ROW_HEAD } = await import('../../src/engine/compaction/foldStatus.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { BASH_INPUT_TAG } = await import('../../src/engine/message-shapes/messageTags.ts')
type Live = typeof IDLE_LIVE
const live = (over: Partial<Live>): Live => ({ ...IDLE_LIVE, ...over })
const state = (): ReturnType<ReturnType<typeof t.part.store>['getState']> => t.part.store().getState()
const told = (): string => t.notices.splice(0).map(notice => `${notice.key}: ${notice.text}`).join(' | ')
const rows = (): string => (['spinner', 'hold', 'rollup'] as const).filter(name => t.handed[name] !== null).join('+')

section('§1 the turn boundary: the foreground flag and the model switch that waited')
check('at rest the app state says no turn is in the foreground', state().foregroundTurnActive === false && t.part.value().pendingModelSwitch === null)
await t.plant({ seatLive: live({ inFlight: true, phase: 'thinking' }) })
check('a turn in flight sets the flag', state().foregroundTurnActive === true)
t.part.store().setState(prev => ({ ...prev, pendingModelSwitch: { setting: 'claude-opus-4-5' } }))
await settle(80)
check('a model picked while the turn runs waits, and the part hands it on', t.part.value().pendingModelSwitch?.setting === 'claude-opus-4-5' && state().engineModel !== 'claude-opus-4-5' && told() === '', JSON.stringify(state().pendingModelSwitch))
await t.plant({ seatLive: live({ inFlight: false, phase: 'idle' }) })
check('at the end of the turn the flag falls and the switch is applied once: the model, the receipt and nothing left waiting', state().foregroundTurnActive === false && state().engineModel === 'claude-opus-4-5' && state().pendingModelSwitch === null && state().lastModelTransition?.applied === 'claude-opus-4-5' && state().lastModelTransition?.boundary === 'turn-boundary', JSON.stringify(state().lastModelTransition))
const applied = told()
check('and the screen says which model was applied and that it was queued during the turn', /^model-transition-applied: .+ applied — queued during the turn/.test(applied), applied)
t.part.store().setState(prev => ({ ...prev, pendingModelSwitch: { setting: null } }))
await settle(80)
check('a switch to the default with no turn running is applied at once and named Default', state().pendingModelSwitch === null && told().startsWith('model-transition-applied: Default applied — queued during the turn'))
await t.plant({ messages: [createUserMessage({ content: 'a later render' }) as never] })
check('a later render applies nothing again', told() === '')

section('§2 the seat clock: the start of the turn and the pause while a card has the focus')
const clock = t.part.value()
await t.plant({ seatLive: live({ inFlight: true, phase: 'tool', turnStartedAtMs: 1_700_000_000_000 }) })
check('the clock starts where the session says the turn started, and the refs are the same from render to render', clock.seatStartTimeRef.current === 1_700_000_000_000 && t.part.value().seatStartTimeRef === clock.seatStartTimeRef && clock.seatPausedMsRef.current === 0 && clock.seatPauseStartRef.current === null, String(clock.seatStartTimeRef.current))
await t.plant({ focusedInputDialog: 'tool-permission' })
const pausedAt = clock.seatPauseStartRef.current
check('a permission card taking the focus while the turn runs starts a pause', typeof pausedAt === 'number' && pausedAt > 0)
await settle(120)
await t.plant({ focusedInputDialog: undefined })
check('the card leaving ends the pause and adds its length to what was paused', clock.seatPauseStartRef.current === null && clock.seatPausedMsRef.current >= 100, `${clock.seatPausedMsRef.current} ms`)
await t.plant({ focusedInputDialog: 'elicitation' })
check('another dialog pauses nothing', clock.seatPauseStartRef.current === null)
await t.plant({ focusedInputDialog: undefined, seatLive: live({ inFlight: false, phase: 'idle' }) })
await t.plant({ focusedInputDialog: 'tool-permission' })
check('nor does a card with no turn running', clock.seatPauseStartRef.current === null)
await t.plant({ focusedInputDialog: undefined })

section('§3 the end of a turn: the stamp, the clock and the tip')
const bash = (command: string): never => createUserMessage({ content: `<${BASH_INPUT_TAG}>${command}</${BASH_INPUT_TAG}>` }) as never
t.session.records = [bash('ls -la'), createAssistantMessage({ content: 'listed' }) as never]
t.tips.asked.length = 0
t.tips.next = 'a tip about the shell'
await t.plant({ seatLive: live({ inFlight: true, phase: 'thinking' }) })
check('while the turn runs nothing is stamped and no tip is asked for', t.part.value().lastCompletedAt === null && t.tips.asked.length === 0)
clock.seatPausedMsRef.current = 250
t.session.completedAt = 1000
const before = Date.now()
await t.plant({ seatLive: live({ inFlight: false, phase: 'idle' }) })
await waitFor(() => t.tips.shown.length === 1, 3000)
const stamped = t.part.value().lastCompletedAt
check('the session reporting a completed turn stamps the time, clears the pause of the clock and asks for one tip', typeof stamped === 'number' && stamped >= before && clock.seatPausedMsRef.current === 0 && clock.seatPauseStartRef.current === null && t.tips.asked.length === 1, `${String(stamped)} · ${t.tips.asked.length} tips asked`)
check('the tip is chosen knowing the shell commands the transcript holds, and is shown on the spinner', t.tips.asked[0]!.bashTools.join() === 'ls -la' && state().spinnerTip === 'a tip about the shell' && t.tips.shown.join() === 'a tip about the shell', `${JSON.stringify(t.tips.asked[0])} · ${String(state().spinnerTip)}`)
await t.plant({ messages: [] })
check('a later render with the same completion stamps nothing more and asks for no tip', t.part.value().lastCompletedAt === stamped && t.tips.asked.length === 1)
await t.plant({ seatLive: live({ inFlight: true, phase: 'thinking' }) })
t.session.completedAt = 2000
t.tips.next = null
await t.plant({ seatLive: live({ inFlight: false, phase: 'idle' }) })
await waitFor(() => state().spinnerTip === undefined, 3000)
check('the next completed turn asks again, and with no tip to show the spinner tip is cleared', t.tips.asked.length === 2 && state().spinnerTip === undefined && (t.part.value().lastCompletedAt ?? 0) >= (stamped ?? 0), `${t.tips.asked.length} asked · ${String(state().spinnerTip)}`)
const lastStamp = t.part.value().lastCompletedAt
t.session.completedAt = 3000
await t.focus('chat-status-other')
check('another session taking the focus is no completed turn: its own stamp is taken as the start', t.part.value().lastCompletedAt === lastStamp && t.tips.asked.length === 2, `${t.tips.asked.length} asked`)

section('§4 the signals of the turn for the cockpit')
await t.plant({ seatLive: live({ inFlight: true, phase: 'responding' }), textActive: true, toolUseConfirmQueue: [{ toolUseID: 'toolu_1' }] as never })
check('a turn that streams with a card waiting is published as live, streaming and awaiting permission', t.signals.turnSignals().turnLive === true && t.signals.turnSignals().streaming === true && t.signals.turnSignals().awaitingPermission === true && t.signals.turnSignals().lastTurnEndedInError === false, JSON.stringify(t.signals.turnSignals()))
await t.plant({ seatLive: live({ inFlight: false, phase: 'idle' }), textActive: false, toolUseConfirmQueue: [] })
check('at rest all of them fall, and the end of the turn is stamped', t.signals.turnSignals().turnLive === false && t.signals.turnSignals().streaming === false && t.signals.turnSignals().awaitingPermission === false && typeof t.signals.turnSignals().lastTurnEndTs === 'number', JSON.stringify(t.signals.turnSignals()))
const failed = { type: 'assistant', isApiErrorMessage: true, uuid: 'failed-1', message: { role: 'assistant', content: [{ type: 'text', text: 'API Error' }] } } as never
await t.plant({ messages: [failed] })
check('a turn whose last answer is an error is published as ended in error', t.signals.turnSignals().lastTurnEndedInError === true, JSON.stringify(t.signals.turnSignals()))
await t.plant({ messages: [] })

section('§5 the strip: which row stands in the status slot')
check('at rest the slot is not reserved and only the rollup of the turn is drawn', t.part.value().spinnerSlotReserved === false && rows() === 'rollup', rows())
const tools = new Set(['toolu_a', 'toolu_b'])
await t.plant({ seatLive: live({ inFlight: true, phase: 'tool', inProgressToolUseIDs: tools }), verbose: true, spinnerTip: 'a tip' as never })
const spinner = t.handed.spinner
check('a turn in flight reserves the slot and draws the spinner, in the mode of the phase', t.part.value().spinnerSlotReserved === true && rows() === 'spinner+rollup' && spinner?.mode === 'tool-use' && t.part.value().viewStreamMode === 'tool-use', `${rows()} · ${String(spinner?.mode)}`)
check('the tools in flight are the session\'s own set, and the spinner is told how many', t.part.value().viewInProgressToolUseIDs === tools && spinner?.activeToolCount === 2 && spinner.hasActiveTools === true && (spinner.hookWaitKeys as string[]).join() === 'toolu_a,toolu_b')
check('it is handed the clock of the seat, the tip, the verbosity and whether the lead is idle', spinner?.loadingStartTimeRef === clock.seatStartTimeRef && spinner.totalPausedMsRef === clock.seatPausedMsRef && spinner.pauseStartTimeRef === clock.seatPauseStartRef && spinner.spinnerTip === 'a tip' && spinner.verbose === true && spinner.leaderIsIdle === false && spinner.compact === false)
t.session.chars = 321
t.session.tokens = 45
t.session.facts = { thinkingChars: 7 }
check('the three live figures are read from the session in focus at the moment they are asked', (spinner?.responseLengthRef as { current: number }).current === 321 && (spinner?.outputTokensRef as { current: number | null }).current === 45 && (spinner?.liveTurnFactsRef as { current: { thinkingChars?: number } }).current.thinkingChars === 7)
for (const [phase, mode] of [['thinking', 'thinking'], ['tool', 'tool-use'], ['compacting', 'requesting'], ['waiting', 'requesting'], ['responding', 'responding']] as const) {
  await t.plant({ seatLive: live({ inFlight: true, phase }) })
  check(`the phase ${phase} is the spinner mode ${mode}`, t.handed.spinner?.mode === mode && t.part.value().viewStreamMode === mode, String(t.handed.spinner?.mode))
}
await t.plant({ seatLive: live({ inFlight: true, phase: 'compacting' }) })
check('while the session compacts the spinner stands still under the head of the fold', t.handed.spinner?.still === true && t.handed.spinner.overrideMessage === FOLD_ROW_HEAD, String(t.handed.spinner?.overrideMessage))
await t.plant({ seatLive: live({ inFlight: true, phase: 'waiting' }) })
check('a turn that waits on crewmates says so to the spinner, which moves again with no word over it', t.handed.spinner?.waitingOnCrewmates === true && t.handed.spinner.still === false && t.handed.spinner.overrideMessage === null)
await t.plant({ seatLive: live({ inFlight: true, phase: 'responding' }), textActive: true })
check('prose that streams swaps the spinner for the hold row, which keeps the slot and reads the same figures', rows() === 'hold+rollup' && t.part.value().spinnerSlotReserved === true && (t.handed.hold?.responseLengthRef as { current: number }).current === 321 && (t.handed.hold?.outputTokensRef as { current: number | null }).current === 45 && (t.handed.hold?.liveTurnFactsRef as { current: { thinkingChars?: number } }).current.thinkingChars === 7 && t.handed.hold?.loadingStartTimeRef === clock.seatStartTimeRef, rows())
await t.plant({ streamingSuppressed: true })
check('where the reveal is suppressed the spinner stands though prose streams', rows() === 'spinner+rollup', rows())
await t.plant({ streamingSuppressed: false, textActive: false, toolUseConfirmQueue: [{ toolUseID: 'toolu_1' }] as never })
check('a permission card waiting gives the slot up', t.part.value().spinnerSlotReserved === false && rows() === 'rollup', rows())
await t.plant({ toolUseConfirmQueue: [], toolJSX: { jsx: null, shouldHideComposer: false } as never })
const underDialog = t.part.value().spinnerSlotReserved
await t.plant({ toolJSX: { jsx: null, shouldHideComposer: false, showSpinner: true } as never })
check('so does the dialog of a command, unless it asks for the spinner', underDialog === false && t.part.value().spinnerSlotReserved === true && rows() === 'spinner+rollup', `${underDialog} · ${rows()}`)
const sleeping = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_sleep', name: 'Sleep', input: {} }] as never }) as never
await t.plant({ toolJSX: null, messages: [sleeping], seatLive: live({ inFlight: true, phase: 'tool', inProgressToolUseIDs: new Set(['toolu_sleep']) }) })
check('a turn whose only tool in flight is Sleep gives the slot up too', t.part.value().spinnerSlotReserved === false && rows() === 'rollup', rows())
await t.plant({ messages: [], seatLive: live({ inFlight: false, phase: 'idle' }), isStopping: true })
check('a turn that is stopping keeps the slot after the flight ended', t.part.value().spinnerSlotReserved === true && rows() === 'spinner+rollup' && t.handed.spinner?.leaderIsIdle === true, rows())
const hooks = [1, 2].map(count => ({ type: 'progress', data: { type: 'hook_progress', event: 'turn.answer', state: 'running', count: 2 } })) as never[]
await t.plant({ isStopping: false, seatLive: live({ inFlight: true, phase: 'responding' }), messages: hooks })
check('answer hooks that run are counted in the suffix of the spinner', t.handed.spinner?.spinnerSuffix === 'running answer hooks · 0/2', String(t.handed.spinner?.spinnerSuffix))
await t.plant({ messages: [], isCompact: true, textActive: true })
check('in the compact layout the spinner stays while prose streams and no rollup is drawn', rows() === 'spinner' && t.handed.spinner?.compact === true && t.handed.spinner.compactWarning === false, rows())
t.session.warns = true
await t.plant({ textActive: false })
check('a session that is stuck is said on the compact spinner, as a warning', t.handed.spinner?.compactWarning === true && String(t.handed.spinner.overrideMessage).includes('the session may be stuck'), String(t.handed.spinner?.overrideMessage))
t.session.warns = false
check('over all of it never more than one spinner stood at a time', t.mostSpinners() === 1, String(t.mostSpinners()))
await t.close()

console.log(`\n${failures === 0 ? 'prove-chat-status-part: ALL PASS' : `prove-chat-status-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
