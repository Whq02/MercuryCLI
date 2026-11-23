#!/usr/bin/env bun
import { settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { mountPart, openAsksPart } from './chatScenarios.ts'

let failures = 0
let where = ''
const WHERE: Record<string, string> = {
  '§1': 'fix useChatAsks (queue, resolveHeadPermission) in src/screen/chat/useChatAsks.tsx',
  '§2': 'fix the mode mirror in useChatAsks (setToolPermissionContext) in src/screen/chat/useChatAsks.tsx, or recordModeTransition in src/permissions/rules/modeTransitions.ts',
  '§3': 'fix refuseGestureWhileModal in src/permissions/rules/permissionFocus.ts',
  '§4': 'fix respondToElicitation and dismissElicitationWaiting in src/screen/chat/useChatAsks.tsx',
  '§5': 'fix useChatAsksCard in src/screen/chat/useChatAsks.tsx',
  '§6': 'fix the mode-change recording in src/permissions/rules/modeTransitions.ts and the AppState relay it is read through',
  '§7': "fix the mount arm beside adoptRunnerMode in useChatAsks (src/screen/chat/useChatAsks.tsx): the chat's copy takes the focused session's mode at mount only when a live runner holds it (modelFacts().effectiveSource is 'live')",
}
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  const hint = !ok && where ? `${detail ? ' · ' : ''}${where}` : ''
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && (detail || hint) ? ` — ${detail}${hint}` : ''}`)
}
function section(title: string): void {
  where = WHERE[title.slice(0, 2)] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const t = await openAsksPart('chat-asks-part')
const { part, calls, notices } = t
const { useChatAsksCard } = t.module
const React = await import('react')
const h = React.createElement
const { modeTransitions, clearModeTransitions } = await import('../../src/permissions/rules/modeTransitions.ts')
const { armPermissionFocus, refuseGestureWhileModal } = await import('../../src/permissions/rules/permissionFocus.ts')
const act = async (run: () => void): Promise<void> => {
  run()
  await settle(80)
}

section('§1 the hook alone: the queue of asks and the answer to its head')
check('with no ask the queue is empty and nothing is resolved', part.value().toolUseConfirmQueue.length === 0 && part.value().resolvedConsentCount === 0 && part.value().sessionAsks.length === 0)
const three = [t.ask('toolu_a', 'touch a.txt'), t.ask('toolu_b', 'touch b.txt'), t.ask('toolu_c', 'touch c.txt')]
await t.setAsks(three)
check("the session's asks arrive in their order, each as the confirm of its ask", part.value().toolUseConfirmQueue.map(confirm => confirm.toolUseID).join() === 'toolu_a,toolu_b,toolu_c' && part.value().toolUseConfirmQueue[0] === three[0]!.confirm)
await act(() => part.value().resolveHeadPermission())
check('answering the head counts one resolved and settles that ask on the session, in the same call', part.value().resolvedConsentCount === 1 && calls.join() === 'settleAsk toolu_a', `${part.value().resolvedConsentCount} · ${calls.join()}`)
check('the session pops the head: two asks stand, the second is the head now', part.value().toolUseConfirmQueue.map(confirm => confirm.toolUseID).join() === 'toolu_b,toolu_c')
await act(() => part.value().resolveHeadPermission())
await act(() => part.value().resolveHeadPermission())
check('the count follows each answer until the queue is drained, then starts again from nothing', part.value().toolUseConfirmQueue.length === 0 && part.value().resolvedConsentCount === 0 && calls.join() === 'settleAsk toolu_a,settleAsk toolu_b,settleAsk toolu_c', `${part.value().resolvedConsentCount} · ${calls.join()}`)

section('§2 the hook alone: the permission mode, mirrored from the runner and handed to it')
clearModeTransitions()
const startMode = t.mode()
await t.setRunnerMode('implement')
const adopted = modeTransitions().find(entry => entry.road === 'screen-mirror')
check("the runner's own mode is adopted into the app state", t.mode() === 'implement', `${startMode} → ${t.mode()}`)
check("and the change is written on the road 'screen-mirror', once", adopted?.road === 'screen-mirror' && adopted.from === startMode && adopted.to === 'implement' && adopted.detail === "the runner's own mode adopted" && modeTransitions().length === 1, JSON.stringify(modeTransitions()))
const before = modeTransitions().length
await t.setRunnerMode('implement')
check('the same mode heard again changes nothing and writes nothing', t.mode() === 'implement' && modeTransitions().length === before, `${modeTransitions().length} entries, ${before} before`)
calls.length = 0
await t.setAsks([t.ask('toolu_d', 'touch d.txt')])
const context = part.store().getState().toolPermissionContext
await act(() => part.value().setToolPermissionContext({ ...context, mode: 'apollo' }))
await settle(60)
const handed = modeTransitions().findLast(entry => entry.road === 'screen-mirror')
check('a mode chosen on the screen is set in the app state, written on the same road and handed to the session', t.mode() === 'apollo' && handed?.road === 'screen-mirror' && handed.to === 'apollo' && calls.includes('setPermissionMode apollo'), `${t.mode()} · ${JSON.stringify(handed)} · ${calls.join()}`)
check('and the asks that stand are checked again against the new mode, one tick later', calls.includes('ask toolu_d rechecked'), calls.join())
calls.length = 0
await act(() => part.value().setToolPermissionContext({ ...part.store().getState().toolPermissionContext, mode: 'default' }, { preserveMode: true }))
await settle(60)
check('a context handed over with its mode preserved keeps the mode and tells the session nothing', t.mode() === 'apollo' && !calls.some(call => call.startsWith('setPermissionMode')), `${t.mode()} · ${calls.join()}`)
t.refuseModes('the runner did not take it')
notices.length = 0
await act(() => part.value().setToolPermissionContext({ ...part.store().getState().toolPermissionContext, mode: 'implement' }))
await waitFor(() => notices.some(notice => notice.key === 'permission-mode-refused'), 2000)
check('a mode the session refuses is told on the screen with its reason', notices.some(notice => notice.key === 'permission-mode-refused' && notice.text.includes('refused by the session — the runner did not take it')), JSON.stringify(notices))
check("and the screen goes back to the runner's own mode", t.mode() === 'apollo', t.mode())
await t.setAsks([])

section('§3 the hook alone: a gesture refused while a card is up is told as a notice')
notices.length = 0
const release = armPermissionFocus()
refuseGestureWhileModal('the click')
release()
check('the refusal reaches the screen as its own notice', notices.length === 1 && notices[0]!.key === 'permission-focus-refusal' && notices[0]!.text.startsWith('the click waits'), JSON.stringify(notices))

section('§4 the hook alone: the elicitations of the MCP servers')
const answers: string[] = []
const elicitation = (id: number, mode?: string): Record<string, unknown> => ({
  serverName: 'proof-server',
  requestId: id,
  params: { message: `question ${id}`, ...(mode === undefined ? {} : { mode }) },
  signal: new AbortController().signal,
  respond: (result: { action: string }) => void answers.push(`${id} ${result.action}`),
  onWaitingDismiss: (action: string) => void answers.push(`${id} waiting ${action}`),
})
await act(() => part.store().setState(prev => ({ ...prev, elicitation: { queue: [elicitation(1), elicitation(2, 'url'), elicitation(3)] as never } })))
check('the queue of the app state is the queue of the part', part.value().elicitationQueue.length === 3)
await act(() => part.value().respondToElicitation('decline'))
check('an answer goes to the head and takes it off the queue', answers.join() === '1 decline' && part.value().elicitationQueue.length === 2, answers.join())
await act(() => part.value().respondToElicitation('accept'))
check('an accepted url elicitation is answered and stays while its page is open', answers.join() === '1 decline,2 accept' && part.value().elicitationQueue.length === 2, answers.join())
await act(() => part.value().dismissElicitationWaiting('cancel'))
check('dismissing the wait takes it off the queue and tells its owner', answers.join() === '1 decline,2 accept,2 waiting cancel' && part.value().elicitationQueue.length === 1, answers.join())
const builder = t.ask
await t.close()

section('§5 the card alone: when it is drawn and what it tells the scroll')
{
  let pins = 0
  const queue = [builder('toolu_x', 'touch x.txt').confirm, builder('toolu_y', 'touch y.txt').confirm]
  type CardArgs = Parameters<typeof useChatAsksCard>[0]
  let args: CardArgs = { focusedInputDialog: undefined, repinToBottom: () => void pins++, toolUseConfirmQueue: queue as never, resolvedConsentCount: 1, resolveHeadPermission: () => {}, chatSurfaceCovered: false, verbose: false }
  const plant = (over: Partial<CardArgs>) => (): ReturnType<typeof useChatAsksCard> => useChatAsksCard((args = { ...args, ...over }))
  const card = await mountPart(plant({}), { columns: 110, rows: 24, draw: value => h(React.Fragment, null, value.permissionOverlay) })
  const shown = (): string => card.view.lines().join('\n')
  check('with no card in focus nothing is drawn and the scroll is left alone', card.value().permissionOverlay === null && pins === 0)
  await card.set(plant({ focusedInputDialog: 'tool-permission' }))
  await waitFor(() => shown().includes('touch x.txt'), 4000)
  check('with the card in focus the head ask is drawn with its command', shown().includes('touch x.txt') && shown().includes('Do you want to proceed'), shown())
  check('and its place in the sequence: the second of three, one answered and two waiting', shown().includes('2/3'), shown())
  check('the card taking the focus pins the transcript to the bottom once', pins === 1, String(pins))
  await card.set(plant({ focusedInputDialog: 'tool-permission', verbose: true }))
  check('a change that does not move the focus pins nothing', pins === 1, String(pins))
  await card.set(plant({ chatSurfaceCovered: true }))
  check('while another surface covers the chat the card is not drawn', card.value().permissionOverlay === null && !shown().includes('touch x.txt'))
  await card.set(plant({ chatSurfaceCovered: false }))
  check('the part hands back the card and nothing else', Object.keys(card.value()).join() === 'permissionOverlay', Object.keys(card.value()).join())
  await card.set(plant({ focusedInputDialog: undefined }))
  await settle(120)
  check('the card losing the focus pins the transcript once more', pins === 2 && card.value().permissionOverlay === null, `${pins} · ${shown()}`)
  card.unmount()
}

section('§6 the relay of the app state: a change of mode is recorded once, under the root of the screen and under a bare provider')
{
  const { mountOffscreen } = await import('../lib/settingsPopupHarness.ts')
  const { AppStateProvider, useAppStateStore } = await import('../../src/screen/app-state/AppState.tsx')
  const { lastModeTransitionFrom, recordModeTransition } = await import('../../src/permissions/rules/modeTransitions.ts')
  const { setPermissionModeChangedListener } = await import('../../src/permissions/rules/permissionModeListener.ts')
  type ModeStore = ReturnType<typeof useAppStateStore>
  const told: string[] = []
  setPermissionModeChangedListener(mode => void told.push(mode))
  const rows = (): string => modeTransitions().map(entry => `${entry.from} → ${entry.to} via ${entry.road}`).join(' | ')
  const setMode = (store: ModeStore, mode: string): void => store.setState(prev => ({ ...prev, toolPermissionContext: { ...prev.toolPermissionContext, mode: mode as never } }))
  const root = await mountPart(() => null)
  const first = root.store().getState().toolPermissionContext.mode
  clearModeTransitions()
  told.length = 0
  recordModeTransition({ from: first, to: 'apollo', road: 'carousel' })
  await act(() => setMode(root.store(), 'apollo'))
  check('under the root of the screen a change of mode its writer announced is one row of the mode record, on the road announced', rows() === `${first} → apollo via carousel`, rows())
  check('and the permission-mode listener is told once', told.join() === 'apollo', told.join())
  recordModeTransition({ from: 'apollo', to: 'implement', road: 'review-approval', detail: 'the spec was approved' })
  await act(() => setMode(root.store(), 'implement'))
  const exit = lastModeTransitionFrom('apollo')
  check('the reader of why a mode ended answers the road its writer announced, with its detail', exit?.road === 'review-approval' && exit.detail === 'the spec was approved' && modeTransitions().length === 2, `${rows()} · ${JSON.stringify(exit)}`)
  root.unmount()
  let bare: ModeStore | undefined
  function Tap(): null {
    bare = useAppStateStore()
    return null
  }
  const view = await mountOffscreen(h(AppStateProvider, null, h(Tap)), 60, 6)
  await settle(80)
  clearModeTransitions()
  told.length = 0
  const bareFirst = bare!.getState().toolPermissionContext.mode
  await act(() => setMode(bare!, bareFirst === 'apollo' ? 'implement' : 'apollo'))
  check('under a provider mounted bare, as a dialog mounts it, a change nobody announced is one row too, and one telling', modeTransitions().length === 1 && modeTransitions()[0]!.road === 'unnamed' && told.length === 1, `${rows()} · told ${told.join()}`)
  view.unmount()
  setPermissionModeChangedListener(null)
  clearModeTransitions()
}

section("§7 the hook mounts onto a session already in focus: a live runner's mode is taken at once, a session still waiting for its runner is left alone")
{
  const other = startMode === 'flow' ? 'implement' : 'flow'
  const live = await openAsksPart('chat-asks-mount-live', { held: { mode: other, facts: 'live' } })
  check("mounted onto a live runner, the app state holds the runner's mode before any mode event", live.mode() === other, `${startMode} → ${live.mode()}`)
  check('and the session was told nothing: only the copy moved', !live.calls.some(call => call.startsWith('setPermissionMode')), live.calls.join())
  await live.close()
  const waiting = await openAsksPart('chat-asks-mount-waiting', { held: { mode: other, facts: 'record' } })
  check('mounted onto a session whose runner has not answered yet, the app state keeps the mode the screen started in', waiting.mode() === startMode, waiting.mode())
  await waiting.setRunnerMode(other)
  check("and it takes the runner's mode when the runner's own word arrives", waiting.mode() === other, waiting.mode())
  await waiting.close()
  clearModeTransitions()
}

console.log(`\n${failures === 0 ? 'prove-chat-asks-part: ALL PASS' : `prove-chat-asks-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
