#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 B1 — the width-resize scale preserves recorded zeros')
{
  const { scaleHeightForWidth } = await import('../../src/hooks/useVirtualScroll.ts')
  const ratios = [0.25, 0.5, 0.999, 1, 1.5, 2.7, 10]
  check('zero stays zero at every ratio', ratios.every(r => scaleHeightForWidth(0, r) === 0))
  check('a positive height floors at ONE line, never zero', ratios.every(r => scaleHeightForWidth(1, r) >= 1 && scaleHeightForWidth(7, r) >= 1))
  check('ratio 1 is identity for positives', [1, 2, 5, 16].every(h => scaleHeightForWidth(h, 1) === h))
  check('the scale rounds, not truncates (6 at 1.5 → 9; 7 at 0.5 → 4)', scaleHeightForWidth(6, 1.5) === 9 && scaleHeightForWidth(7, 0.5) === 4)
  const thereAndBack = (h: number): number => scaleHeightForWidth(scaleHeightForWidth(h, 0.5), 2)
  check('a there-and-back keeps zero at zero', thereAndBack(0) === 0)
  const hook = read('src/hooks/useVirtualScroll.ts')
  check('the resize loop rides the pure scale (no inline Math.max survives)', hook.includes('cache.set(key, scaleHeightForWidth(height, ratio))') && !hook.includes('cache.set(key, Math.max(1, Math.round(height * ratio)))'))
  check(
    'the zero-record law this pairs with still stands (rows that painted nothing record 0)',
    hook.includes('cache.set(key, 0)') && hook.includes('a recorded zero is what lets the start-advance guard move on'),
  )
}

console.log('§2 B2 — the spinner stack decision is a hysteresis band')
{
  const { spinnerStackDecision, STACK_EXIT_SLACK } = await import(
    '../../src/components/Spinner/SpinnerAnimationRow.tsx'
  )
  const d = (cost: number, wasStacked: boolean, space = 40): boolean =>
    spinnerStackDecision({ eligible: true, cost, space, wasStacked })
  check('over the space it stacks, latched or not', d(41, false) && d(41, true))
  check('inside the band a STANDING stack holds (the jitter cannot flap it)', d(38, true) && d(36, true))
  check('inside the band a one-line row STAYS one line (entry is never eager)', !d(38, false) && !d(40, false))
  check('below the band the stack releases', !d(40 - STACK_EXIT_SLACK, true) && !d(20, true))
  check('ineligible never stacks whatever the latch says', !spinnerStackDecision({ eligible: false, cost: 100, space: 10, wasStacked: true }))
  check('the band out-sizes the counters’ per-tick width jitter', STACK_EXIT_SLACK > 4)
  const row = read('src/components/Spinner/SpinnerAnimationRow.tsx')
  check(
    'the component rides the pure fold through a per-instance latch',
    row.includes('const stacked = spinnerStackDecision({') && row.includes('stackedLatchRef.current = stacked') && row.includes('const stackedLatchRef = useRef(false)'),
  )
  check('the raw flapping comparison is gone', !row.includes('(segBFullCost > 0 || suffixText !== \'\') && segBFullCost > oneLineSpace\n'))
}

console.log('§3 B3 — the shell-progress reserve is monotone; the footer holds the bottom edge')
{
  const { reserveShellRows } = await import('../../src/components/shell/ShellProgressMessage.tsx')
  check('growth latches: 3 shown after 5 keeps the 5-row reserve (2 pads)', reserveShellRows(3, 5).latch === 5 && reserveShellRows(3, 5).pad === 2)
  check('content grows the latch', reserveShellRows(4, 2).latch === 4 && reserveShellRows(4, 2).pad === 0)
  check('an all-blank window after content keeps the frame (never a collapse)', reserveShellRows(0, 5).latch === 5 && reserveShellRows(0, 5).pad === 5)
  check('the latch caps at the tail budget', reserveShellRows(9, 9).latch === 5)
  check('a fresh stream starts honest (nothing shown, nothing reserved)', reserveShellRows(0, 0).latch === 0)
  const src = read('src/components/shell/ShellProgressMessage.tsx')
  check(
    'the block rides the reserve: latched height, pad rows, the latch written back',
    src.includes('height={latch + 1}') && src.includes('Array.from({ length: pad }') && src.includes('shownLatchRef.current = latch'),
  )
  check('the raw shown-count height is gone', !src.includes('height={Math.min(shown.length, TAIL_LINES) + 1}'))
  check('the one-row running line stands only before ANY content (latch === 0 gate)', src.includes('if (latch === 0) {'))
}

console.log('§4 B4 — no process.stdout size read under the render trees')
{
  const { readdirSync, statSync } = await import('node:fs')
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${e}`
      const st = statSync(join(ROOT, rel))
      if (st.isDirectory()) walk(rel)
      else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) {
        const src = readFileSync(join(ROOT, rel), 'utf8')
        src.split('\n').forEach((line, i) => {
          if (/process\.stdout\.(columns|rows)/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
            offenders.push(`${rel}:${i + 1}`)
          }
        })
      }
    }
  }
  for (const tree of ['src/components', 'src/screens', 'src/commands']) walk(tree)
  check('zero offenders across the render trees', offenders.length === 0, offenders.join(' · '))
  const ctx = read('src/commands/context/context.tsx')
  check('/context prints at the transcript width (staticPrintColumns, both calls)', (ctx.match(/staticPrintColumns\(\)/g) ?? []).length === 2 && !ctx.includes('process.stdout.columns'))
  const helper = read('src/utils/staticRender.tsx')
  check(
    'the one lawful print-width owner reads the layout’s own pure owners',
    helper.includes('export function staticPrintColumns') && helper.includes("chromeModeLive(cols, rows) === 'cockpit'") && helper.includes('railPlan(cols).centerCols - 2'),
  )
  const ask = read('src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx')
  check(
    'the preview measure loop measures at the CONTEXT width',
    ask.includes('applyMarkdown(opt.preview, theme, highlight, terminalColumns)'),
  )
}

console.log('§5 D1 — the select description column is list-measured, not window-measured')
{
  const sel = read('src/components/CustomSelect/select.tsx')
  check('the column measures the WHOLE list', sel.includes('const labelColumnWidth = options.reduce((max, option) => {'))
  check('the window-local measure is gone', !sel.includes('const labelColumnWidth = visible.reduce'))
}

console.log('§6 D2 — the composer viewport holds still inside the band')
{
  const { Cursor } = await import('../../src/utils/Cursor.ts')
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const at = (line: number): InstanceType<typeof Cursor> => {
    let off = 0
    for (let i = 0; i < line; i++) off += `line ${i}\n`.length
    return Cursor.fromText(text, 40, off)
  }
  const MAX = 8
  const centred = at(15).getViewportStartLine(MAX)
  check('no history → the centred landing', centred === 15 - 4)
  const held = 10
  check('inside the band the window HOLDS', at(12).getViewportStartLine(MAX, held) === held && at(16).getViewportStartLine(MAX, held) === held)
  check('the top margin row scrolls by one', at(10).getViewportStartLine(MAX, held) === 9)
  check('the bottom edge scrolls by one', at(17).getViewportStartLine(MAX, held) === 11)
  check('a there-and-back lands on the same start (no drift)', at(16).getViewportStartLine(MAX, at(17).getViewportStartLine(MAX, held)) === 11)
  check('the ends clamp', at(0).getViewportStartLine(MAX, held) === 0 && at(29).getViewportStartLine(MAX, held) === 30 - MAX)
  check('a window taller than the text is 0 either way', at(5).getViewportStartLine(40, 3) === 0)
  const hook = read('src/hooks/useTextInput.ts')
  check(
    'the hook threads ONE banded start into every derived offset',
    hook.includes('getViewportStartLine(maxVisibleLines, bandRef.current)') &&
      hook.includes('getViewportCharOffset(maxVisibleLines, viewportStartLine)') &&
      hook.includes('getViewportCharEnd(maxVisibleLines, viewportStartLine)'),
  )
  const prompt = read('src/components/PromptInput/PromptInput.tsx')
  check(
    'the click mapper reads the PAINTED window (the shared ref), never an independent centring',
    prompt.includes('composerViewportStartRef.current ?? cursor.getViewportStartLine(maxVisibleLines)') &&
      prompt.includes('viewportStartRef: composerViewportStartRef'),
  )
}

console.log('§7 D3 — option clicks are the option box’s own, wrap-proof')
{
  const sel = read('src/components/CustomSelect/select.tsx')
  check(
    'compact-vertical options own their click and it FOCUSES only',
    sel.includes('? () => state.focusValue(optionValueOf(option))') &&
      /compact-vertical'\) \{[\s\S]{0,900}onClick=\{/.test(sel),
  )
  check('disabled and isDisabled stay click-dead', sel.includes('!isDisabled && !option.disabled && disableSelection !== true'))
  const cards = read('src/components/concourse/ManagerCards.tsx')
  check('the localRow arithmetic is gone', !cards.includes('e.localRow') || !cards.includes('selectRow(Math.max(0, Math.min(options.length - 1, e.localRow)))'))
  check('the digit path still selects through selectRow (the ruled digit law untouched)', cards.includes('selectRow(action.index)'))
}

console.log('§8 D4 — the split partitions hover ids and the wheel at the divider')
{
  const mirror = read('src/components/concourse/SessionMirror.tsx')
  check('the mirror namespaces its pointer ids', mirror.includes('id={`${idScope}:title`}') && mirror.includes('id={`${idScope}:jump-newest`}'))
  check(
    'the wheel is band-gated by the event’s OWN x',
    mirror.includes('kp.x < wheelBand[0] || kp.x > wheelBand[1]'),
  )
  const pane = read('src/components/concourse/SplitChatPane.tsx')
  check('the chat pane claims its namespace and forwards its band', pane.includes('idScope="split:chat:mirror"') && pane.includes('{...(wheelBand !== undefined ? { wheelBand } : {})}'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'the screen hands each side its band from the ONE split geometry',
    screen.includes('wheelBand: [0, splitGeo.dividerCol - 1]') && screen.includes('wheelBand={[splitGeo.dividerCol + 1, termCols - 1]'),
  )
  check('the un-split board keeps whole-width behavior (no band without splitGeo)', screen.includes('{...(splitGeo !== null ? { wheelBand: [0, splitGeo.dividerCol - 1] as [number, number] } : {})}'))
}

console.log('§9 D5 — the collapse notice dies when the frame affords again')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'the affordance branch clears exactly the collapse note',
    screen.includes('else if (splitAvailableAt(termCols, termRows)) {') &&
      screen.includes("prev.text.startsWith('split collapsed') ? null : prev"),
  )
  const { collapseSplitForFrame, toggleSplitView, _resetSplitViewForTesting, splitAvailableAt } = await import(
    '../../src/components/concourse/splitView.ts'
  )
  _resetSplitViewForTesting()
  toggleSplitView(200, 50)
  const c = collapseSplitForFrame(130, 23)
  check('the collapse line the clearer keys on is the one the store speaks', c.collapsed === true && c.line.startsWith('split collapsed'))
  check('affordance is the same predicate the effect reads', splitAvailableAt(200, 50) && !splitAvailableAt(130, 23))
  _resetSplitViewForTesting()
}

console.log('§10 D6 — the daemon cursor survives the roster shuffle by key')
{
  const view = read('src/components/mercury-ui/parity/DaemonSupervisorView.tsx')
  check('the cursor carries a key beside the index', view.includes("const [selKey, setSelKey] = React.useState<string | null>(null)"))
  check('the key wins where it exists; the clamp is the reap fallback', view.includes('const clampedSel = keyAt >= 0 ? keyAt : indexClamped'))
  check('the index state re-anchors to the painted row', view.includes('if (sel !== clampedSel) setSel(clampedSel)'))
  check('arrows move from the PAINTED cursor and restamp the key', view.includes('const next = Math.max(0, clampedSel - 1)') && view.includes('setSelKey(v.workers[next]?.short ?? null)'))
  check('no bare functional index-walk survives', !view.includes('setSel(s => Math.max(0, s - 1))'))
}

console.log('§11 D7 — rename patches in place; loadMore is single-flight')
{
  const selector = read('src/components/LogSelector.tsx')
  check(
    'the rename prefers the in-place receipt and keeps the reload as fallback',
    selector.includes('if (onLogRenamed !== undefined) onLogRenamed(String(target.sessionId), trimmed)') &&
      selector.includes('else onLogsChanged?.()'),
  )
  const screen = read('src/screens/ResumeConversation.tsx')
  check(
    'the owner patches the ONE row in both stores (no isLoading, no teardown)',
    screen.includes('rows.map(l => (String(l.sessionId) === sessionId ? { ...l, customTitle: title } : l))') &&
      screen.includes('setLogs(patch)') &&
      screen.includes('setAllStatLogs(patch)'),
  )
  check('loadMore is single-flight through a ref', screen.includes('if (loadMoreInFlightRef.current) return') && screen.includes('loadMoreInFlightRef.current = true') && /finally \{\s*\n\s*loadMoreInFlightRef\.current = false/.test(screen))
}

console.log('§12 D8 — the steering band stays dead (steer-removal poison)')
{
  const { existsSync } = await import('node:fs')
  check('the strip component stays deleted', !existsSync(join(ROOT, 'src/components/PromptInput/PromptInputQueuedCommands.tsx')))
  check('the hint component stays deleted', !existsSync(join(ROOT, 'src/components/PromptInput/QueuedSteeringHint.tsx')))
}

console.log('§13 D9 — the terminal card reserves its probe block')
{
  const card = read('src/components/TerminalProfileCard.tsx')
  check(
    "the block renders from the first win32 frame with the 'unknown' placeholder",
    card.includes("inventory !== null || process.platform === 'win32'") &&
      card.includes("inventory ?? { windowsTerminal: 'unknown', pwsh7: 'unknown', winget: 'unknown' }"),
  )
  const { inventoryLines } = await import('../../src/ink/session/windowsHostSetup.ts')
  const pending = inventoryLines({ windowsTerminal: 'unknown', pwsh7: 'unknown', winget: 'unknown' })
  const landed = inventoryLines({ windowsTerminal: 'present', pwsh7: 'missing', winget: 'present' })
  check('the roster is FIXED — the probe can only fill rows, never add them', pending.length === landed.length && pending.length === 2)
  check("the placeholder state has honest wording (the card paints 'not confirmed')", pending.every(l => l.state === 'unknown'))
}

console.log('§14 CB-05 — the state-word column is reserved; title columns are byte-stable')
{
  const { STATE_WORD_RESERVE, stateWordCell } = await import(
    '../../src/components/concourse/ConcourseLayout.tsx'
  )
  const layoutSrc = read('src/components/concourse/ConcourseLayout.tsx')
  check('the reserve is table-derived', layoutSrc.includes('Object.values(STATE_WORD).map(word => word.length)'))
  const words = ['ready', 'working', 'NEEDS YOU', 'with you', 'stalled', 'failed', 'queued', 'starting', 'paused', 'stopped', 'done', 'cancelled', 'draft', 'parked', 'a door']
  check('the longest table word sizes the column', STATE_WORD_RESERVE === Math.max(...words.map(w => w.length)))
  const stable = words.every(w => stateWordCell(w).length === stateWordCell(null).length)
  check('title columns byte-stable across every selection flip', stable)
  check('an unknown over-long raw state cannot move even its own row', stateWordCell('a-very-long-unknown-state').length === stateWordCell(null).length)
  check('the resting cell is pure space', stateWordCell(null) === ' '.repeat(1 + STATE_WORD_RESERVE))
  check('the filled cell: word then spaces (the still)', stateWordCell('ready') === ' ready    ' && stateWordCell('NEEDS YOU') === ' NEEDS YOU' && stateWordCell('a door') === ' a door   ')
  check(
    'every row paints the reserve cell (the selected row fills, the rest hold spaces)',
    layoutSrc.includes('stateWordCell(') && layoutSrc.includes("? (STATE_WORD[r.state] ?? r.state)\n                            : null,"),
  )
  check('the old inserting paint is gone', !layoutSrc.includes('<Text color={t[sg.color]}> {STATE_WORD[r.state] ?? r.state}</Text>'))
}

console.log('§15 — the viewport floor: one verdict, one line, one latch')
{
  const { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_EXIT_BAND, viewportFloorLine, viewportFloorVerdict } = await import(
    '../../src/ink/viewportFloor.ts'
  )
  const { HELM_HOME_MIN_COLS } = await import('../../src/utils/helmGeometry.ts')
  check('the floor IS the cockpit entry width (one owner, 100 columns)', VIEWPORT_FLOOR_COLS === HELM_HOME_MIN_COLS && VIEWPORT_FLOOR_COLS === 100)
  check('a fresh window under the floor is under', !viewportFloorVerdict(99, 40, false).fits && !viewportFloorVerdict(80, 20, false).fits)
  check('a fresh window at the floor fits', viewportFloorVerdict(100, 40, false).fits)
  check('a painted surface survives the exit band', viewportFloorVerdict(100 - VIEWPORT_FLOOR_EXIT_BAND, 40, true).fits)
  check('… and goes under one column below the band', !viewportFloorVerdict(100 - VIEWPORT_FLOOR_EXIT_BAND - 1, 40, true).fits)
  check(
    'the band is the cockpit chrome latch’s band (one number, two latches agree)',
    read('src/hooks/useLayoutTier.ts').includes('const COCKPIT_EXIT_HYST_COLS = VIEWPORT_FLOOR_EXIT_BAND'),
  )
  const { VIEWPORT_FLOOR_ROWS } = await import('../../src/ink/viewportFloor.ts')
  check('the row floor is the deck strip’s floor (22 rows, one number)', VIEWPORT_FLOOR_ROWS === 22 && read('src/hooks/useLayoutTier.ts').includes('deckMinRows: VIEWPORT_FLOOR_ROWS'))
  check('a window under the row floor is under, at it fits (no band on rows)', !viewportFloorVerdict(120, 21, true).fits && viewportFloorVerdict(120, 22, true).fits && !viewportFloorVerdict(120, 21, false).fits)
  const under = viewportFloorVerdict(80, 20, true)
  check('the line names the minimum, this window and the way', !under.fits && under.line.includes('100 columns') && under.line.includes('22 rows') && under.line.includes('80×20') && /resize/.test(under.line))
  const shortest = viewportFloorLine(20, 10)
  check('the shortest form still names the minimum and the way', shortest.includes('100') && /resize/.test(shortest))
  check(
    'the line stays on ONE row at every width down to the shortest form',
    [140, 99, 80, 60, 40].every(c => viewportFloorLine(c, 20).length <= Math.max(c - 2, shortest.length)),
  )
  const { resetViewportFloorForTests, viewportFloorLive } = await import('../../src/ink/viewportFloor.ts')
  resetViewportFloorForTests()
  check('the live verdict engages the latch at the floor', viewportFloorLive(120, 40).fits && viewportFloorLive(98, 40).fits)
  check('… a second reading of the same frame answers the same (idempotent)', viewportFloorLive(98, 40).fits)
  check('… releases one column under the band and stays under until the floor', !viewportFloorLive(96, 40).fits && !viewportFloorLive(99, 40).fits && viewportFloorLive(100, 40).fits)
  resetViewportFloorForTests()
  check('a fresh boot under the floor never engages', !viewportFloorLive(98, 40).fits && !viewportFloorLive(99, 40).fits)
  resetViewportFloorForTests()
  const hook = read('src/ink/hooks/use-viewport-floor.ts')
  check(
    'one hook carries a host’s reading: the live verdict, the frozen size while under',
    hook.includes('viewportFloorLive(size.columns, size.rows)') &&
      hook.includes('if (verdict.fits && size !== null) lastFitRef.current = size') &&
      hook.includes('surfaceSize: verdict.fits ? size : lastFitRef.current'),
  )
  const alt = read('src/ink/components/AlternateScreen.tsx')
  check('the alternate-screen host reads the floor at the OUTERMOST instance only', alt.includes('const floor = useViewportFloor(size, !nested)'))
  check(
    'outermost is decided once at the depth claim and read from the ref on every later render',
    alt.includes('outermostRef.current = outermost') && alt.includes('const nested = outermostRef.current !== null\n    ? !outermostRef.current'),
  )
  check(
    'the surface stays mounted, out of layout under the floor, back in layout above it — the display named in both states',
    alt.includes("display={floor.fits ? 'flex' : 'none'}") &&
      alt.includes('<TerminalSizeContext.Provider value={floor.surfaceSize}>{children}</TerminalSizeContext.Provider>'),
  )
  check('the notice is one Text, painted only under the floor', alt.includes('{floor.line === null ? null : (') && alt.includes('{floor.line}'))
  const router = read('src/components/SurfaceRouter.tsx')
  check(
    'the route surface host reads the same floor and yields the frame under it',
    router.includes('const floor = useViewportFloor(useContext(TerminalSizeContext), true)') &&
      router.includes("display={floor.fits ? 'flex' : 'none'}") &&
      router.includes('<TerminalSizeContext.Provider value={floor.surfaceSize}>'),
  )
}

console.log('§16 — a resize storm paints its hold once, on entry')
{
  const ink = read('src/ink/ink.tsx')
  const entry = ink.indexOf('if (this.resizeSettleTimer === null) {')
  const elseAt = ink.indexOf('} else {', entry)
  const rearm = ink.indexOf('this.resizeSettleTimer = setTimeout(this.applySettledResize, RESIZE_SETTLE_MS)', entry)
  const hold = ink.indexOf('this.paintResizeHold(columns, rows)', entry)
  check('the holding paint sits inside the storm-entry branch', entry >= 0 && hold > entry && hold < elseAt)
  check('a later event only re-arms the timer (no hold after the re-arm)', rearm > elseAt && ink.indexOf('this.paintResizeHold(columns, rows)', rearm) === -1)
  check('the engine path keeps its one hold on storm entry', ink.includes('onStormEntered: () => {') && ink.includes('this.paintResizeHold(columns, rows)\n      },'))
}

console.log(failures === 0 ? '\nresize-laws: GREEN' : `\nresize-laws: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
