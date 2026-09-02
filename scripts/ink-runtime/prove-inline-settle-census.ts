#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-inline-settle-census.ts — the
//  one-row-one-entry law for tool settles and consent cards (the §INLINE
//  duplication census).
//
//  THE OPERATOR SIGHTING: a tool call painting as TWO transcript entries —
//  the in-progress row AND the settled row standing in history as separate
//  rows ("file edits visually deducted twice"). The mechanism is the inline
//  writer's print-once epoch: content shrinking below the flush line forces
//  a viewport-band reprint (frame-writer.ts inlineEpochRepaint — "the cost
//  is print-once duplication"), so any ORDINARY-FLOW transient taller than
//  the live region turns its own teardown into a duplicated band. The
//  product-side kill is the bounded-preview law on consent cards
//  (permissions/boundedDiffPreview.ts, prove-consent-preview-bounded); THIS
//  prover pins the writer-level truth of both worlds over the production
//  compose→diff→serialize→replay pipeline (composeScene + FrameWriter +
//  AnsiEmulator — no PTY):
//
//    B — THE BOUNDED JOURNEY (the law): transcript past the viewport, a
//        running tool row with a live progress body, a VIEWPORT-BOUNDED
//        card opening and closing, the settle, renewed growth freezing the
//        settled row. Census over scrollback+window at the end:
//          · the RUNNING form stands NOWHERE (it never ceded);
//          · the SETTLED row stands EXACTLY ONCE (frozen in settled form);
//          · the card leaves ZERO residue (erased in place, never ceded);
//          · no transcript line stands twice — no epoch ever fired.
//    C — THE UNBOUNDED CONTROL (the disease, kept red-capable): the same
//        journey with a card TALLER than the viewport. Its close crosses
//        the flush line, the epoch reprints the band, and the census sees
//        a transcript line standing TWICE — proving the census has teeth
//        and documenting exactly why cards are bounded. If a writer change
//        ever kills this duplication at the source, this leg flips and the
//        bound becomes belt-and-braces: re-true it then, not before.
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-inline-settle-census.ts
// ============================================================================
import type { Frame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { optimizePatches as optimize } from '../../src/ink/patch-stream.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import { AnsiEmulator } from './ansiEmulator.js'
import {
  composeScene,
  type FrameScene,
  makeContext,
  type SceneNode,
} from './frameHarness.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// Cockpit proportions: the live tail below the last MUTABLE row (progress
// beat + bounded card + composer) must fit the viewport with slack, exactly
// what the bounded-preview law's chrome reserve guarantees in the product.
// A ZERO-slack variant exposes a separate sharp edge — the writer's cede
// ledger (flushedRows) misses the park-LF row that frozenRowBoundary counts
// (parkScrolled), so a mutable row sitting EXACTLY on the flush line has its
// settle dropped (stale RUNNING fossil) — characterized during this prover's
// construction, unreachable at the product's own margins; the ledger fix is
// named for the ink-runtime owner rather than cut here.
const COLS = 40
const VIEWPORT = 12

function transcriptScene(lines: string[]): FrameScene {
  const root: SceneNode = {
    kind: 'box',
    style: { flexDirection: 'column' },
    children: lines.map(text => ({ kind: 'text' as const, text })),
  }
  return { name: 'inline-census', cols: COLS, rows: VIEWPORT, root }
}

function serialize(diff: ReturnType<typeof optimize>): string {
  let captured = ''
  const fake = {
    stdout: {
      write(s: string) {
        captured += s
        return true
      },
      isTTY: false,
    },
  }
  writeDiffToTerminal(fake as never, diff, true)
  return captured
}

/** Drive one journey through a fresh writer + emulator; return the final
 *  logical output (scrollback + window, end-trimmed). */
function driveJourney(steps: string[][]): { logical: string[]; emu: AnsiEmulator } {
  const ctx = makeContext()
  const log = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const emu = new AnsiEmulator(COLS, VIEWPORT, false)
  let prevFrame: Frame | undefined
  for (const step of steps) {
    const frame = composeScene(transcriptScene(step), ctx, prevFrame, {
      altScreen: false,
      viewportRows: VIEWPORT,
      contentHeight: true,
    })
    const rawDiff = log.render(
      prevFrame ?? {
        screen: composeScene(transcriptScene([]), makeContext(), undefined, {
          altScreen: false,
          viewportRows: VIEWPORT,
          contentHeight: true,
        }).screen,
        viewport: { width: COLS, height: VIEWPORT },
        cursor: { x: 0, y: 0, visible: true },
      },
      frame,
      false,
      true,
    )
    emu.feed(serialize(optimize(rawDiff)))
    prevFrame = frame
  }
  const logical = [...emu.scrollback, ...emu.lines()]
  while (logical.length > 0 && logical[logical.length - 1] === '') logical.pop()
  return { logical, emu }
}

const count = (lines: string[], needle: string): number =>
  lines.filter(line => line.trimEnd() === needle).length

/** The shared journey skeleton; cardRows decides bounded vs disease. The
 *  composer line rides every step, the way the cockpit's live tail does. */
function journeySteps(cardRows: number): string[][] {
  const t = Array.from({ length: 14 }, (_, i) => `transcript line ${i}`)
  const composer = 'composer ready'
  const steps: string[][] = []
  // grow the settled transcript past the viewport in stages
  steps.push([...t.slice(0, 6), composer])
  steps.push([...t.slice(0, 10), composer])
  steps.push([...t, composer])
  // the tool dispatches: running row + live progress body
  steps.push([...t, 'tool-row RUNNING Edit deck.tsx', 'progress beat 1', composer])
  steps.push([...t, 'tool-row RUNNING Edit deck.tsx', 'progress beat 2', composer])
  // the consent card opens under it
  const card = Array.from({ length: cardRows }, (_, i) => `card row ${i}`)
  steps.push([...t, 'tool-row RUNNING Edit deck.tsx', 'progress beat 2', ...card, composer])
  // approved: the card closes whole
  steps.push([...t, 'tool-row RUNNING Edit deck.tsx', 'progress beat 2', composer])
  // the tool settles: body gone, the row changes state IN PLACE
  steps.push([...t, 'tool-row SETTLED Edit deck.tsx +5/-2', composer])
  // the reply continues and the settled row freezes in SETTLED form
  const after = Array.from({ length: 11 }, (_, i) => `after settle ${i}`)
  steps.push([...t, 'tool-row SETTLED Edit deck.tsx +5/-2', ...after, composer])
  return steps
}

console.log('inline settle census — one row, one entry, one state in history')

console.log('\nB — the bounded journey (card fits the pane)')
{
  const { logical, emu } = driveJourney(journeySteps(6))
  check(
    'the RUNNING form stands nowhere in history (it never ceded)',
    count(logical, 'tool-row RUNNING Edit deck.tsx') === 0,
    `running×${count(logical, 'tool-row RUNNING Edit deck.tsx')}`,
  )
  check(
    'the SETTLED row stands exactly once — one row, one entry, its final state',
    count(logical, 'tool-row SETTLED Edit deck.tsx +5/-2') === 1,
    `settled×${count(logical, 'tool-row SETTLED Edit deck.tsx +5/-2')}`,
  )
  check(
    '…and it froze into scrollback in its SETTLED form',
    emu.scrollback.some(row => row.trimEnd() === 'tool-row SETTLED Edit deck.tsx +5/-2'),
  )
  const cardResidue = logical.filter(line => line.startsWith('card row ')).length
  check('the bounded card leaves ZERO residue', cardResidue === 0, `residue×${cardResidue}`)
  let dupes = 0
  for (let i = 0; i < 14; i++) {
    if (count(logical, `transcript line ${i}`) > 1) dupes++
  }
  check('no transcript line stands twice — the epoch never fired', dupes === 0, `${dupes} duplicated`)
  check('the journey genuinely ceded rows (the census is not vacuous)', emu.scrollback.length > 0)
}

console.log('\nC — the unbounded control (card taller than the pane; the disease documented)')
{
  const { logical } = driveJourney(journeySteps(25))
  let dupes = 0
  for (let i = 0; i < 14; i++) {
    if (count(logical, `transcript line ${i}`) > 1) dupes++
  }
  const runningCount = count(logical, 'tool-row RUNNING Edit deck.tsx')
  check(
    'an over-viewport card close forces the epoch: transcript lines stand TWICE (the census has teeth)',
    dupes > 0 || runningCount > 1,
    `dupes=${dupes} running×${runningCount}`,
  )
}

if (failures > 0) {
  console.log(`\ninline settle census: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\ninline settle census: green — bounded transients keep history single-entry')
