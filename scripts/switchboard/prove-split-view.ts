#!/usr/bin/env bun
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const scratch = join(tmpdir(), `split-view-prove-${process.pid}`)
removeScratch(scratch)
mkdirSync(scratch, { recursive: true })
process.env['MERCURY_CONFIG_DIR'] = scratch

const REPO = join(import.meta.dir, '..', '..')

let failures = 0
const splitFailureHint = (label: string): string => {
  if (/^A([6-9]|1\d)/.test(label) || /^G/.test(label)) return 'change the key rows or the legend in src/screen/concourse/controlManifest.ts (regionKeysFor, withSplitViewTruth, legendPriorityOf, CONCOURSE_CONTROLS)'
  if (/^F2/.test(label)) return 'change resolveConcourseProfile in src/screen/concourse/ConcourseLayout.tsx'
  if (/^C/.test(label)) return 'change splitGeometryAt and the pane minimums in src/screen/concourse/splitView.ts'
  if (/^[AEF]/.test(label)) return 'change splitToggleDecisionOf, splitAvailableAt, toggleSplitView, collapseSplitForFrame or nudgeSplitRatio in src/screen/concourse/splitView.ts'
  return 'change src/screen/concourse/splitView.ts'
}
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : `${detail ? `${detail} — ` : ''}${splitFailureHint(label)}`
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

const split = await import('../../src/screen/concourse/splitView.ts')
const manifest = await import('../../src/screen/concourse/controlManifest.ts')

console.log('A — toggle presence per world/width')
{
  const plain = split.splitToggleDecisionOf({ on: false, cols: 200, rows: 50, plainWorld: true })
  check('A1 the plain world refuses the toggle (no board to split with)', !plain.ok && plain.code === 'plain-world')
  const narrow = split.splitToggleDecisionOf({ on: false, cols: 120, rows: 50, plainWorld: false })
  check(
    'A2 under the threshold: one honest line naming the needed width and the frame',
    !narrow.ok && narrow.code === 'too-narrow' && narrow.reason.includes(String(split.splitMinCols())) && narrow.reason.includes('120'),
  )
  const at = split.splitToggleDecisionOf({ on: false, cols: split.splitMinCols(), rows: 50, plainWorld: false })
  check('A3 at the threshold the toggle flips on', at.ok && at.on)
  const offNarrow = split.splitToggleDecisionOf({ on: true, cols: 80, rows: 50, plainWorld: false })
  const offPlain = split.splitToggleDecisionOf({ on: true, cols: 80, rows: 50, plainWorld: true })
  check('A4 OFF always works — width and world never trap a standing split', offNarrow.ok && !offNarrow.on && offPlain.ok && !offPlain.on)
  check('A5 availability: 120 refuses, 121 affords', !split.splitAvailableAt(120, 50) && split.splitAvailableAt(121, 50) && split.splitMinCols() === 121)
  const listFull = manifest.regionKeysFor('list', { newSession: true })
  const listReduced = manifest.regionKeysFor('list', { newSession: false })
  check('A6 the full-stage list grammar prints s split', listFull.some(k => k.keys === 's' && k.label === 'split'))
  check('A7 the reduced stage prints NO s (untaught where the key is dead)', listReduced.every(k => k.keys !== 's'))
  const truth = manifest.withSplitViewTruth(listFull, { splitOn: true })
  check('A8 the one label resolver reads the way back while split stands', truth.some(k => k.keys === 's' && k.label === 'full board'))
  const selections = ['live', 'paused', 'attached', 'queued', 'parked', 'stopped', 'door', 'none'] as const
  check(
    'A9 every selection class keeps s (the toggle is a view control, never a row control)',
    selections.every(sel => manifest.regionKeysFor('list', { newSession: true, selection: sel }).some(k => k.keys === 's')),
  )
  const control = manifest.CONCOURSE_CONTROLS.find(c => c.id === 'board:split-toggle')
  check('A10 the manifest census carries the toggle on s in the list region', control !== undefined && control.keys.includes('s') && control.region === 'list')
  const chatKeys = manifest.regionKeysFor('chat', { newSession: true, chatSession: true })
  const chatEmpty = manifest.regionKeysFor('chat', { newSession: true, chatSession: false })
  check(
    'A11 the chat pane rows tell the slot truth: ↵ full chat with a session, ↵ new session with none; s is the way back',
    chatKeys.some(k => k.keys === '↵' && k.label === 'full chat') &&
      chatEmpty.some(k => k.keys === '↵' && k.label === 'new session') &&
      chatKeys.some(k => k.keys === 's' && k.label === 'full board'),
  )
}


console.log('C — geometry at named widths')
{
  let sound = true
  let tiles = true
  for (const cols of [121, 130, 140, 160, 200, 300]) {
    for (const ratio of split.SPLIT_RATIOS) {
      const g = split.splitGeometryAt(cols, ratio)
      if (g.boardCols < split.BOARD_PANE_MIN_COLS || g.chatCols < split.CHAT_PANE_MIN_COLS) sound = false
      if (g.boardCols + split.SPLIT_DIVIDER_COLS + g.chatCols !== cols) tiles = false
      if (g.dividerCol !== g.boardCols) tiles = false
    }
  }
  check('C1 both minimums hold at every named ratio and width', sound)
  check('C2 the panes + divider tile the frame exactly', tiles)
  const def = split.splitGeometryAt(200, 'board-min')
  check('C3 the default: the board keeps its lawful minimum, the chat takes the rest', def.boardCols === split.BOARD_PANE_MIN_COLS && def.chatCols === 200 - 1 - split.BOARD_PANE_MIN_COLS)
  const even = split.splitGeometryAt(201, 'even')
  check('C4 even shares the frame', Math.abs(even.boardCols - even.chatCols) <= 1)
  const chatMin = split.splitGeometryAt(200, 'chat-min')
  check('C5 chat-min is the mirror image', chatMin.chatCols === split.CHAT_PANE_MIN_COLS)
  const g121 = split.SPLIT_RATIOS.map(r => split.splitGeometryAt(121, r))
  check('C6 at the threshold the three ratios coincide honestly', g121.every(g => g.boardCols === split.BOARD_PANE_MIN_COLS && g.chatCols === split.CHAT_PANE_MIN_COLS))
  check('C7 the board pane is never a frame the board calls too small (80 = the profile floor)', split.BOARD_PANE_MIN_COLS === 80)
}


console.log('E — the collapse line')
{
  split._resetSplitViewForTesting()
  const before = split.collapseSplitForFrame(100, 50)
  check('E1 an OFF split never collapses (no phantom line)', before.collapsed === false)
  const on = split.toggleSplitView(200, 50)
  check('E2 the live toggle flips on in the fleet world at width', on.ok && on.on && split.splitViewOn())
  const wide = split.collapseSplitForFrame(160, 50)
  check('E3 a frame that affords never collapses', wide.collapsed === false && split.splitViewOn())
  const narrow = split.collapseSplitForFrame(100, 50)
  check(
    'E4 under the threshold: collapsed with the one honest sentence',
    narrow.collapsed === true && narrow.line.includes('split collapsed') && narrow.line.includes(String(split.splitMinCols())) && narrow.line.includes('100'),
  )
  check('E5 the store turned off — the full board stands', !split.splitViewOn())
  check('E6 re-widening does NOT auto-re-split (the toggle is the operator’s)', split.splitAvailableAt(200, 50) && !split.splitViewOn())
  split._resetSplitViewForTesting()
  split.toggleSplitView(200, 50)
  const stuckLeft = split.nudgeSplitRatio(-1)
  check('E7 the divider clamps at board-min (no wrap)', stuckLeft.moved === false && stuckLeft.ratio === 'board-min')
  const toEven = split.nudgeSplitRatio(1)
  const toChatMin = split.nudgeSplitRatio(1)
  const stuckRight = split.nudgeSplitRatio(1)
  check(
    'E8 ] walks board-min → even → chat-min and clamps',
    toEven.moved === true && toEven.ratio === 'even' && toChatMin.moved === true && toChatMin.ratio === 'chat-min' && stuckRight.moved === false,
  )
}

console.log('F — the rows law (the half-frame class)')
{
  const layout = await import('../../src/screen/concourse/ConcourseLayout.tsx')
  const R = split.SPLIT_MIN_ROWS
  check(
    `F1 availability refuses at 130×${R - 1} and affords at 130×${R}`,
    !split.splitAvailableAt(130, R - 1) && split.splitAvailableAt(130, R),
  )
  check(
    'F2 losing a split row still leaves a working stacked board',
    layout.resolveConcourseProfile(split.BOARD_PANE_MIN_COLS, split.SPLIT_MIN_ROWS) === 'stacked' &&
      layout.resolveConcourseProfile(split.BOARD_PANE_MIN_COLS, split.SPLIT_MIN_ROWS - 1) === 'stacked',
  )
  const short = split.splitToggleDecisionOf({ on: false, cols: 130, rows: R - 1, plainWorld: false })
  check(
    `F3 the toggle at 130×${R - 1} refuses as too-short, naming the rows floor and the frame`,
    !short.ok && short.code === 'too-short' && short.reason.includes(String(split.SPLIT_MIN_ROWS)) && short.reason.includes(`130×${R - 1}`),
  )
  split._resetSplitViewForTesting()
  split.toggleSplitView(200, 50)
  const collapsed = split.collapseSplitForFrame(130, R - 1)
  check(
    'F4 a live split on a shortened frame collapses with the honest rows line; the store turns off',
    collapsed.collapsed === true && collapsed.line.includes('split collapsed') && collapsed.line.includes(String(split.SPLIT_MIN_ROWS)) && !split.splitViewOn(),
  )
  check('F5 re-growing does NOT auto-re-split (the toggle is the operator’s)', split.splitAvailableAt(200, 50) && !split.splitViewOn())
  const widthOnly = split.splitToggleDecisionOf({ on: false, cols: 120, rows: 50, plainWorld: false })
  check(
    'F6 the width-only sentence is byte-identical to the pre-rows-law line (the width behavior provably unmoved)',
    !widthOnly.ok && widthOnly.reason === 'split needs 121 columns (board 80 + chat 40 + the divider) — this frame is 120',
  )
  const both = split.splitToggleDecisionOf({ on: false, cols: 100, rows: 20, plainWorld: false })
  check(
    'F7 both failing names both dimensions in one sentence',
    !both.ok && both.reason.includes(`121 columns and ${R} rows`) && both.reason.includes('100×20'),
  )
}

console.log('G — legend continuity: the way back survives the split-width shed')
{
  const { shedToFit } = await import('../../src/screen/widgets/geometry.ts')
  const { keyHintLabel } = await import('../../src/screen/widgets/keyHintLabel.ts')
  const interior = split.splitGeometryAt(161, 'board-min').boardCols - 4
  const legendAt = (region: 'list' | 'chat', splitOn: boolean): string[] => {
    const browse = manifest.browseKeysFor({ chatPresent: true, region })
    const parts = [
      ...browse.filter(k => k.keys !== 'esc'),
      ...manifest.withSplitViewTruth(
        manifest.regionKeysFor(
          region,
          region === 'list'
            ? { newSession: true, selection: 'live' as const }
            : { newSession: true, chatSession: true },
        ),
        { splitOn },
      ),
      manifest.CONCOURSE_HELP_KEY,
      browse.find(k => k.keys === 'esc')!,
    ].map(k => ({ text: `${keyHintLabel(k.keys)} ${k.label}`, priority: manifest.legendPriorityOf(k.keys, { splitOn }) }))
    return shedToFit(parts, interior, ' · ').map(p => p.text)
  }
  check('G0 the geometry under test IS the default split (board at its 80-col minimum)', interior === 76)
  const offBoard = legendAt('list', false)
  check(
    "G1 CONTROL (the disease's shape): off-split at the same width the tie-class shed drops the s row — the bump is doing real work",
    !offBoard.some(t => t.includes(' split')),
    offBoard.join(' · '),
  )
  const onBoard = legendAt('list', true)
  check('G2 the split-on LIST legend keeps the way back painted at the narrowed pane', onBoard.some(t => t === `${keyHintLabel('s')} full board`), onBoard.join(' · '))
  check('G3 …beside the exit promise and the atlas key (the survivors above the tie class)', onBoard.some(t => t.includes('esc')) && onBoard.some(t => t.startsWith(keyHintLabel('?'))))
  const onChat = legendAt('chat', true)
  check('G4 the split CHAT region keeps its own way back at the same width', onChat.some(t => t === `${keyHintLabel('s')} full board`), onChat.join(' · '))
  const listTruth = manifest.withSplitViewTruth(manifest.regionKeysFor('list', { newSession: true, selection: 'live' }), { splitOn: true })
  const chatTruth = manifest.withSplitViewTruth(manifest.regionKeysFor('chat', { newSession: true, chatSession: true }), { splitOn: true })
  check(
    'G5 the divider row prints beside the way back where the nudge fires — appended once on the list, never duplicated on the chat',
    listTruth.filter(k => k.keys === '[ ]').length === 1 &&
      listTruth.findIndex(k => k.keys === '[ ]') === listTruth.findIndex(k => k.keys === 's') + 1 &&
      chatTruth.filter(k => k.keys === '[ ]').length === 1,
  )
  check(
    'G6 off-split the resolver is byte-identical (no divider row, s reads split, the old weights)',
    manifest.withSplitViewTruth(manifest.regionKeysFor('list', { newSession: true, selection: 'live' }), { splitOn: false }).every(k => k.keys !== '[ ]') &&
      manifest.legendPriorityOf('s', { splitOn: false }) === 3 &&
      manifest.legendPriorityOf('esc', { splitOn: false }) === 4 &&
      manifest.legendPriorityOf('esc', { splitOn: true }) > manifest.legendPriorityOf('s', { splitOn: true }) &&
      manifest.legendPriorityOf('s', { splitOn: true }) > manifest.legendPriorityOf('?', { splitOn: true }),
  )
}

removeScratch(scratch)
console.log(failures === 0 ? '\nsplit-view: GREEN' : `\nsplit-view: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
