#!/usr/bin/env bun
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }


let failures = 0
let resizeLawSource = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — change the rule this check names in ${resizeLawSource}${detail ? ` — ${detail}` : ''}` : ''}`)
}

console.log('§1 B1 — the width-resize scale preserves recorded zeros')
{
  const { scaleHeightForWidth } = await import('../../src/screen/virtual-message-list/useVirtualScroll.ts')
  resizeLawSource = 'scaleHeightForWidth in src/screen/virtual-message-list/useVirtualScroll.ts'
  const ratios = [0.25, 0.5, 0.999, 1, 1.5, 2.7, 10]
  check('zero stays zero at every ratio', ratios.every(r => scaleHeightForWidth(0, r) === 0))
  check('a positive height floors at ONE line, never zero', ratios.every(r => scaleHeightForWidth(1, r) >= 1 && scaleHeightForWidth(7, r) >= 1))
  check('ratio 1 is identity for positives', [1, 2, 5, 16].every(h => scaleHeightForWidth(h, 1) === h))
  check('the scale rounds, not truncates (6 at 1.5 → 9; 7 at 0.5 → 4)', scaleHeightForWidth(6, 1.5) === 9 && scaleHeightForWidth(7, 0.5) === 4)
  const thereAndBack = (h: number): number => scaleHeightForWidth(scaleHeightForWidth(h, 0.5), 2)
  check('a there-and-back keeps zero at zero', thereAndBack(0) === 0)
}

console.log('§2 B2 — the spinner stack decision is a hysteresis band')
{
  const { spinnerStackDecision, STACK_EXIT_SLACK } = await import(
    '../../src/screen/spinner/spinnerHud.ts'
  )
  resizeLawSource = 'spinnerStackDecision and STACK_EXIT_SLACK in src/screen/spinner/spinnerHud.ts'
  const d = (cost: number, wasStacked: boolean, space = 40): boolean =>
    spinnerStackDecision({ eligible: true, cost, space, wasStacked })
  check('over the space it stacks, latched or not', d(41, false) && d(41, true))
  check('inside the band a STANDING stack holds (the jitter cannot flap it)', d(38, true) && d(36, true))
  check('inside the band a one-line row STAYS one line (entry is never eager)', !d(38, false) && !d(40, false))
  check('below the band the stack releases', !d(40 - STACK_EXIT_SLACK, true) && !d(20, true))
  check('ineligible never stacks whatever the latch says', !spinnerStackDecision({ eligible: false, cost: 100, space: 10, wasStacked: true }))
  check('the band out-sizes the counters’ per-tick width jitter', STACK_EXIT_SLACK > 4)
}

console.log('§3 B3 — the shell-progress reserve is monotone; the footer holds the bottom edge')
{
  const { reserveShellRows } = await import('../../src/screen/shell-output/ShellProgressMessage.tsx')
  resizeLawSource = 'reserveShellRows in src/screen/shell-output/ShellProgressMessage.tsx'
  check('growth latches: 3 shown after 5 keeps the 5-row reserve (2 pads)', reserveShellRows(3, 5).latch === 5 && reserveShellRows(3, 5).pad === 2)
  check('content grows the latch', reserveShellRows(4, 2).latch === 4 && reserveShellRows(4, 2).pad === 0)
  check('an all-blank window after content keeps the frame (never a collapse)', reserveShellRows(0, 5).latch === 5 && reserveShellRows(0, 5).pad === 5)
  check('the latch caps at the tail budget', reserveShellRows(9, 9).latch === 5)
  check('a fresh stream starts honest (nothing shown, nothing reserved)', reserveShellRows(0, 0).latch === 0)
}


console.log('§6 D2 — the composer viewport holds still inside the band')
{
  const { Cursor } = await import('../../src/screen/composer/vim/textCursor.ts')
  resizeLawSource = 'getViewportStartLine and render in src/screen/composer/vim/textCursor.ts'
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
  const identity = (s: string): string => s
  const paintedFrom = (cursor: InstanceType<typeof Cursor>, start?: number): string => cursor.render('', '', identity, undefined, MAX, undefined, start).split('\n')[0]!
  check(
    'the paint follows the band: with the window held at 10 and the caret on line 12, the first painted row is line 10 (the centred paint began at 8), and without a band the centred paint stands (F43A-C5-17)',
    paintedFrom(at(12), at(12).getViewportStartLine(MAX, held)) === 'line 10' && paintedFrom(at(12)) === 'line 8' && at(12).render('', '', identity, undefined, MAX, undefined, held).split('\n').length === MAX,
    `${paintedFrom(at(12), held)} / ${paintedFrom(at(12))}`,
  )
}


console.log('§9 D5 — the collapse notice dies when the frame affords again')
{
  const { collapseSplitForFrame, toggleSplitView, _resetSplitViewForTesting, splitAvailableAt, SPLIT_MIN_ROWS } = await import(
    '../../src/screen/concourse/splitView.ts'
  )
  resizeLawSource = 'collapseSplitForFrame and splitAvailableAt in src/screen/concourse/splitView.ts'
  _resetSplitViewForTesting()
  toggleSplitView(200, 50)
  const c = collapseSplitForFrame(130, SPLIT_MIN_ROWS - 1)
  check('the collapse line the clearer keys on is the one the store speaks', c.collapsed === true && c.line.startsWith('split collapsed'))
  check('affordance is the same predicate the effect reads', splitAvailableAt(200, 50) && !splitAvailableAt(130, SPLIT_MIN_ROWS - 1))
  _resetSplitViewForTesting()
}


console.log('§13 D9 — the terminal card reserves its probe block')
{
  const { inventoryLines } = await import('../../src/screen/renderer/terminal-session/windowsHostSetup.ts')
  resizeLawSource = 'inventoryLines in src/screen/renderer/terminal-session/windowsHostSetup.ts'
  const pending = inventoryLines({ windowsTerminal: 'unknown', pwsh7: 'unknown', winget: 'unknown' })
  const landed = inventoryLines({ windowsTerminal: 'present', pwsh7: 'missing', winget: 'present' })
  check('the roster is FIXED — the probe can only fill rows, never add them', pending.length === landed.length && pending.length === 2)
  check("the placeholder state has honest wording (the card paints 'not confirmed')", pending.every(l => l.state === 'unknown'))
}

console.log('§14 CB-05 — the state-word column is reserved; title columns are byte-stable')
{
  const { STATE_WORD_RESERVE, stateWordCell } = await import(
    '../../src/screen/concourse/ConcourseLayout.tsx'
  )
  resizeLawSource = 'STATE_WORD_RESERVE and stateWordCell in src/screen/concourse/ConcourseLayout.tsx'
  const words = ['ready', 'working', 'NEEDS YOU', 'with you', 'stalled', 'failed', 'queued', 'starting', 'paused', 'stopped', 'done', 'cancelled', 'draft', 'parked', 'a door']
  check('the longest table word sizes the column', STATE_WORD_RESERVE === Math.max(...words.map(w => w.length)))
  const stable = words.every(w => stateWordCell(w).length === stateWordCell(null).length)
  check('title columns byte-stable across every selection flip', stable)
  check('an unknown over-long raw state cannot move even its own row', stateWordCell('a-very-long-unknown-state').length === stateWordCell(null).length)
  check('the resting cell is pure space', stateWordCell(null) === ' '.repeat(1 + STATE_WORD_RESERVE))
  check('the filled cell: word then spaces (the still)', stateWordCell('ready') === ' ready    ' && stateWordCell('NEEDS YOU') === ' NEEDS YOU' && stateWordCell('a door') === ' a door   ')
}

console.log('§15 — live geometry and a bounded compact frame at every size')
{
  const { compactFrameBudget } = await import('../../src/screen/widgets/geometry.ts')
  const { HELM_HOME_MIN_COLS } = await import('../../src/screen/fullscreen-layout/helmGeometry.ts')
  resizeLawSource = 'compactFrameBudget in src/screen/widgets/geometry.ts (HELM_HOME_MIN_COLS lives in src/screen/fullscreen-layout/helmGeometry.ts)'
  check('100 columns remains a full-layout breakpoint, not an application floor', HELM_HOME_MIN_COLS === 100)
  for (const [columns, rows] of [[1, 1], [2, 2], [1, 40], [200, 1], [40, 10], [60, 16], [80, 24], [120, 24]]) {
    for (const activity of [false, true]) {
      for (const notice of [false, true]) {
        const b = compactFrameBudget(columns!, rows!, activity, notice ? 1 : 0)
        const sum = b.summaryRows + b.modelRows + b.activityRows + b.footerRows + b.noticeRows + b.composerBorderRows + b.editorPoolRows + b.transcriptMinRows
        check(`${columns}x${rows} activity=${activity} notice=${notice}: grants tile the real rows`, sum === rows && Object.values(b).every(v => v >= 0))
        check(`${columns}x${rows}: the editor owns a real cell`, b.inputColumns >= 1 && b.inputColumns + b.inputPrefixColumns + b.composerBorderColumns === columns && b.editorPoolRows >= 1)
      }
    }
  }
}


console.log(failures === 0 ? '\nresize-laws: GREEN' : `\nresize-laws: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
