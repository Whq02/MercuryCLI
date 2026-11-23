#!/usr/bin/env bun
import React from 'react'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('card-mark-keys-only')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const selectKeysHint = 'to fix, see Select in src/screen/select/Select.tsx and its key handling in src/screen/select/useSelectInput.ts (scrollMovesFocus, the wheel and page keys)'
const multiKeysHint = 'to fix, see SelectMulti in src/screen/select/SelectMulti.tsx and its key handling in src/screen/select/useMultiSelectState.ts (scrollMovesFocus)'
const cardKeysHint = 'to fix, see src/permissions/cards/PermissionPrompt.tsx, which passes scrollMovesFocus={false} to Select (key handling in src/screen/select/useSelectInput.ts)'
const consentKeysHint = 'to fix, see the dialog source (src/screen/mcp/MCPServerApprovalDialog.tsx, src/boot/first-run/SovereignModeDialog.tsx or src/screen/trust-dialog/TrustDialog.tsx), which must pass scrollMovesFocus={false} to Select'
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { Box, useInput } = await import('../../src/screen/themedRenderer.ts')
const { default: useStdin } = await import('../../src/screen/renderer/bindings/use-stdin.ts')
const { Select } = await import('../../src/screen/select/Select.tsx')
const { SelectMulti } = await import('../../src/screen/select/SelectMulti.tsx')
const { decodeDomNavKey } = await import('../../src/screen/widgets/navSemantics.ts')
const { KeyboardEvent } = await import('../../src/screen/renderer/events/keyboard-event.ts')
const { PermissionPrompt } = await import('../../src/permissions/cards/PermissionPrompt.tsx')
const { InputEvent } = await import('../../src/screen/renderer/events/input-event.ts')
const { INITIAL_STATE, parseMultipleKeypresses } = await import('../../src/screen/renderer/input/input-decoder.ts')
const { resolveAlternateScrollIntent } = await import('../../src/screen/renderer/termio/alternateScrollPolicy.ts')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

const h = React.createElement
const WHEEL_UP = '\x1b[<64;10;5M'
const WHEEL_DOWN = '\x1b[<65;10;5M'
const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
const TAB = '\t'

const through = { wheel: 0, page: 0 }
let keys: { emit: (name: string, event: unknown) => boolean } | null = null
function Behind(): React.ReactNode {
  const { internal_eventEmitter } = useStdin()
  keys = internal_eventEmitter
  React.useEffect(() => {
    const onWheel = (): void => { through.wheel++ }
    internal_eventEmitter.on('wheel', onWheel)
    return () => { internal_eventEmitter.removeListener('wheel', onWheel) }
  }, [internal_eventEmitter])
  useInput((_input, key) => {
    if (key.pageUp || key.pageDown) through.page++
  })
  return null
}

const mount = (element: React.ReactNode): Promise<Mounted> =>
  mountOffscreen(h(AppStateProvider, null, h(ThemeProvider, null, h(KeybindingSetup, null, h(Box, { width: 100, height: 24, flexDirection: 'column' }, element, h(Behind))))), 100, 24, { mouseTracking: true })
const mountWithoutMouse = (element: React.ReactNode): Promise<Mounted> =>
  mountOffscreen(h(AppStateProvider, null, h(ThemeProvider, null, h(KeybindingSetup, null, h(Box, { width: 100, height: 24, flexDirection: 'column' }, element, h(Behind))))), 100, 24)
const markOf = (view: Mounted): string => view.lines().find(line => /❯ \d\. /.test(line))?.trim().replace(/\s+/g, ' ').slice(0, 44) ?? '(no mark)'
async function press(view: Mounted, data: string): Promise<string> {
  view.push(data)
  await settle(120)
  return markOf(view)
}
const OPTIONS = [{ label: 'one', value: 'one' }, { label: 'two', value: 'two' }, { label: 'three', value: 'three' }]
const WINDOWS_BEFORE_A_WHEEL_REPORT = { altScreenActive: true, mouseTrackingEnabled: true, elevatedSurfaceActive: false, platform: 'win32', wheelReportingConfirmed: false, scrollableTranscript: true }
async function pressAsWindowsReadsIt(view: Mounted, arrow: string): Promise<string> {
  const [typed] = parseMultipleKeypresses(INITIAL_STATE, arrow)
  const [read] = resolveAlternateScrollIntent(typed, WINDOWS_BEFORE_A_WHEEL_REPORT)
  const event = new InputEvent(read as never, true)
  keys?.emit('input', event)
  if (!event.didStopImmediatePropagation()) keys?.emit('wheel', event)
  await settle(120)
  return markOf(view)
}

section('a list that is no card: the wheel and the page keys move its mark, as before')
{
  through.wheel = 0
  through.page = 0
  const view = await mount(h(Select, { options: OPTIONS, onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(view).startsWith('❯ 1.'), 5_000)
    check('it opens with the mark on its first row', markOf(view).startsWith('❯ 1. one'), markOf(view))
    const afterWheel = await press(view, WHEEL_DOWN)
    check('one wheel notch down moves the mark to the next row and stays with the list', afterWheel.startsWith('❯ 2. two') && through.wheel === 0, `${afterWheel} · passed on ${through.wheel} · ${selectKeysHint}`)
    const afterPage = await press(view, PAGE_DOWN)
    check('PageDown moves the mark and stays with the list', afterPage.startsWith('❯ 3. three') && through.page === 0, `${afterPage} · passed on ${through.page} · ${selectKeysHint}`)
  } finally {
    view.unmount()
  }
}

section('the same list told that scrolling is not its to take: only arrows and digits move the mark')
{
  through.wheel = 0
  through.page = 0
  const chosen: string[] = []
  const view = await mount(h(Select, { options: OPTIONS, scrollMovesFocus: false, onChange: (value: string) => { chosen.push(value) }, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(view).startsWith('❯ 1.'), 5_000)
    const up = await press(view, WHEEL_UP)
    check('one wheel notch up leaves the mark on the first row', up.startsWith('❯ 1. one'), `${up} · ${selectKeysHint}`)
    const upAgain = await press(view, WHEEL_UP)
    const down = await press(view, WHEEL_DOWN)
    check('a second notch and a notch down leave it there too', upAgain.startsWith('❯ 1. one') && down.startsWith('❯ 1. one'), `${upAgain} · ${down} · ${selectKeysHint}`)
    check('each notch is passed on to what scrolls behind the list', through.wheel === 3, `${through.wheel} of 3 · ${selectKeysHint}`)
    const pageDown = await press(view, PAGE_DOWN)
    const pageUp = await press(view, PAGE_UP)
    check('PageDown and PageUp leave the mark and are passed on', pageDown.startsWith('❯ 1. one') && pageUp.startsWith('❯ 1. one') && through.page === 2, `${pageDown} · ${pageUp} · passed on ${through.page} · ${selectKeysHint}`)
    const arrowDown = await press(view, KEY.down)
    const arrowUp = await press(view, KEY.up)
    check('the arrows move the mark as before', arrowDown.startsWith('❯ 2. two') && arrowUp.startsWith('❯ 1. one'), `${arrowDown} · ${arrowUp} · ${selectKeysHint}`)
    await press(view, WHEEL_UP)
    await press(view, KEY.enter)
    check('a notch and then ↵ takes the first row, the one the mark never left', chosen.length === 1 && chosen[0] === 'one', `${JSON.stringify(chosen)} · ${selectKeysHint}`)
    await press(view, '3')
    check('a digit still takes its row', chosen.length === 2 && chosen[1] === 'three', `${JSON.stringify(chosen)} · ${selectKeysHint}`)
  } finally {
    view.unmount()
  }
}

section('the permission card itself: a wheel notch over the transcript never moves its mark')
{
  through.wheel = 0
  const answers: string[] = []
  const options = [
    { value: 'yes', label: 'Yes' },
    { value: 'yes-dont-ask-again', label: "Yes, and don't ask again for this command" },
    { value: 'no', label: 'No', feedbackConfig: { type: 'reject' as const } },
  ]
  const view = await mount(h(PermissionPrompt, { options, onSelect: (value: string) => { answers.push(value) }, onCancel: () => { answers.push('cancelled') } } as never))
  try {
    await waitFor(() => markOf(view).startsWith('❯ 1.'), 5_000)
    check('the card opens with the mark on Yes', markOf(view).startsWith('❯ 1. Yes'), `${markOf(view)} · ${cardKeysHint}`)
    const one = await press(view, WHEEL_UP)
    check('one notch up: the mark is still on Yes (it went to No, and ↵ declined)', one.startsWith('❯ 1. Yes'), `${one} · ${cardKeysHint}`)
    const two = await press(view, WHEEL_UP)
    check('two notches: still on Yes (it went to the wider grant)', two.startsWith('❯ 1. Yes'), `${two} · ${cardKeysHint}`)
    const pageUp = await press(view, PAGE_UP)
    check('PageUp leaves the mark where it is', pageUp.startsWith('❯ 1. Yes'), `${pageUp} · ${cardKeysHint}`)
    check('the notches were passed on to what scrolls behind the card', through.wheel === 2, `${through.wheel} of 2 · ${cardKeysHint}`)
    const toNo = await press(view, KEY.down + KEY.down)
    const typing = await press(view, TAB)
    const notchWhileTyping = await press(view, WHEEL_UP)
    check('with the mark on No and its words being typed, a notch leaves the mark on No', toNo.startsWith('❯ 3.') && notchWhileTyping.startsWith('❯ 3.'), `${toNo} · ${typing} · ${notchWhileTyping} · ${cardKeysHint}`)
    await press(view, KEY.up + KEY.up)
    await press(view, WHEEL_DOWN)
    await press(view, KEY.enter)
    check('after the notches ↵ answers Yes, the row the arrows left the mark on', answers.length === 1 && answers[0] === 'yes', `${JSON.stringify(answers)} · ${cardKeysHint}`)
  } finally {
    view.unmount()
  }
}

section('the question card: its lists follow the same rule')
{
  through.wheel = 0
  through.page = 0
  const view = await mount(h(SelectMulti, { options: OPTIONS, scrollMovesFocus: false, onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(view).startsWith('❯ 1.'), 5_000)
    const opened = markOf(view)
    const notch = await press(view, WHEEL_UP)
    const page = await press(view, PAGE_DOWN)
    check('a list of several answers: a notch and PageDown leave the mark and are passed on', opened.startsWith('❯ 1.') && notch === opened && page === opened && through.wheel === 1 && through.page === 1, `${opened} · ${notch} · ${page} · passed on ${through.wheel}, ${through.page} · ${multiKeysHint}`)
    const arrow = await press(view, KEY.down)
    check('the arrow moves it as before', arrow.startsWith('❯ 2.'), `${arrow} · ${multiKeysHint}`)
  } finally {
    view.unmount()
  }
  const plain = await mount(h(SelectMulti, { options: OPTIONS, onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(plain).startsWith('❯ 1.'), 5_000)
    const notch = await press(plain, WHEEL_DOWN)
    check('the same list anywhere else still moves on the wheel', notch.startsWith('❯ 2.'), `${notch} · ${multiKeysHint}`)
  } finally {
    plain.unmount()
  }
}

section('where the terminal sends the wheel as arrows, an arrow is read as a wheel step: it still moves a card\'s mark')
{
  through.wheel = 0
  const chosen: string[] = []
  const view = await mountWithoutMouse(h(Select, { options: OPTIONS, scrollMovesFocus: false, onChange: (value: string) => { chosen.push(value) }, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(view).startsWith('❯ 1.'), 5_000)
    const down = await press(view, KEY.down)
    const downAgain = await press(view, KEY.down)
    const up = await press(view, KEY.up)
    check('mouse tracking off, a card\'s list: ↓ ↓ ↑ walks the mark to the second, the third and back to the second row', down.startsWith('❯ 2. two') && downAgain.startsWith('❯ 3. three') && up.startsWith('❯ 2. two'), `${down} · ${downAgain} · ${up} · ${selectKeysHint}`)
    await press(view, KEY.enter)
    check('…and ↵ takes the row the arrows left the mark on, not the first', chosen.length === 1 && chosen[0] === 'two', `${JSON.stringify(chosen)} · ${selectKeysHint}`)
  } finally {
    view.unmount()
  }
  const answers: string[] = []
  const options = [
    { value: 'yes', label: 'Yes' },
    { value: 'yes-dont-ask-again', label: "Yes, and don't ask again for this command" },
    { value: 'no', label: 'No', feedbackConfig: { type: 'reject' as const } },
  ]
  const card = await mountWithoutMouse(h(PermissionPrompt, { options, onSelect: (value: string) => { answers.push(value) }, onCancel: () => { answers.push('cancelled') } } as never))
  try {
    await waitFor(() => markOf(card).startsWith('❯ 1.'), 5_000)
    const one = await press(card, KEY.down)
    const two = await press(card, KEY.down)
    check('mouse tracking off, the permission card: ↓ ↓ walks the mark from Yes to No', one.startsWith('❯ 2.') && two.startsWith('❯ 3.'), `${markOf(card)} after ${one} · ${two} · ${cardKeysHint}`)
    await press(card, KEY.enter)
    check('…and ↵ there does not answer Yes', answers.length === 1 && answers[0] === 'no', `${JSON.stringify(answers)} · ${cardKeysHint}`)
  } finally {
    card.unmount()
  }
  const windows = await mount(h(Select, { options: OPTIONS, scrollMovesFocus: false, onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(windows).startsWith('❯ 1.'), 5_000)
    through.wheel = 0
    const down = await pressAsWindowsReadsIt(windows, KEY.down)
    const up = await pressAsWindowsReadsIt(windows, KEY.up)
    check('Windows before its first wheel report, a card\'s list: ↓ moves the mark down and ↑ back, and the list keeps the key', down.startsWith('❯ 2. two') && up.startsWith('❯ 1. one') && through.wheel === 0, `${down} · ${up} · passed on ${through.wheel} · ${selectKeysHint}`)
    through.wheel = 0
    const notch = await press(windows, WHEEL_DOWN)
    check('a wheel the terminal reports as a wheel is still passed on, the mark where it was', notch === up && through.wheel === 1, `${notch} · passed on ${through.wheel} · ${selectKeysHint}`)
  } finally {
    windows.unmount()
  }
  const several = await mount(h(SelectMulti, { options: OPTIONS, scrollMovesFocus: false, onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(several).startsWith('❯ 1.'), 5_000)
    const down = await pressAsWindowsReadsIt(several, KEY.down)
    check('Windows before its first wheel report, a list of several answers: ↓ moves the mark down', down.startsWith('❯ 2.'), `${down} · ${multiKeysHint}`)
  } finally {
    several.unmount()
  }
}

section('three consent lists that are no permission card keep their mark under the wheel too')
{
  const { MCPServerApprovalDialog } = await import('../../src/screen/mcp/MCPServerApprovalDialog.tsx')
  const { SovereignModeDialog } = await import('../../src/boot/first-run/SovereignModeDialog.tsx')
  const approvalOf = (): React.ReactNode => h(MCPServerApprovalDialog, { serverName: 'notes', config: { command: 'true' }, onDone: () => {} } as never)
  const approval = await mount(approvalOf())
  try {
    await waitFor(() => markOf(approval).includes('❯ 2.'), 5_000)
    const opened = markOf(approval)
    const notch = await press(approval, WHEEL_UP)
    check("a project server's approval opens on this server alone, and a notch up leaves the mark off the wider grant", opened.includes('❯ 2. Use this MCP server') && notch.includes('❯ 2. Use this MCP server'), `${opened} · ${notch} · ${consentKeysHint}`)
    const arrow = await press(approval, KEY.up)
    check('↑ moves it there, as before', arrow.includes('❯ 1. Use this and all future MCP servers'), `${arrow} · ${consentKeysHint}`)
  } finally {
    approval.unmount()
  }
  const approvalWithoutMouse = await mountWithoutMouse(approvalOf())
  try {
    await waitFor(() => markOf(approvalWithoutMouse).includes('❯ 2.'), 5_000)
    const down = await press(approvalWithoutMouse, KEY.down)
    check('mouse tracking off, where ↓ arrives as a wheel step: it still moves the mark', down.includes('❯ 3. Continue without this MCP server'), `${down} · ${consentKeysHint}`)
  } finally {
    approvalWithoutMouse.unmount()
  }
  const sovereign = await mount(h(SovereignModeDialog, { onAccept: () => {} } as never))
  try {
    await waitFor(() => markOf(sovereign).includes('❯ 1.'), 5_000)
    const notch = await press(sovereign, WHEEL_DOWN)
    const notchUp = await press(sovereign, WHEEL_UP)
    check('the Sovereign consent opens on "No, exit" and a notch either way leaves the mark there, off "Yes, I accept"', notch.includes('❯ 1. No, exit') && notchUp.includes('❯ 1. No, exit'), `${notch} · ${notchUp} · ${consentKeysHint}`)
    const arrow = await press(sovereign, KEY.down)
    check('↓ moves it, as before', arrow.includes('❯ 2. Yes, I accept'), arrow)
  } finally {
    sovereign.unmount()
  }
  const { TrustDialog } = await import('../../src/screen/trust-dialog/TrustDialog.tsx')
  const trust = await mount(h(TrustDialog, { onDone: () => {} } as never))
  try {
    await waitFor(() => markOf(trust).includes('❯ 1.'), 5_000)
    const notch = await press(trust, WHEEL_DOWN)
    const notchUp = await press(trust, WHEEL_UP)
    check('the folder trust card opens on "Yes, I trust this folder" and a notch either way leaves the mark there, off "No, exit"', notch.includes('❯ 1. Yes, I trust this folder') && notchUp.includes('❯ 1. Yes, I trust this folder'), `${notch} · ${notchUp} · ${consentKeysHint}`)
    const arrow = await press(trust, KEY.down)
    check('↓ moves it to "No, exit", as before', arrow.includes('❯ 2. No, exit'), arrow)
  } finally {
    trust.unmount()
  }
}


await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
