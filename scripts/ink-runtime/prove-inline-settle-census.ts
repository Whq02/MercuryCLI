#!/usr/bin/env bun
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

function journeySteps(cardRows: number): string[][] {
  const t = Array.from({ length: 14 }, (_, i) => `transcript line ${i}`)
  const composer = 'composer ready'
  const steps: string[][] = []
  steps.push([...t.slice(0, 6), composer])
  steps.push([...t.slice(0, 10), composer])
  steps.push([...t, composer])
  steps.push([...t, 'tool-row RUNNING Edit deck.tsx', 'progress beat 1', composer])
  steps.push([...t, 'tool-row RUNNING Edit deck.tsx', 'progress beat 2', composer])
  const card = Array.from({ length: cardRows }, (_, i) => `card row ${i}`)
  steps.push([...t, 'tool-row RUNNING Edit deck.tsx', 'progress beat 2', ...card, composer])
  steps.push([...t, 'tool-row RUNNING Edit deck.tsx', 'progress beat 2', composer])
  steps.push([...t, 'tool-row SETTLED Edit deck.tsx +5/-2', composer])
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
