#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-split-view.ts — THE SPLIT FRAME's laws.
//  The pin is the MECHANISM: the pure
//  store/geometry laws driven directly, the wiring proven by source census
//  (the house grep discipline) — never a pixel count.
//
//   A  TOGGLE PRESENCE per world/width: the plain world refuses (no board
//      to split with — the key untaught there: the stage filter drops `s`
//      exactly where it drops n/r); a full-stage frame under the
//      two-minimum threshold answers ONE honest line naming the needed
//      width and changes nothing; at/over the threshold the toggle flips;
//      OFF always works. The key-map rows tell the truth (the one
//      withSplitViewTruth resolver; every selection class keeps `s`).
//   B  THE ONE-CONNECTOR LAW: split never mints a second session host —
//      the chat pane reads THE focused slot and paints through the landed
//      SessionMirror; the split modules import no hop door, no birth door,
//      no daemon RPC, no supervisor, no attach ledger.
//   C  GEOMETRY at named widths: both minimums hold at every named ratio,
//      the panes + divider tile the frame exactly, the default gives the
//      board its lawful minimum and the chat the rest, the three ratios
//      coincide at the threshold.
//   D  FOCUS ROUTING: the chat pane is the Tab ring's LAST stop exactly
//      while the split composes; typing reaches only the focused pane (the
//      chat region is inert to the composer grammar); ↵ in the chat pane
//      discriminates full-chat vs the one birth door; row enters stay in
//      split (the slot re-point alone) while the rail's answer journey
//      keeps its flip to the consent card.
//   E  THE COLLAPSE LINE: dropping under the threshold collapses split back
//      to the full board with the one honest sentence, the store turns off,
//      and re-widening does NOT auto-re-split.
//
//  Hermetic: a scratch config home (the concourse switch defaults ON there,
//  so the store's live world-gate reads the fleet world); no daemon, no
//  wire, no TTY.
// ============================================================================
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }
const scratch = join(tmpdir(), `split-view-prove-${process.pid}`)
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
process.env['MERCURY_CONFIG_DIR'] = scratch

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const split = await import('../../src/components/concourse/splitView.ts')
const manifest = await import('../../src/components/concourse/controlManifest.ts')

// ── A: toggle presence per world/width ──────────────────────────────────────
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
  // The key-map truth ("the key-map row tells the truth").
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
  // The composer law holds: s is a REGION verb, never a composer
  // interception — the screen's handler lives inside the list-region block
  // and the chat block only.
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    // Needle re-trued: the gate carries no yield — the rows never hand a
    // letter to typing (typing needs the composer's own focus), so the
    // toggle fires in every list state.
    'A12 the toggle handler is a list-region letter-verb gated off the reduced stage',
    screen.includes("if (input === 's' && !key.ctrl && !key.meta && !reducedStage && pastGate())"),
  )
}

// ── B: the one-connector law ────────────────────────────────────────────────
console.log('B — the one-connector law (never a second host)')
{
  const pane = read('src/components/concourse/SplitChatPane.tsx')
  const store = read('src/components/concourse/splitView.ts')
  check('B1 the chat pane reads THE focused slot', pane.includes('subscribeFocusedSessionConnector') && pane.includes('getFocusedSessionConnector'))
  check('B2 the chat pane paints through the landed SessionMirror (the real pipeline)', pane.includes('<SessionMirror'))
  const forbidden = ['hopIntoSession', 'bornSession', 'attachedSession', 'daemonControlRpc', 'concourseSupervisor', 'setFocusedSessionConnector']
  check(
    'B3 the pane mints nothing: no hop door, no birth door, no attach ledger, no daemon RPC, no slot write',
    forbidden.every(name => !pane.includes(name)),
  )
  check('B4 the store is booleans and columns only (its one world import is the router)', forbidden.every(name => !store.includes(name)) && !store.includes('engine-connector'))
  check('B5 the pane never mounts a composer of its own (the caret story lives elsewhere)', !pane.includes('PromptInput') && !pane.includes('lineDraft'))
}

// ── C: geometry at named widths ─────────────────────────────────────────────
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

// ── D: focus routing ────────────────────────────────────────────────────────
console.log('D — focus routing')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('D1 the chat pane joins the Tab ring as its LAST stop exactly while split composes', screen.includes("if (splitActive) ring.push('chat')"))
  check(
    'D2 typing reaches only the focused pane: the chat region is inert to the composer grammar',
    screen.includes("if (region === 'chat') {") && screen.includes('TYPING REACHES ONLY THE FOCUSED PANE'),
  )
  check(
    'D3 ↵ in the chat pane discriminates: the full chat with a session, the one birth door with none (landing-guarded — SP-1)',
    screen.includes('if (hasFocusedSession()) callbacks.exitToRepl()') && screen.includes('else if (!landingInFlight()) armContractAsk()'),
  )
  check('D4 a vanished split settles the keys on the board (never a keyless focus)', screen.includes("if (!splitActive && region === 'chat') setRegion(reducedStage ? 'list' : 'live')"))
  check(
    'D5 ↑↓ browse fires from the chat pane too (a printed base key must fire)',
    screen.includes("region === 'chat' && (key.upArrow || key.downArrow)"),
  )
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  check(
    'D6 row enters stay in split: the slot re-point alone, the route holds',
    route.includes("splitFrameStands() && opts?.fullChat !== true") && route.includes("reason: 'in the chat pane'"),
  )
  // SWIFT C1 added the entry leg beside the flip — the full-chat semantic
  // stands, the attach now also declares its settled entry class.
  check('D7 the rail’s answer journey keeps its flip (the consent card lives only in the full chat)', route.includes("attachAndEnter(row.sessionId, 'board:open', { fullChat: true, entry: 'settled' })"))
  check('D8 the birth stays in split with its receipt naming the pane', route.includes('in the chat pane') && route.includes('splitFrameStands()'))
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('D9 the compositor reads the SAME frame as the screen (the frameCols seam)', layout.includes('frameCols?: number') && layout.includes('const cols = frameCols ?? termCols'))
  check('D10 the screen hands the board pane its granted columns and the split truth', read('src/components/concourse/ConcourseScreen.tsx').includes('frameCols: splitGeo.boardCols, splitOn: true'))
}

// ── E: the collapse line ────────────────────────────────────────────────────
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
  // The ratio nudge clamps at its ends and walks the named ladder.
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
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('E9 the screen derives composition from the same availability every frame (no half-paint beat)', screen.includes('splitViewOn() && splitAvailableAt(termCols, termRows)'))
  check('E10 the collapse effect paints the returned line as the note', screen.includes('collapseSplitForFrame(termCols, termRows)') && screen.includes("setNote({ tone: 'warning', text: c.line })"))
}

// ── F: THE ROWS LAW (the SP-9 half-frame class closed) ────────
//  A split standing on a frame whose ROWS the board pane's own profile
//  refuses painted the too-small refusal INSIDE a live split (one row short:
//  half a refusal, half a chat). The law: availability, the toggle, and the
//  resize collapse all read the WHOLE frame.
console.log('F — the rows law (the half-frame class)')
{
  const layout = await import('../../src/components/concourse/ConcourseLayout.tsx')
  // The rows floor is the viewport floor's (6cb0eaa: the profile reads the
  // one owner; the split constant reads it too) — the legs spell the frames
  // from the constant, never a literal.
  const R = split.SPLIT_MIN_ROWS
  check(
    `F1 availability refuses at 130×${R - 1} and affords at 130×${R}`,
    !split.splitAvailableAt(130, R - 1) && split.splitAvailableAt(130, R),
  )
  check(
    'F2 SPLIT_MIN_ROWS agrees with the profile floor by construction (the mirrored-constant pin)',
    layout.resolveConcourseProfile(split.BOARD_PANE_MIN_COLS, split.SPLIT_MIN_ROWS) !== 'too-small' &&
      layout.resolveConcourseProfile(split.BOARD_PANE_MIN_COLS, split.SPLIT_MIN_ROWS - 1) === 'too-small',
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
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'F8 the screen’s toggle sites hand the WHOLE frame to the store (no cols-only caller survives)',
    screen.includes('toggleSplitView(termCols, termRows)') && !screen.includes('toggleSplitView(termCols)'),
  )
  const route = read('src/components/concourse/ConcourseRoute.tsx')
  check(
    'F9 the stay-in-split resolver reads the frame through BOTH refs (completion-time truth)',
    route.includes('splitAvailableAt(termColsRef.current, termRowsRef.current)'),
  )
}

// ── G: legend continuity (AGENTDIALS C4) — pressing s narrows the board
//     pane to its lawful minimum and the legend used to shed the very keys
//     that named the split state (ties shed rightmost; s sat last): the
//     operator got lost inside a frame whose way back was unadvertised.
//     The manifest's ONE priority resolver now threads the split state, so
//     the way back outlives the narrow pane it creates. The pin composes
//     the paint site's own parts (browse + region verbs through
//     withSplitViewTruth + the atlas key + esc) and sheds at the split's
//     DEFAULT geometry: board-min ⇒ an 80-col pane, interior 76.
console.log('G — legend continuity: the way back survives the split-width shed')
{
  const { shedToFit } = await import('../../src/components/mercury-ui/geometry.ts')
  const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
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
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check(
    'G7 the paint site consumes the ONE resolver (no inline priority table survives)',
    layout.includes('legendPriorityOf(keys, { splitOn })') && !layout.includes("keys === 'esc' ? 4 :"),
  )
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nsplit-view: GREEN' : `\nsplit-view: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
