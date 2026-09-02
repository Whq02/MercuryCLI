#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-resize-laws.ts — THE LIVE-RESIZE LAWS.
//  A resize must recompute the frame without
//  inventing or destroying geometry: heights re-derive, zeros stay zero,
//  bands re-tile, and nothing accumulates across a there-and-back. Sibling
//  ratchets: prove-chrome-hysteresis (the cockpit latch),
//  prove-split-view §F (the split's frame law),
//  prove-switchboard-geometry (band re-derivation). Pure legs only — the
//  live storms are the driver legs (NEEDS-REAL-BOX).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-resize-laws.ts
// ============================================================================
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

// ── §1 (ctr-7 closed): a recorded zero survives every resize
//  The transcript's height cache deliberately records 0 for rows that
//  painted nothing ("a recorded zero is what lets the start-advance guard
//  move on"), and the width-resize scale path promoted every such row to
//  one phantom line per resize — geometry inflated by the invisible-row
//  count, permanently, and travel/clamp read the inflated offsets.
console.log('§1 B1 — the width-resize scale preserves recorded zeros')
{
  const { scaleHeightForWidth } = await import('../../src/hooks/useVirtualScroll.ts')
  const ratios = [0.25, 0.5, 0.999, 1, 1.5, 2.7, 10]
  check('zero stays zero at every ratio', ratios.every(r => scaleHeightForWidth(0, r) === 0))
  check('a positive height floors at ONE line, never zero', ratios.every(r => scaleHeightForWidth(1, r) >= 1 && scaleHeightForWidth(7, r) >= 1))
  check('ratio 1 is identity for positives', [1, 2, 5, 16].every(h => scaleHeightForWidth(h, 1) === h))
  check('the scale rounds, not truncates (6 at 1.5 → 9; 7 at 0.5 → 4)', scaleHeightForWidth(6, 1.5) === 9 && scaleHeightForWidth(7, 0.5) === 4)
  // A there-and-back never inflates a zero into geometry.
  const thereAndBack = (h: number): number => scaleHeightForWidth(scaleHeightForWidth(h, 0.5), 2)
  check('a there-and-back keeps zero at zero', thereAndBack(0) === 0)
  const hook = read('src/hooks/useVirtualScroll.ts')
  check('the resize loop rides the pure scale (no inline Math.max survives)', hook.includes('cache.set(key, scaleHeightForWidth(height, ratio))') && !hook.includes('cache.set(key, Math.max(1, Math.round(height * ratio)))'))
  check(
    'the zero-record law this pairs with still stands (rows that painted nothing record 0)',
    hook.includes('cache.set(key, 0)') && hook.includes('a recorded zero is what lets the start-advance guard move on'),
  )
}

// ── §2 (SSR-04): the working row's stack decision holds a band
//  The stack cost includes counters whose width jitters every animation
//  tick (tok/s, the k-counter): the raw cost>space comparison flipped the
//  row 1↔2 per tick at the boundary, jumping the transcript above it once a
//  second. The pure fold: stack the moment it does not fit; UNSTACK only
//  with STACK_EXIT_SLACK cells to spare.
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
  // The tick-jitter amplitude the band must exceed: a k-digit + a tok/s
  // digit + separators ≈ 4 cells — the band is wider.
  check('the band out-sizes the counters’ per-tick width jitter', STACK_EXIT_SLACK > 4)
  const row = read('src/components/Spinner/SpinnerAnimationRow.tsx')
  check(
    'the component rides the pure fold through a per-instance latch',
    row.includes('const stacked = spinnerStackDecision({') && row.includes('stackedLatchRef.current = stacked') && row.includes('const stackedLatchRef = useRef(false)'),
  )
  check('the raw flapping comparison is gone', !row.includes('(segBFullCost > 0 || suffixText !== \'\') && segBFullCost > oneLineSpace\n'))
}

// ── §3 (TS-7): the shell-progress block never shrinks mid-stream
//  The streamed output is a ROLLING window (TaskOutput's most-recent-5
//  lines) filtered to non-blank per frame: blanks rolling through shrank
//  and regrew the block once a second, jittering the transcript around the
//  very surface the operator reads. The reserve is monotone per stream.
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

// ── §4: render trees never read process.stdout for size
//  A component or command surface that reads process.stdout.columns/rows
//  bypasses TerminalSizeContext twice over: it misses the cockpit's
//  narrowed centre column (the /context bars overflowed it; a permission
//  dialog over-measured its previews), and it never resubscribes on
//  resize. The lawful owners: the context (useTerminalSize) inside the
//  tree, and staticPrintColumns (staticRender.tsx — reads the SAME
//  chromeModeLive/railPlan owners the layout reads) for detached prints.
//  Zero allowlist over src/components + src/screens + src/commands.
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

// ── §5 (PD-3): the two-column select's column holds still
//  The description column's label width was measured over the VISIBLE
//  window — every scroll step re-derived the widest visible label and the
//  column slid sideways under the operator. One width for the life of the
//  list: the measure runs over the WHOLE option list.
console.log('§5 D1 — the select description column is list-measured, not window-measured')
{
  const sel = read('src/components/CustomSelect/select.tsx')
  check('the column measures the WHOLE list', sel.includes('const labelColumnWidth = options.reduce((max, option) => {'))
  check('the window-local measure is gone', !sel.includes('const labelColumnWidth = visible.reduce'))
}

// ── §6 (CI-05): the composer viewport is a stable band
//  The window was rigidly caret-centred: every ↑/↓ scrolled the WHOLE
//  draft one row while the caret sat visually still. With history the
//  window holds until the caret leaves the band (one scrolloff row where
//  the window affords it); without history the centred landing stands.
console.log('§6 D2 — the composer viewport holds still inside the band')
{
  const { Cursor } = await import('../../src/utils/Cursor.ts')
  const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const at = (line: number): InstanceType<typeof Cursor> => {
    // offset of the line's first char: lines are 'line N\n'
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

// ── §7 (MGR-5): option clicks carry STRUCTURAL identity
//  The interview card mapped clicks by localRow arithmetic ("one row per
//  option") — wrong the moment any option wrapped. The compact-vertical
//  Select's option boxes now carry their OWN click (focus-only — the same
//  select-never-commit law the digit fence rides), and the arithmetic is
//  gone.
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

// ── §8 (SP-3 + SP-5): the divider partitions pointer AND wheel
//  Two mirrors mount under split with the SAME fixed pointer ids (hovering
//  one lit the other), and the wheel followed FOCUS, not the pointer's
//  side of the divider. Now: the chat pane's mirror carries its own id
//  namespace, and every mirror wheel is gated by the pane's column band —
//  an event on the other side is never consumed, focused or not.
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

// ── §9 (SP-6): the collapse notice expires with its truth
//  "split collapsed — needs 121 columns" kept standing after the operator
//  widened the window past the threshold. The collapse effect now clears
//  exactly the collapse note the moment the frame affords again — and
//  only that note.
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

// ── §10: the /daemon cursor is an identity, not an index
//  A bare index over a roster that reaps and reorders under the 4-second
//  poll teleported the cursor (and its open drill) to a different seat per
//  refresh. The key survives the shuffle; a reaped seat falls to its
//  clamped neighbour; arrows move from the row the operator SEES.
console.log('§10 D6 — the daemon cursor survives the roster shuffle by key')
{
  const view = read('src/components/mercury-ui/parity/DaemonSupervisorView.tsx')
  check('the cursor carries a key beside the index', view.includes("const [selKey, setSelKey] = React.useState<string | null>(null)"))
  check('the key wins where it exists; the clamp is the reap fallback', view.includes('const clampedSel = keyAt >= 0 ? keyAt : indexClamped'))
  check('the index state re-anchors to the painted row', view.includes('if (sel !== clampedSel) setSel(clampedSel)'))
  check('arrows move from the PAINTED cursor and restamp the key', view.includes('const next = Math.max(0, clampedSel - 1)') && view.includes('setSelKey(v.workers[next]?.short ?? null)'))
  check('no bare functional index-walk survives', !view.includes('setSel(s => Math.max(0, s - 1))'))
}

// ── §11 (SL-3 + SL-4): the picker neither tears nor doubles
//  A rename ran the FULL reload (spinner, selection, scroll, search all
//  lost — the picker rebuilt from the top for a one-row title change);
//  and the near-bottom trigger could run two overlapping loadMores over
//  the SAME slice — the batch appended twice and grouping counted the
//  duplicates as phantom "(+N)" forks.
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

// ── §12 (CI-04, RE-TRUED by steer-removal): the steering
//  band died WITH the pen — the operator ruled the strip and hint removed
//  whole, so the turn-stability law this section pinned has no subject.
//  POISON: the band's files must not return; a revival re-pins its mount
//  discipline (D8's keystroke-bounce class) with it.
console.log('§12 D8 — the steering band stays dead (steer-removal poison)')
{
  const { existsSync } = await import('node:fs')
  check('the strip component stays deleted', !existsSync(join(ROOT, 'src/components/PromptInput/PromptInputQueuedCommands.tsx')))
  check('the hint component stays deleted', !existsSync(join(ROOT, 'src/components/PromptInput/QueuedSteeringHint.tsx')))
}

// ── §13 (BFF-04/w32-07): the terminal card's frame is stable
//  The win32 host probe used to mount the whole "on this machine" section
//  ~1s after paint — the card re-laid itself under the operator. The block
//  is reserved from the first frame with the honest 'not confirmed' state
//  per line; the probe fills the SAME rows in place.
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

// ── §14 (CB-05, OPERATOR-RULED — the reserve column): titles never move
//  The selected row's state word (item 4's ruled law — the word beside the
//  glyph, its own ink) used to INSERT into the truncating cell: every
//  arrow press shifted titles up to ~10 columns. The operator ruled (a):
//  every row reserves the word column, the selected row fills it, titles
//  hold; the resting indent is deliberate and NOT a wiggle to polish back.
console.log('§14 CB-05 — the state-word column is reserved; title columns are byte-stable')
{
  const { STATE_WORD_RESERVE, stateWordCell } = await import(
    '../../src/components/concourse/ConcourseLayout.tsx'
  )
  const layoutSrc = read('src/components/concourse/ConcourseLayout.tsx')
  // The reserve derives from the TABLE ITSELF (never a retyped list).
  check('the reserve is table-derived', layoutSrc.includes('Object.values(STATE_WORD).map(word => word.length)'))
  const words = ['ready', 'working', 'NEEDS YOU', 'with you', 'stalled', 'failed', 'queued', 'starting', 'paused', 'stopped', 'done', 'cancelled', 'draft', 'parked', 'a door']
  check('the longest table word sizes the column', STATE_WORD_RESERVE === Math.max(...words.map(w => w.length)))
  // TWO ADJACENT SELECTIONS: the title's x is the prefix width — selected
  // and unselected cells are the SAME width for every state, so flipping
  // the selection between adjacent rows moves ink and word, never a title.
  const stable = words.every(w => stateWordCell(w).length === stateWordCell(null).length)
  check('title columns byte-stable across every selection flip', stable)
  check('an unknown over-long raw state cannot move even its own row', stateWordCell('a-very-long-unknown-state').length === stateWordCell(null).length)
  // THE RESTING STILL — the new look's fixture: the cell per state,
  // selected and at rest. A drift here is a deliberate re-rule, not noise.
  check('the resting cell is pure space', stateWordCell(null) === ' '.repeat(1 + STATE_WORD_RESERVE))
  check('the filled cell: word then spaces (the still)', stateWordCell('ready') === ' ready    ' && stateWordCell('NEEDS YOU') === ' NEEDS YOU' && stateWordCell('a door') === ' a door   ')
  // The paint site rides the cell UNCONDITIONALLY (every row holds it).
  check(
    'every row paints the reserve cell (the selected row fills, the rest hold spaces)',
    layoutSrc.includes('stateWordCell(') && layoutSrc.includes("? (STATE_WORD[r.state] ?? r.state)\n                            : null,"),
  )
  check('the old inserting paint is gone', !layoutSrc.includes('<Text color={t[sg.color]}> {STATE_WORD[r.state] ?? r.state}</Text>'))
}

console.log(failures === 0 ? '\nresize-laws: GREEN' : `\nresize-laws: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
