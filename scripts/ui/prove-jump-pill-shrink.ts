#!/usr/bin/env bun
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const HOME = pinScratchHome('jump-pill-shrink')
delete process.env.MERCURY_HOME
delete process.env.MERCURY_SEATS
delete process.env.MERCURY_CRITTER
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.BROWSER = '/usr/bin/true'

const COLS = 178
const ROWS = 51
const PILL = '[ back to the bottom · alt+↓ ]'
const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
const ALT_DOWN = '\x1b[1;3B'
const TALL_LINES = 20
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 1200)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const React = await import('react')
const { Box, Text } = await import('../../src/ink.js')
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { FullscreenLayout, useUnseenDivider } = await import('../../src/components/FullscreenLayout.js')
const { ScrollKeybindingHandler } = await import('../../src/components/ScrollKeybindingHandler.js')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.js')
const { useCompactWorkControls } = await import('../../src/components/tasks/CompactWorkSummary.js')
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.js')
type ScrollBoxHandle = import('../../src/ink/components/ScrollBox.js').ScrollBoxHandle
const h = React.createElement

type Row = { id: string; lines: string[] }
type Api = {
  setRows: (next: Row[] | ((previous: Row[]) => Row[])) => void
  handle: () => ScrollBoxHandle | null
  armed: () => boolean
}
const tall = (from: number, count: number, lines = TALL_LINES): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `t${from + index}`, lines: Array.from({ length: lines }, (_, line) => `msg ${from + index} line ${line + 1}`) }))
const folded = (count: number, lines: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `f${index + 1}`, lines: Array.from({ length: lines }, (_, line) => `after the fold: row ${index + 1}${lines > 1 ? ` line ${line + 1}` : ''}`) }))
const lastLineOf = (rows: Row[]): string => rows[rows.length - 1]!.lines[rows[rows.length - 1]!.lines.length - 1]!

const frames: Array<{ name: string; note: string }> = []
function keepFrame(name: string, note: string, m: Mounted): string[] {
  const lines = m.lines()
  frames.push({ name, note })
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), lines.join('\n') + '\n')
  return lines
}
const pillRow = (lines: string[]): number => lines.findIndex(line => line.includes(PILL))
const composerRow = (lines: string[]): number => lines.findIndex(line => /^│❯/.test(line))
function foot(lines: string[], count = 7): string {
  const bottom = composerRow(lines) - 2
  if (bottom < 0) return lines.slice(-count).join('\n')
  const left = lines[bottom]!.indexOf('╰')
  const right = lines[bottom]!.indexOf('╯', left + 1)
  return lines.slice(Math.max(0, bottom - count), bottom + 1).map((line, index) => `${String(bottom - count + index + 1).padStart(2)}│${line.slice(left, right + 1).replace(/\s+$/, '')}`).join('\n')
}
const transcriptRows = (lines: string[]): string[] => lines.filter(line => /msg \d+ line \d+|after the fold: row \d+/.test(line))
const maxOf = (handle: ScrollBoxHandle): number => Math.max(0, handle.getFreshScrollHeight() - handle.getViewportHeight())

function Transcript({ rows }: { rows: Row[] }): React.ReactNode {
  return h(Box, { flexDirection: 'column' }, ...rows.map(row => h(Box, { key: row.id, flexDirection: 'column' }, h(Text, null, row.lines.join('\n')))))
}

async function mountCockpit(initial: Row[]): Promise<{ m: Mounted; api: Api }> {
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const scrollRef = React.createRef<ScrollBoxHandle | null>() as React.MutableRefObject<ScrollBoxHandle | null>
  const insertRef = { current: null } as React.MutableRefObject<import('../../src/components/PromptInput/PromptInput.js').PromptInputProps['insertTextRef']['current']>
  const api: Api = { setRows: () => {}, handle: () => scrollRef.current, armed: () => false }
  function Cockpit(): React.ReactNode {
    const [rows, setRows] = React.useState<Row[]>(initial)
    const unseen = useUnseenDivider(rows.length, scrollRef)
    api.setRows = setRows
    api.armed = () => unseen.dividerYRef.current !== null
    const onScroll = React.useCallback((sticky: boolean, handle: ScrollBoxHandle) => {
      if (sticky) unseen.onRepin()
      else unseen.onScrollAway(handle)
    }, [unseen])
    const { controls, focus } = useCompactWorkControls()
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    return h(KeybindingSetup, null,
      h(ScrollKeybindingHandler, { scrollRef, isActive: true, onScroll }),
      h(FullscreenLayout, {
        scrollRef,
        dividerYRef: unseen.dividerYRef,
        hidePill: false,
        newMessageCount: 0,
        onPillClick: () => unseen.jumpToNew(scrollRef.current),
        scrollable: h(Transcript, { rows }),
        statusBand: h(Text, null, 'activity specimen'),
        statusBandActive: false,
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, ideSelection: undefined, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 0, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async () => {},
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        } as never),
      } as never),
    )
  }
  const m = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(Cockpit)), COLS, ROWS)
  const painted = await waitFor(() => insertRef.current !== null && scrollRef.current !== null && m.screen().includes(lastLineOf(initial)), 8000)
  await settle(250)
  check('the cockpit painted the transcript tail and the composer at 178x51', painted && composerRow(m.lines()) > 0, m.lines().filter(line => line.trim() !== '').slice(-6).join(' | '))
  return { m, api }
}

async function press(m: Mounted, data: string, ms = 220): Promise<void> {
  m.push(data)
  await settle(ms)
}
async function swap(api: Api, rows: Row[] | ((previous: Row[]) => Row[]), m: Mounted, needle: string): Promise<void> {
  api.setRows(rows)
  await waitFor(() => m.screen().includes(needle), 6000)
  await settle(300)
}
async function repinLikeTheOperator(api: Api, m: Mounted): Promise<void> {
  await swap(api, previous => [...previous, { id: 'op', lines: ['❯ the operator sends a line'] }], m, '❯ the operator sends a line')
  api.handle()?.scrollToBottom()
  await settle(150)
  await swap(api, previous => [...previous, { id: 'reply', lines: ['msg 26 line 1', 'msg 26 line 2'] }], m, 'msg 26 line 2')
}
const sessionRunsOn = (api: Api, m: Mounted): Promise<void> => swap(api, previous => [...previous, ...tall(27, 20)], m, 'msg 46 line 20')

section('§1 a fold below the viewport: the view has no room to scroll, so no pill may stand')
{
  const { m, api } = await mountCockpit(tall(1, 24))
  const handle = api.handle()!
  const viewport = handle.getViewportHeight()
  check('the tall transcript overflows the viewport', maxOf(handle) > viewport, `max ${maxOf(handle)} viewport ${viewport}`)
  await press(m, PAGE_UP)
  const scrolled = keepFrame('1-scrolled-up', 'PgUp on the tall transcript: the view one page up, the pill on', m)
  check('PgUp paints the pill (the precondition)', pillRow(scrolled) > 0 && api.armed(), foot(scrolled))
  await repinLikeTheOperator(api, m)
  const repinned = keepFrame('1-repinned', 'the operator sends a message: the view repins to the bottom, the pill goes, the divider stays armed', m)
  check('the repin hides the pill while the divider stays armed', pillRow(repinned) === -1 && api.armed(), `pill row ${pillRow(repinned)} armed ${api.armed()}`)
  await sessionRunsOn(api, m)
  const ran = keepFrame('1-session-ran-on', 'the session runs on: twenty tall rows land, the view follows the tail, the divider still armed from the early scroll-away', m)
  check('the session grows to 46 rows with the view at the tail and the divider still armed', pillRow(ran) === -1 && api.armed() && handle.getScrollTop() === maxOf(handle), `pill row ${pillRow(ran) + 1} armed ${api.armed()} offset ${handle.getScrollTop()} max ${maxOf(handle)}`)
  await swap(api, folded(26, 1), m, 'after the fold: row 26')
  const after = keepFrame('1-after-fold-below-viewport', 'the fold: 26 one-line rows replace the 46 rows; the whole transcript fits the viewport', m)
  const max = maxOf(handle)
  check('after the fold the transcript fits the viewport: no room to scroll', max === 0 && transcriptRows(after).length === 26, `max ${max} rows ${transcriptRows(after).length}`)
  check('the offset rests at the new maximum', handle.getScrollTop() === max, `offset ${handle.getScrollTop()} max ${max}`)
  console.log(`the foot of the frame after the fold (offset ${handle.getScrollTop()}, max ${max}):\n${foot(after)}`)
  check('no pill stands at the foot of a view with no room to scroll', pillRow(after) === -1, `the pill is painted at row ${pillRow(after) + 1} with the offset at the new max ${max}`)
  check('the divider is no longer armed once the view rests at the bottom', !api.armed())
  await press(m, ALT_DOWN)
  const jumped = keepFrame('1-after-alt-down', 'alt+↓ on the folded view: nothing to do', m)
  check('alt+↓ finds nothing to do: no pill before, no pill after, the frame unchanged', pillRow(after) === -1 && pillRow(jumped) === -1 && jumped.join('\n') === after.join('\n'), foot(jumped))
  await swap(api, previous => [...previous, ...tall(47, 12)], m, 'msg 58 line 20')
  const grown = keepFrame('1-grown', 'the session goes on after the fold: twelve tall rows land, the view follows the tail', m)
  check('the view follows the tail while it grows and no pill stands', pillRow(grown) === -1 && handle.getScrollTop() === maxOf(handle), `pill row ${pillRow(grown) + 1} offset ${handle.getScrollTop()} max ${maxOf(handle)}`)
  const offsetGrown = handle.getScrollTop()
  const pageGrown = handle.getViewportHeight() - 2
  await press(m, PAGE_UP)
  const paged = keepFrame('1-grown-then-pgup', 'PgUp after the growth: the pill is back', m)
  check('a later PgUp still travels a page and shows the pill', pillRow(paged) > 0 && api.armed() && handle.getScrollTop() === Math.max(0, offsetGrown - pageGrown), `pill row ${pillRow(paged) + 1} offset ${handle.getScrollTop()} expected ${Math.max(0, offsetGrown - pageGrown)}`)
  m.unmount()
  await settle(80)
}

section('§2 a fold to a shorter transcript that still overflows: at its bottom no pill; PgUp and PgDn as before')
{
  const { m, api } = await mountCockpit(tall(1, 24))
  const handle = api.handle()!
  await press(m, PAGE_UP)
  check('PgUp paints the pill (the precondition)', pillRow(m.lines()) > 0 && api.armed())
  await repinLikeTheOperator(api, m)
  check('the repin hides the pill while the divider stays armed', pillRow(m.lines()) === -1 && api.armed(), `pill row ${pillRow(m.lines()) + 1} armed ${api.armed()}`)
  await sessionRunsOn(api, m)
  check('the session grows to 46 rows with the view at the tail and the divider still armed', pillRow(m.lines()) === -1 && api.armed() && handle.getScrollTop() === maxOf(handle), `pill row ${pillRow(m.lines()) + 1} armed ${api.armed()} offset ${handle.getScrollTop()} max ${maxOf(handle)}`)
  await swap(api, folded(26, 4), m, 'after the fold: row 26 line 4')
  const after = keepFrame('2-after-fold-shorter', 'the fold: 26 four-line rows replace the 46 rows; the transcript still overflows', m)
  const max = maxOf(handle)
  check('after the fold the transcript still overflows', max > 0, `max ${max}`)
  check('the offset rests at the new maximum', handle.getScrollTop() === max, `offset ${handle.getScrollTop()} max ${max}`)
  console.log(`the foot of the frame after the fold (offset ${handle.getScrollTop()}, max ${max}):\n${foot(after)}`)
  check('no pill stands with the offset at the new maximum', pillRow(after) === -1, `the pill is painted at row ${pillRow(after) + 1} with the offset ${handle.getScrollTop()} at the new max ${max}`)
  await press(m, ALT_DOWN)
  const jumped = keepFrame('2-after-alt-down', 'alt+↓ at the bottom of the folded view: nothing to do', m)
  check('alt+↓ finds nothing to do: no pill before, no pill after, the frame unchanged', pillRow(after) === -1 && pillRow(jumped) === -1 && jumped.join('\n') === after.join('\n'), foot(jumped))
  const offsetBottom = handle.getScrollTop()
  const page = handle.getViewportHeight() - 2
  await press(m, PAGE_UP)
  const paged = keepFrame('2-pgup', 'PgUp: one page up, the pill on', m)
  check('PgUp scrolls a page up and shows the pill', pillRow(paged) > 0 && handle.getScrollTop() === Math.max(0, offsetBottom - page), `pill row ${pillRow(paged) + 1} offset ${handle.getScrollTop()} expected ${Math.max(0, offsetBottom - page)}`)
  const offsetPaged = handle.getScrollTop()
  const pageDown = handle.getViewportHeight() - 2
  await press(m, PAGE_DOWN)
  check('PgDn travels a page down (the pill row shortens the viewport by one, so the page keys are not symmetric)', handle.getScrollTop() === Math.min(offsetPaged + pageDown, maxOf(handle)), `offset ${handle.getScrollTop()} expected ${Math.min(offsetPaged + pageDown, maxOf(handle))}`)
  if (handle.getScrollTop() < maxOf(handle)) await press(m, PAGE_DOWN)
  const back = keepFrame('2-pgdn', 'PgDn to the bottom: the pill gone', m)
  check('PgDn back to the bottom clears the pill', pillRow(back) === -1 && handle.getScrollTop() === maxOf(handle) && !api.armed(), `pill row ${pillRow(back) + 1} offset ${handle.getScrollTop()} max ${maxOf(handle)}`)
  m.unmount()
  await settle(80)
}

section('§3 a fold while the view is scrolled up past the new maximum: the offset clamps, no pill, PgUp travels')
{
  const { m, api } = await mountCockpit(tall(1, 24))
  const handle = api.handle()!
  let expected = handle.getScrollTop()
  for (let press3 = 0; press3 < 3; press3++) {
    expected = Math.max(0, expected - (handle.getViewportHeight() - 2))
    await press(m, PAGE_UP)
  }
  const before = keepFrame('3-scrolled-up', 'three PgUps on the tall transcript', m)
  const offsetBefore = handle.getScrollTop()
  check('three PgUps scrolled three pages up with the pill on', pillRow(before) > 0 && offsetBefore === expected, `offset ${offsetBefore} expected ${expected} max ${maxOf(handle)}`)
  api.setRows(previous => [...previous, ...tall(26, 20)])
  await settle(400)
  const ran = keepFrame('3-session-ran-on', 'the session runs on under the scrolled-up view: twenty tall rows land below, the view holds its place', m)
  check('the session grows to 44 rows under the scrolled-up view, which holds its place with the pill on', pillRow(ran) > 0 && handle.getScrollTop() === offsetBefore && transcriptRows(ran).slice(0, 5).join('|') === transcriptRows(before).slice(0, 5).join('|'), `pill row ${pillRow(ran) + 1} offset ${handle.getScrollTop()} top ${transcriptRows(ran).slice(0, 2).map(line => line.trim()).join(' / ')}`)
  await swap(api, folded(26, 4), m, 'after the fold: row 26 line 4')
  const after = keepFrame('3-after-fold', 'the fold lands under a scrolled-up view: the old offset lies past the new maximum', m)
  const max = maxOf(handle)
  console.log(`the foot of the frame after the fold (offset ${handle.getScrollTop()}, max ${max}):\n${foot(after)}`)
  check('the old offset lay past the new maximum', offsetBefore > max, `old offset ${offsetBefore} new max ${max}`)
  check('the stored offset clamps to the new maximum', handle.getScrollTop() === max, `offset ${handle.getScrollTop()} max ${max}`)
  check('no pill stands once the view rests at the new bottom', pillRow(after) === -1, `the pill is painted at row ${pillRow(after) + 1} with the stored offset ${handle.getScrollTop()} past the new max ${max}`)
  const offsetBottom = handle.getScrollTop()
  const page = handle.getViewportHeight() - 2
  await press(m, PAGE_UP)
  const paged = keepFrame('3-pgup', 'PgUp after the fold: one page up from the new bottom, the pill on', m)
  check('PgUp travels one page up from the new bottom and shows the pill', handle.getScrollTop() === Math.max(0, offsetBottom - page) && pillRow(paged) > 0, `offset ${handle.getScrollTop()} expected ${Math.max(0, offsetBottom - page)} pill row ${pillRow(paged) + 1}`)
  m.unmount()
  await settle(80)
}

if (frameDir !== undefined) {
  const index = ['The jump pill after a fold that shrinks the transcript: source renders of the real cockpit at 178x51. One file per state.', ...frames.map(frame => `${frame.name}.txt | ${frame.note}`)]
  writeFileSync(join(frameDir, 'index.txt'), index.join('\n') + '\n')
  console.log(`\nframes: ${frames.length} written to ${frameDir}`)
}
rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-jump-pill-shrink: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
