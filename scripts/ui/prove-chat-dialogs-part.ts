#!/usr/bin/env bun
import { mock } from 'bun:test'
import { settle, waitFor } from '../lib/settingsPopupHarness.ts'
import { mountPart, openDialogsPart } from './chatScenarios.ts'

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

const t = await openDialogsPart('chat-dialogs-part')
const React = await import('react')
const h = React.createElement
const { Text } = await import('../../src/screen/themedRenderer.ts')
const { BackgroundTasksDialog } = await import('../../src/screen/tasks/BackgroundTasksDialog.tsx')
const { restoreWorktreeSession } = await import('../../src/platform/git/worktree/worktree.ts')
const { getGlobalConfig } = await import('../../src/platform/settings/config.ts')
const { createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { useChatDialogs, useChatDialogPaints, useChatDialogsView } = t.module
const exits: Array<() => void> = []
mock.module('../../src/commands/exit/exit.tsx', () => ({
  call: async (done: () => void) => {
    exits.push(done)
    return h(Text, null, 'THE EXIT COMMAND')
  },
}))
const act = async (run: () => void): Promise<void> => {
  run()
  await settle(80)
}
const rows = (count: number): never[] => Array.from({ length: count }, (_, at) => createUserMessage({ content: `row ${at}` })) as never[]
const local = { jsx: h(Text, null, 'A LOCAL DIALOG'), shouldHideComposer: false, isLocalJSXCommand: true, isImmediate: true } as never

section('§1 the view: the cost threshold', 'what to change: the cost-threshold branch of focusedBottomDialog in useChatDialogsView, src/screen/chat/useChatDialogs.tsx (and the cost-threshold dialog it draws)')
await t.plant({ messages: rows(1) })
check('under the threshold nothing is asked', t.costShown.length === 0, JSON.stringify(t.costShown))
t.setUsage(6, true)
await t.plant({ messages: rows(2) })
check('a session over the threshold on console billing is asked to acknowledge its cost, when a row arrives', t.costShown.join() === 'true', JSON.stringify(t.costShown))
await t.plant({ messages: rows(3) })
check('and is asked once', t.costShown.join() === 'true', JSON.stringify(t.costShown))
await t.plant({ focusedInputDialog: 'cost-threshold' })
await waitFor(() => t.frame().includes("You've spent"), 3000)
check('with the cost threshold in focus its dialog is drawn', t.frame().includes("You've spent") && t.frame().includes('/usage'), t.frame())
t.part.view.push('\r')
await waitFor(() => t.costShown.length === 2, 3000)
check('acknowledging it takes the dialog down and writes the acknowledgement to the config', t.costShown.join() === 'true,false' && getGlobalConfig().hasAcknowledgedCostThreshold === true, `${JSON.stringify(t.costShown)} · ${String(getGlobalConfig().hasAcknowledgedCostThreshold)}`)
await t.plant({ chatSurfaceCovered: true })
check('while another surface covers the chat no bottom dialog is drawn', t.part.value().focusedBottomDialog === null && !t.frame().includes("You've spent"), t.frame())
await t.plant({ chatSurfaceCovered: false, focusedInputDialog: undefined })

section('§2 the view: the elicitation and the offer to reopen a crashed session', 'what to change: the elicitation and crash-resume branches of focusedBottomDialog in useChatDialogsView, src/screen/chat/useChatDialogs.tsx')
const answers: string[] = []
const elicitation = { serverName: 'proof-server', requestId: 1, params: { message: 'Which branch should the server use?', requestedSchema: { type: 'object', properties: { branch: { type: 'string', title: 'Branch' } }, required: ['branch'] } }, signal: new AbortController().signal, respond: () => {} }
await t.plant({ focusedInputDialog: 'elicitation', elicitationQueue: [elicitation] as never, respondToElicitation: ((action: string) => void answers.push(action)) as never })
await waitFor(() => t.frame().includes('Which branch should the server use?'), 3000)
check('with an elicitation in focus the head of the queue is drawn', t.frame().includes('Which branch should the server use?'), t.frame())
t.part.view.push('\x1b')
await waitFor(() => answers.length === 1, 3000)
check('and its answer goes to the handler the part was handed', answers.length === 1, answers.join())
const crashed = { origin: 'app-root', component: null, message: 'a planted crash of an earlier session', sessionId: 'rec-crashed-0001', cwd: '/proof/crashed-project', transcriptPath: '/proof/crashed-project/rec-crashed-0001.jsonl', moreCount: 2 }
await t.plant({ focusedInputDialog: 'crash-resume', elicitationQueue: [], crashResumeStaged: crashed })
await waitFor(() => t.frame().includes('Resume that session'), 3000)
check('with a crashed session staged its offer is drawn with the session, its folder and how many more reports there are', t.frame().includes('previous session crashed') && t.frame().includes('session rec-cras') && t.frame().includes('crashed-project') && t.frame().includes('+2 more'), t.frame())
t.part.view.push('\r')
await waitFor(() => t.hops.length === 1 && t.removed.includes('session-switch'), 3000)
check('choosing to resume clears the staged offer, says it is opening the session and hops into it with its transcript and the mode of the screen', t.staged.length === 1 && t.staged[0] === null && t.notices.some(notice => notice.key === 'session-switch' && notice.text === 'opening rec-cras…') && t.hops[0]![0] === 'rec-crashed-0001' && t.hops[0]![1] === '/proof/crashed-project/rec-crashed-0001.jsonl' && (t.hops[0]![2] as { permissionMode?: string }).permissionMode === t.part.store().getState().toolPermissionContext.mode && t.removed.join() === 'session-switch', `${JSON.stringify(t.staged)} · ${JSON.stringify(t.notices)} · ${JSON.stringify(t.hops)} · ${t.removed.join()}`)
check('a hop that lands tells nothing more', !t.notices.some(notice => notice.key === 'resume-hop'), JSON.stringify(t.notices))
t.hop.outcome = { ok: false, reason: 'the daemon holds no seat for it' }
await t.plant({ crashResumeStaged: { ...crashed, sessionId: 'rec-crashed-0002' } })
t.part.view.push('\r')
await waitFor(() => t.notices.some(notice => notice.key === 'resume-hop'), 3000)
check('a hop that fails is told with its reason', t.notices.some(notice => notice.key === 'resume-hop' && notice.text === 'the crashed session could not be reopened — the daemon holds no seat for it'), JSON.stringify(t.notices))
t.staged.length = 0
t.hops.length = 0
await t.plant({ crashResumeStaged: { ...crashed, sessionId: 'rec-crashed-0003' } })
t.part.view.push('\x1b')
await waitFor(() => t.staged.length === 1, 3000)
check('dismissing the offer clears it and hops nowhere', t.staged[0] === null && t.hops.length === 0, `${JSON.stringify(t.staged)} · ${t.hops.length}`)
await t.plant({ focusedInputDialog: undefined, crashResumeStaged: null })

section('§3 the view: where the dialog of a command is drawn', 'what to change: centredModalUp, centredModal, inlineToolJsx, bottomImmediateJsx and toolJSXRef in useChatDialogsView, src/screen/chat/useChatDialogs.tsx')
const slotOf = (node: unknown): unknown => (node as { props?: { children?: unknown } } | null)?.props?.children
await t.plant({ toolJSX: local, localJsx: true, fullscreen: true })
check('in the fullscreen layout a local dialog is the centred modal and nothing is drawn inline', t.part.value().centredModalUp === true && slotOf(t.part.value().centredModal) === (local as { jsx: unknown }).jsx && t.part.value().inlineToolJsx === null && t.part.value().bottomImmediateJsx === null)
check('the ref the part hands on holds the dialog of this render', t.part.value().toolJSXRef.current === local)
await t.plant({ fullscreen: false })
check('outside it an immediate local dialog is drawn at the bottom', t.part.value().centredModalUp === false && t.part.value().centredModal === null && slotOf(t.part.value().bottomImmediateJsx) === (local as { jsx: unknown }).jsx && t.part.value().inlineToolJsx === null)
const tool = { jsx: h(Text, null, 'A TOOL ROW'), shouldHideComposer: false } as never
await t.plant({ toolJSX: tool, localJsx: false, fullscreen: true })
check('the row of a tool is drawn inline', t.part.value().centredModalUp === false && slotOf(t.part.value().inlineToolJsx) === (tool as { jsx: unknown }).jsx && t.frame().includes('A TOOL ROW'), t.frame())
t.contexts.length = 0
const three = rows(3)
await t.plant({ toolJSX: null, compactDetailUp: true, messages: three, focusedEffectiveModel: 'claude-opus-4-5' })
const modal = t.part.value().centredModal as { type?: unknown; props?: Record<string, unknown> } | null
check(
  'the detail of the compact summary is the background tasks dialog, handed one context built for the rows and the model in focus',
  t.part.value().centredModalUp === true && modal?.type === BackgroundTasksDialog && modal.props?.entry === 'compact-summary' && modal.props.compactControls === undefined === false && t.contexts.length === 1 && t.contexts[0]![0] === three && Array.isArray(t.contexts[0]![1]) && (t.contexts[0]![1] as unknown[]).length === 0 && t.contexts[0]![2] instanceof AbortController && t.contexts[0]![3] === 'claude-opus-4-5' && (modal.props.toolUseContext as { planted?: string }).planted === 'context',
  `${String(modal?.type === BackgroundTasksDialog)} · ${JSON.stringify(modal?.props?.entry)} · ${t.contexts.length} contexts`,
)
await t.close()

section('§4 the states: the dialog of a command, the exit and the shells dialog', 'what to change: the setters and handleExit in useChatDialogs, src/screen/chat/useChatDialogs.tsx')
{
  const states = await mountPart(store => useChatDialogs({ store }))
  check('the part starts with no dialog, not exiting, nothing asked', states.value().toolJSX === null && states.value().isExiting === false && states.value().showExitFlow === false && states.value().exitCommandJsx === null && states.value().showCostThreshold === false && states.value().showBashesDialog === false)
  await act(() => states.value().setToolJSX(local))
  check('a dialog a command sets is held', states.value().toolJSX === local)
  await act(() => states.value().setToolJSX({ jsx: null, shouldHideComposer: false, clearUnlessLocalJSX: true } as never))
  check('a clear that spares local dialogs leaves it', states.value().toolJSX === local)
  await act(() => states.value().setToolJSX(null))
  check('and a plain clear takes it down', states.value().toolJSX === null)
  await act(() => states.value().setShowBashesDialog('shell-1'))
  await act(() => states.value().setShowCostThreshold(true))
  check('the shells dialog and the cost threshold are set through the setters the part hands on', states.value().showBashesDialog === 'shell-1' && states.value().showCostThreshold === true)
  restoreWorktreeSession({ originalCwd: process.cwd(), worktreePath: process.cwd(), worktreeName: 'proof-tree', sessionId: 'chat-dialogs-part' })
  await act(() => states.value().handleExit())
  check('an exit asked for inside a worktree opens the exit flow and loads no exit command', states.value().showExitFlow === true && states.value().isExiting === false && exits.length === 0, `${String(states.value().showExitFlow)} · ${exits.length}`)
  await act(() => states.value().setShowExitFlow(false))
  restoreWorktreeSession(null)
  await act(() => states.value().handleExit())
  await waitFor(() => exits.length === 1 && states.value().exitCommandJsx !== null, 3000)
  check('outside one it marks the screen as exiting and holds what the exit command draws', states.value().isExiting === true && exits.length === 1 && states.value().exitCommandJsx !== null, `${String(states.value().isExiting)} · ${exits.length}`)
  await act(() => exits[0]!())
  check('the exit command saying it is done clears both', states.value().isExiting === false && states.value().exitCommandJsx === null)
  states.unmount()
}

section('§5 the paints: whether the dialog owns the keys, and the detail of the compact summary', 'what to change: compactDetailUp, dialogPaints and dialogOwnsKeys in useChatDialogPaints, src/screen/chat/useChatDialogs.tsx')
{
  let focus: 'composer' | 'detail' = 'detail'
  const sets: string[] = []
  const compactWork = { read: () => focus, set: (next: 'composer' | 'detail') => void sets.push(next), toggleSummary: () => {}, bindToggle: () => {}, detailState: { selectedId: null, detailTaskId: undefined } }
  type PaintArgs = Parameters<typeof useChatDialogPaints>[0]
  let args: PaintArgs = { toolJSX: null, compactFocus: 'composer', compactWork: compactWork as never, fullscreen: true, chatSurfaceCovered: false, focusedInputDialog: undefined }
  const use = (store: Parameters<Parameters<typeof mountPart>[0]>[0]): ReturnType<typeof useChatDialogPaints> & { inline: unknown } => {
    const paints = useChatDialogPaints(args)
    const view = useChatDialogsView({ toolJSX: args.toolJSX, dialogSlotRef: paints.dialogSlotRef, localJsx: paints.localJsx, compactDetailUp: paints.compactDetailUp, setShowCostThreshold: () => {}, messages: [], fullscreen: false, compactWork: compactWork as never, getToolUseContext: (() => ({})) as never, focusedEffectiveModel: 'claude-sonnet-4-5', chatSurfaceCovered: false, focusedInputDialog: undefined, elicitationQueue: [], respondToElicitation: () => {}, dismissElicitationWaiting: () => {}, crashResumeStaged: null, setCrashResumeStaged: () => {}, addNotification: (() => {}) as never, removeNotification: (() => {}) as never, store })
    return { ...paints, inline: view.bottomImmediateJsx }
  }
  const paints = await mountPart(use, { draw: value => value.inline as never })
  const plant = async (over: Partial<PaintArgs>): Promise<void> => {
    args = { ...args, ...over }
    await paints.set(use)
    await settle(120)
  }
  await settle(120)
  check('with no dialog and the composer in focus nothing owns the keys, and the compact focus is put back on the composer', paints.value().dialogPaints === false && paints.value().localJsx === false && paints.value().compactDetailUp === false && paints.value().dialogOwnsKeys === false && sets.join() === 'composer', sets.join())
  focus = 'composer'
  sets.length = 0
  await plant({ compactFocus: 'detail' })
  check('the detail of the compact summary is up in the fullscreen layout with no dialog in focus, and owns the keys', paints.value().compactDetailUp === true && paints.value().dialogOwnsKeys === true && sets.length === 0, sets.join())
  await plant({ focusedInputDialog: 'tool-permission' })
  const underCard = paints.value().compactDetailUp
  await plant({ focusedInputDialog: undefined, chatSurfaceCovered: true })
  const covered = paints.value().compactDetailUp
  await plant({ chatSurfaceCovered: false, fullscreen: false })
  const outside = paints.value().compactDetailUp
  check('a dialog in focus, a covering surface and the plain layout each take it down', underCard === false && covered === false && outside === false, `${underCard} · ${covered} · ${outside}`)
  await plant({ fullscreen: true, compactFocus: 'composer', toolJSX: local })
  await waitFor(() => paints.value().dialogPaints === true, 3000)
  check('a local dialog that is drawn with a height owns the keys', paints.value().localJsx === true && paints.value().dialogPaints === true && paints.value().dialogOwnsKeys === true && paints.view.lines().join('\n').includes('A LOCAL DIALOG'), paints.view.lines().join('\n'))
  await plant({ compactFocus: 'detail' })
  check('and keeps the detail of the compact summary down', paints.value().compactDetailUp === false && paints.value().dialogOwnsKeys === true)
  await plant({ toolJSX: null, compactFocus: 'composer' })
  await waitFor(() => paints.value().dialogPaints === false, 3000)
  check('when the dialog leaves nothing owns the keys', paints.value().dialogPaints === false && paints.value().dialogOwnsKeys === false)
  paints.unmount()
}

console.log(`\n${failures === 0 ? 'prove-chat-dialogs-part: ALL PASS' : `prove-chat-dialogs-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
