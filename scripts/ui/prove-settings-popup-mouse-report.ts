#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import type { ParsedInput, ParsedKey } from '../../src/ink/input/input-decoder.js'
import type { DOMElement } from '../../src/ink.js'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-settings-popup-mouse-report')
const frameDir = ((): string | undefined => {
  const index = process.argv.indexOf('--frames')
  return index < 0 ? undefined : process.argv[index + 1]
})()
if (frameDir) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ESC = '\x1b'
const MOTION = '\x1b[<35;147;11M'
const PRESS = '\x1b[<0;147;11M'
const RELEASE = '\x1b[<0;147;11m'

const { INITIAL_STATE, parseMultipleKeypresses } = await import('../../src/ink/input/input-decoder.js')
const { createPasteKey, interpretKey } = await import('../../src/ink/input/interpreter.js')
const { InputEvent } = await import('../../src/ink/events/input-event.js')

type Feed = string | null
function drive(feeds: Feed[]): ParsedInput[] {
  let state = INITIAL_STATE
  const out: ParsedInput[] = []
  for (const feed of feeds) {
    const [atoms, next] = parseMultipleKeypresses(state, feed)
    out.push(...atoms)
    state = next
  }
  return out
}
const names = (atoms: ParsedInput[]): string[] =>
  atoms.map(atom =>
    atom.kind === 'mouse'
      ? `mouse:${atom.button}@${atom.col};${atom.row}${atom.action === 'release' ? 'm' : 'M'}`
      : atom.kind === 'key'
        ? `key:${atom.name || '(nameless)'}`
        : atom.kind,
  )
const typed = (atoms: ParsedInput[]): string =>
  atoms
    .filter((atom): atom is ParsedKey => atom.kind === 'key')
    .map(atom => new InputEvent(atom).input)
    .join('')
const describe = (atoms: ParsedInput[]): string => `atoms ${JSON.stringify(names(atoms))} · typed ${JSON.stringify(typed(atoms))}`

section('§1 the decoder: a lone ESC held in the scanner, then the motion report')
{
  const held = drive([ESC, MOTION, null])
  check('the report decodes as a mouse atom (button 35 at 147;11) and no key types any of it', names(held).includes('mouse:35@147;11M') && typed(held) === '', describe(held))
  check('the lone ESC keeps its own meaning: one escape key ahead of the report, nothing else', held.length === 2 && names(held)[0] === 'key:escape', describe(held))
  const oneRead = drive([ESC + MOTION, null])
  check('ESC and the report in ONE read decode the same way', JSON.stringify(names(oneRead)) === JSON.stringify(names(held)) && typed(oneRead) === '', describe(oneRead))
  const click = drive([ESC, PRESS, RELEASE, null])
  check('the click behind a lone ESC: escape, press, release — no text', JSON.stringify(names(click)) === JSON.stringify(['key:escape', 'mouse:0@147;11M', 'mouse:0@147;11m']) && typed(click) === '', describe(click))
  const atIntroducer = drive([ESC + ESC + '[', '<35;147;11M', null])
  check('a read boundary right after the introducer still yields escape + mouse', JSON.stringify(names(atIntroducer)) === JSON.stringify(['key:escape', 'mouse:35@147;11M']) && typed(atIntroducer) === '', describe(atIntroducer))
  const cutHead = drive([ESC, '\x1b[<35;147;11', null])
  check('a report cut before its final, behind a lone ESC, leaks none of its digits as text', typed(cutHead) === '' && names(cutHead)[0] === 'key:escape', describe(cutHead))
  const x10 = drive([ESC, '\x1b[M\x43\x21\x21', null])
  check('the X10 encoding behind a lone ESC is escape + a mouse key, no text', names(x10)[0] === 'key:escape' && typed(x10) === '', describe(x10))
  const rxvt = drive([ESC + ESC + '[A', null])
  check('the rxvt law holds: ESC ESC [ A is still one alt+up', rxvt.length === 1 && rxvt[0]!.kind === 'key' && rxvt[0]!.name === 'up' && (rxvt[0]!.meta || rxvt[0]!.option), describe(rxvt))
  const twoEsc = drive([ESC + ESC, null])
  check('ESC ESC alone still flushes as two escapes', twoEsc.length === 2 && twoEsc.every(atom => atom.kind === 'key' && atom.name === 'escape'), describe(twoEsc))
  const escX = drive([ESC + ESC + 'x', null])
  check('ESC ESC x is still escape then alt+x', escX.length === 2 && names(escX)[0] === 'key:escape' && escX[1]!.kind === 'key' && escX[1]!.meta, describe(escX))
  const splitWheel = drive([ESC, '[<64;10;5M', null])
  check('a split wheel report still joins into one wheel key', splitWheel.length === 1 && splitWheel[0]!.kind === 'key' && splitWheel[0]!.name === 'wheelup', describe(splitWheel))
}

section('§2 the projection: no nameless key shaped like a report ever hands text to a box')
{
  const glued = new InputEvent(interpretKey(ESC + MOTION))
  check('a glued ESC ESC [ < … M key projects no text', glued.input === '', JSON.stringify(glued.input))
  const bare = new InputEvent(interpretKey('[<35;147;11M'))
  check('a bare report tail projects no text', bare.input === '', JSON.stringify(bare.input))
  const cut = new InputEvent(interpretKey(ESC + '\x1b[<35;147;11'))
  check('a cut report projects no text', cut.input === '', JSON.stringify(cut.input))
  const pasted = new InputEvent(createPasteKey('[<1;2;3M'))
  check('a pasted string of that shape is still the paste', pasted.input === '[<1;2;3M' && pasted.key.isPasted, JSON.stringify(pasted.input))
  const bracket = new InputEvent(interpretKey('['))
  check('a typed [ is still a [', bracket.input === '[', JSON.stringify(bracket.input))
  const release = new InputEvent(interpretKey('[<0;147;11m'))
  check('a bare release tail (the lower-case final) projects no text', release.input === '', JSON.stringify(release.input))
  const cutOneEsc = new InputEvent(interpretKey('\x1b[<35;147;11'))
  check('a cut report behind one ESC projects no text', cutOneEsc.input === '', JSON.stringify(cutOneEsc.input))
  for (const literal of ['[<5', '[<12;3', '[<35;147;11', '[<']) {
    const kept = new InputEvent(interpretKey(literal))
    check(`bare unfinished text ${JSON.stringify(literal)} is typed text, never a report: it projects itself`, kept.input === literal, JSON.stringify(kept.input))
  }
  const hello = new InputEvent(interpretKey('hello'))
  check('a coalesced word projects itself', hello.input === 'hello', JSON.stringify(hello.input))
  for (const literal of ['[<5', '[<12;3']) {
    const fed = drive([literal, null])
    check(`the decoder hands ${JSON.stringify(literal)} on as one typed key and the projection keeps it whole`, fed.length === 1 && fed[0]!.kind === 'key' && typed(fed) === literal, describe(fed))
  }
  const wholeBare = drive(['[<35;147;11M', null])
  check('a whole bare report in one read is still re-synthesised as the mouse atom, never typed', names(wholeBare).includes('mouse:35@147;11M') && typed(wholeBare) === '', describe(wholeBare))
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_SEARCH_PLACEHOLDER } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const COLS = 178
const ROWS = 51
const LEFT = 34
const TOP = 4
type Notice = { key?: string; text: string; priority?: string }
let notices: Notice[] = []

async function openConfig(): Promise<Mounted> {
  notices = []
  const element = React.createElement(
    AppStateProvider as never,
    {
      onChangeAppState: ({ newState: state }: { newState: { notifications?: { current?: Notice | null; queue?: Notice[] } } }) => {
        const current = state.notifications?.current
        if (current && !notices.some(n => n.text === current.text)) notices.push(current)
        for (const queued of state.notifications?.queue ?? []) if (!notices.some(n => n.text === queued.text)) notices.push(queued)
      },
    },
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  await settle(120)
  return m
}
const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
const searchRow = (m: Mounted): string => innerOf(m.lines()[TOP + 4] ?? '').trim()
const firstRow = (m: Mounted): string => innerOf(m.lines()[TOP + 6] ?? '').trim()
const popupUp = (m: Mounted): boolean => store.isSettingsPopupOpen() && m.screen().includes(CONFIG_POPUP_HINT)
const carriesReport = (m: Mounted): boolean => /\[<\d+;\d+;\d+[Mm]?/.test(m.screen())
const saveFrame = (name: string, m: Mounted): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), m.lines().join('\n') + '\n')
}

section('§3 /config, the search focused with a query: the lone ESC, the motion report, then the background click')
{
  const m = await openConfig()
  m.push('/')
  await settle(60)
  m.push('a')
  await settle(80)
  check('the search is focused and filters on "a"', searchRow(m).startsWith('/ a'), searchRow(m))
  saveFrame('config-search-focused-178x51', m)
  m.push(ESC)
  m.push(MOTION)
  await settle(160)
  check('the motion report never reaches the search box', !carriesReport(m) && !m.screen().includes('no settings match'), searchRow(m))
  check('the ESC did its own work: the query cleared, the popup stays with the search focused', popupUp(m) && searchRow(m) === `/ ${CONFIG_SEARCH_PLACEHOLDER}`, `${searchRow(m)} · open ${store.isSettingsPopupOpen()}`)
  saveFrame('config-search-after-motion-report-178x51', m)
  m.push(PRESS)
  await settle(160)
  check('the click outside closes the popup', !store.isSettingsPopupOpen(), `open ${store.isSettingsPopupOpen()}`)
  m.push(RELEASE)
  await settle(60)
  check('nothing typed anywhere after the click, no receipt', !carriesReport(m) && notices.length === 0, JSON.stringify(notices))
  saveFrame('config-after-background-click-178x51', m)
  m.unmount()
  await settle(40)
}

section('§4 /config, the search focused and empty: the same bytes, the box stays empty')
{
  const m = await openConfig()
  m.push('/')
  await settle(80)
  check('the search is focused on its placeholder', searchRow(m) === `/ ${CONFIG_SEARCH_PLACEHOLDER}`, searchRow(m))
  m.push(ESC)
  m.push(MOTION)
  await settle(160)
  check('the box never reads the report and the list never says "no settings match"', !carriesReport(m) && !m.screen().includes('no settings match'), `${searchRow(m)} · ${firstRow(m)}`)
  check('the lone ESC on a clean empty search closes the popup, as esc does', !store.isSettingsPopupOpen(), `open ${store.isSettingsPopupOpen()}`)
  m.push(PRESS)
  await settle(80)
  m.push(RELEASE)
  await settle(60)
  check('the click lands on nothing: no report text, no receipt', !carriesReport(m) && notices.length === 0, JSON.stringify(notices))
  m.unmount()
  await settle(40)
}

section('§5 /config in list mode: a report behind a lone ESC never seeds the search')
{
  const m = await openConfig()
  m.push(ESC)
  m.push(MOTION)
  await settle(160)
  check('no search seeded with the report', !carriesReport(m) && !m.screen().includes('no settings match'), searchRow(m))
  m.push(PRESS)
  await settle(80)
  m.push(RELEASE)
  await settle(40)
  check('the popup is closed at the end and nothing was typed', !store.isSettingsPopupOpen() && !carriesReport(m))
  m.unmount()
  await settle(40)
}

const { FilesMenuSlot } = await import('../../src/components/FilesMenuSlot.js')
const files = await import('../../src/utils/cockpit/filesMenu.js')
const { FILES_MENU_FILTER_PLACEHOLDER, FILES_MENU_HINT } = await import('../../src/components/MercuryFilesMenu.js')

section('§6 the files popup, its filter focused: the same road on another popup with a text box')
{
  const hostRef = React.createRef<DOMElement>()
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(
      ThemeProvider as never,
      {},
      React.createElement(Box, { ref: hostRef, flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(FilesMenuSlot, { hostRef, framed: false })),
    ),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  files.openFilesMenu()
  await waitFor(() => m.screen().includes(FILES_MENU_HINT), 4000)
  await settle(120)
  const filterRow = (): string => (m.lines().find(line => line.includes('/ ')) ?? '').trim()
  check('the files popup is up with its filter placeholder', files.isFilesMenuOpen() && m.screen().includes(FILES_MENU_FILTER_PLACEHOLDER), filterRow())
  m.push('/')
  await settle(60)
  m.push('r')
  await settle(80)
  check('the filter is focused and reads "r"', m.lines().some(line => /│ \/ r\s/.test(line)), m.lines().find(line => line.includes('/ r')) ?? '')
  m.push(ESC)
  m.push(MOTION)
  await settle(160)
  check('the motion report never reaches the filter', !carriesReport(m), m.lines().find(line => /\[</.test(line)) ?? '')
  check('the ESC cleared the filter and the popup stays', files.isFilesMenuOpen() && m.screen().includes(FILES_MENU_FILTER_PLACEHOLDER), `open ${files.isFilesMenuOpen()}`)
  m.push(PRESS)
  await settle(160)
  check('the click outside closes the files popup', !files.isFilesMenuOpen(), `open ${files.isFilesMenuOpen()}`)
  m.push(RELEASE)
  await settle(60)
  check('nothing typed after the click', !carriesReport(m))
  m.unmount()
  await settle(40)
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-settings-popup-mouse-report: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
