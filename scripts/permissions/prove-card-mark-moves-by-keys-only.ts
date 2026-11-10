#!/usr/bin/env bun
import React from 'react'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { Box, useInput } = await import('../../src/ink.ts')
const { default: useStdin } = await import('../../src/ink/hooks/use-stdin.ts')
const { Select } = await import('../../src/components/CustomSelect/select.tsx')
const { SelectMulti } = await import('../../src/components/CustomSelect/SelectMulti.tsx')
const { decodeDomNavKey } = await import('../../src/components/mercury-ui/navSemantics.ts')
const { KeyboardEvent } = await import('../../src/ink/events/keyboard-event.ts')
const { PermissionPrompt } = await import('../../src/components/permissions/PermissionPrompt.tsx')
const { InputEvent } = await import('../../src/ink/events/input-event.ts')
const { INITIAL_STATE, parseMultipleKeypresses } = await import('../../src/ink/input/input-decoder.ts')
const { resolveAlternateScrollIntent } = await import('../../src/ink/termio/alternateScrollPolicy.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
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
    check('one wheel notch down moves the mark to the next row and stays with the list', afterWheel.startsWith('❯ 2. two') && through.wheel === 0, `${afterWheel} · passed on ${through.wheel}`)
    const afterPage = await press(view, PAGE_DOWN)
    check('PageDown moves the mark and stays with the list', afterPage.startsWith('❯ 3. three') && through.page === 0, `${afterPage} · passed on ${through.page}`)
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
    check('one wheel notch up leaves the mark on the first row', up.startsWith('❯ 1. one'), up)
    const upAgain = await press(view, WHEEL_UP)
    const down = await press(view, WHEEL_DOWN)
    check('a second notch and a notch down leave it there too', upAgain.startsWith('❯ 1. one') && down.startsWith('❯ 1. one'), `${upAgain} · ${down}`)
    check('each notch is passed on to what scrolls behind the list', through.wheel === 3, `${through.wheel} of 3`)
    const pageDown = await press(view, PAGE_DOWN)
    const pageUp = await press(view, PAGE_UP)
    check('PageDown and PageUp leave the mark and are passed on', pageDown.startsWith('❯ 1. one') && pageUp.startsWith('❯ 1. one') && through.page === 2, `${pageDown} · ${pageUp} · passed on ${through.page}`)
    const arrowDown = await press(view, KEY.down)
    const arrowUp = await press(view, KEY.up)
    check('the arrows move the mark as before', arrowDown.startsWith('❯ 2. two') && arrowUp.startsWith('❯ 1. one'), `${arrowDown} · ${arrowUp}`)
    await press(view, WHEEL_UP)
    await press(view, KEY.enter)
    check('a notch and then ↵ takes the first row, the one the mark never left', chosen.length === 1 && chosen[0] === 'one', JSON.stringify(chosen))
    await press(view, '3')
    check('a digit still takes its row', chosen.length === 2 && chosen[1] === 'three', JSON.stringify(chosen))
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
    check('the card opens with the mark on Yes', markOf(view).startsWith('❯ 1. Yes'), markOf(view))
    const one = await press(view, WHEEL_UP)
    check('one notch up: the mark is still on Yes (it went to No, and ↵ declined)', one.startsWith('❯ 1. Yes'), one)
    const two = await press(view, WHEEL_UP)
    check('two notches: still on Yes (it went to the wider grant)', two.startsWith('❯ 1. Yes'), two)
    const pageUp = await press(view, PAGE_UP)
    check('PageUp leaves the mark where it is', pageUp.startsWith('❯ 1. Yes'), pageUp)
    check('the notches were passed on to what scrolls behind the card', through.wheel === 2, `${through.wheel} of 2`)
    const toNo = await press(view, KEY.down + KEY.down)
    const typing = await press(view, TAB)
    const notchWhileTyping = await press(view, WHEEL_UP)
    check('with the mark on No and its words being typed, a notch leaves the mark on No', toNo.startsWith('❯ 3.') && notchWhileTyping.startsWith('❯ 3.'), `${toNo} · ${typing} · ${notchWhileTyping}`)
    await press(view, KEY.up + KEY.up)
    await press(view, WHEEL_DOWN)
    await press(view, KEY.enter)
    check('after the notches ↵ answers Yes, the row the arrows left the mark on', answers.length === 1 && answers[0] === 'yes', JSON.stringify(answers))
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
    check('a list of several answers: a notch and PageDown leave the mark and are passed on', opened.startsWith('❯ 1.') && notch === opened && page === opened && through.wheel === 1 && through.page === 1, `${opened} · ${notch} · ${page} · passed on ${through.wheel}, ${through.page}`)
    const arrow = await press(view, KEY.down)
    check('the arrow moves it as before', arrow.startsWith('❯ 2.'), arrow)
  } finally {
    view.unmount()
  }
  const plain = await mount(h(SelectMulti, { options: OPTIONS, onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(plain).startsWith('❯ 1.'), 5_000)
    const notch = await press(plain, WHEEL_DOWN)
    check('the same list anywhere else still moves on the wheel', notch.startsWith('❯ 2.'), notch)
  } finally {
    plain.unmount()
  }
  const wheelAtom = { name: 'wheelup', sequence: WHEEL_UP, ctrl: false, shift: false, meta: false, option: false, super: false, fn: false }
  const named = new KeyboardEvent(wheelAtom as never).key
  const preview = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'permissions', 'AskUserQuestionPermissionRequest', 'PreviewQuestionView.tsx'), 'utf8')
  check('the question with previews moves by named keys, and a notch or a page key is none of them', named === 'wheelup' && decodeDomNavKey({ key: named }, { orientation: 'vertical' }) === null && decodeDomNavKey({ key: 'pageup' }, { orientation: 'vertical' }) === null && decodeDomNavKey({ key: 'up' }, { orientation: 'vertical' }) === 'movePrevious' && /decodeDomNavKey\(e, \{ orientation: 'vertical' \}\)/.test(preview) && !/<Select/.test(preview), `a notch is named ${named}`)
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
    check('mouse tracking off, a card\'s list: ↓ ↓ ↑ walks the mark to the second, the third and back to the second row', down.startsWith('❯ 2. two') && downAgain.startsWith('❯ 3. three') && up.startsWith('❯ 2. two'), `${down} · ${downAgain} · ${up}`)
    await press(view, KEY.enter)
    check('…and ↵ takes the row the arrows left the mark on, not the first', chosen.length === 1 && chosen[0] === 'two', JSON.stringify(chosen))
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
    check('mouse tracking off, the permission card: ↓ ↓ walks the mark from Yes to No', one.startsWith('❯ 2.') && two.startsWith('❯ 3.'), `${markOf(card)} after ${one} · ${two}`)
    await press(card, KEY.enter)
    check('…and ↵ there does not answer Yes', answers.length === 1 && answers[0] === 'no', JSON.stringify(answers))
  } finally {
    card.unmount()
  }
  const windows = await mount(h(Select, { options: OPTIONS, scrollMovesFocus: false, onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(windows).startsWith('❯ 1.'), 5_000)
    through.wheel = 0
    const down = await pressAsWindowsReadsIt(windows, KEY.down)
    const up = await pressAsWindowsReadsIt(windows, KEY.up)
    check('Windows before its first wheel report, a card\'s list: ↓ moves the mark down and ↑ back, and the list keeps the key', down.startsWith('❯ 2. two') && up.startsWith('❯ 1. one') && through.wheel === 0, `${down} · ${up} · passed on ${through.wheel}`)
    through.wheel = 0
    const notch = await press(windows, WHEEL_DOWN)
    check('a wheel the terminal reports as a wheel is still passed on, the mark where it was', notch === up && through.wheel === 1, `${notch} · passed on ${through.wheel}`)
  } finally {
    windows.unmount()
  }
  const several = await mount(h(SelectMulti, { options: OPTIONS, scrollMovesFocus: false, onChange: () => {}, onCancel: () => {} } as never))
  try {
    await waitFor(() => markOf(several).startsWith('❯ 1.'), 5_000)
    const down = await pressAsWindowsReadsIt(several, KEY.down)
    check('Windows before its first wheel report, a list of several answers: ↓ moves the mark down', down.startsWith('❯ 2.'), down)
  } finally {
    several.unmount()
  }
}

section('every card whose ↵ answers passes it: no list of a card takes the wheel')
{
  const root = join(import.meta.dir, '..', '..', 'src', 'components', 'permissions')
  const files = (readdirSync(root, { recursive: true }) as string[]).filter(file => file.endsWith('.tsx') && !file.startsWith('rules'))
  const lists: Array<{ file: string; passes: boolean }> = []
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const opening of source.matchAll(/<Select(?:Multi)?\b[^>]*?(?:\/>|>)/gs)) lists.push({ file, passes: /\bscrollMovesFocus=\{false\}/.test(source.slice(opening.index, opening.index + 400)) })
  }
  const missing = lists.filter(list => !list.passes).map(list => list.file)
  check(`the ${lists.length} lists of the permission and question cards each say so`, lists.length >= 11 && missing.length === 0, `${lists.length} lists; without it: ${missing.join(', ')}`)
  const cards = (readdirSync(root, { recursive: true }) as string[]).filter(file => /PermissionRequest\.tsx$/.test(file) && file !== 'PermissionRequest.tsx' && !file.startsWith('AskUserQuestionPermissionRequest'))
  const own = cards.filter(file => /<Select\b|<PermissionPrompt\b|<FilePermissionDialog\b|<FallbackPermissionRequest\b/.test(readFileSync(join(root, file), 'utf8')))
  check('every card is one of those lists, the shared prompt, the file dialog or the fallback card built on the prompt', cards.length >= 17 && own.length === cards.length && /<PermissionPrompt\b/.test(readFileSync(join(root, 'FallbackPermissionRequest.tsx'), 'utf8')), `${cards.length} cards; with none of the four: ${cards.filter(file => !own.includes(file)).join(', ')}`)
}

await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
