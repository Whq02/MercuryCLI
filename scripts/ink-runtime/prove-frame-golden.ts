#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-frame-golden.ts — freeze
//  frame composition.
//
//  Builds real DOM scenes (createNode/createTextNode/setStyle — the exact
//  production tree API), lays them out through the production layout engine,
//  composes them through the production renderer (createRenderer →
//  renderNodeToOutput → screen), and pins the resulting CELL GRID (text rows,
//  cursor, viewport) against the recorded golden. This is the composition
//  anchor for the B4 frame-family cuts: composition changes that alter any
//  painted cell fail here before any PTY journey runs.
//
//  Scope note (recorded): rows are the character projection (wide-cell
//  continuations collapse into their head cell, matching charInCellAt);
//  style/hyperlink cell attributes are pinned by the B4 semantic oracle, not
//  here.
//
//  Run:            ~/.bun/bin/bun run scripts/ink-runtime/prove-frame-golden.ts
//  Regen (review): … --record
// ============================================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  composeScene,
  type FrameScene,
  makeContext,
  screenLines,
} from './frameHarness.js'

const GOLDEN = join(import.meta.dir, 'goldens', 'frame-golden.json')
const record = process.argv.includes('--record')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function renderScene(scene: FrameScene): {
  lines: string[]
  cursor: { x: number; y: number; visible: boolean }
  viewport: { width: number; height: number }
} {
  const frame = composeScene(scene, makeContext())
  return {
    lines: screenLines(frame.screen),
    cursor: frame.cursor,
    viewport: frame.viewport,
  }
}

// ---------------------------------------------------------------------------
// Scenes

const SCENES: FrameScene[] = [
  {
    name: 'hello-padded-box',
    cols: 40,
    rows: 6,
    root: {
      kind: 'box',
      style: { padding: 1, borderStyle: 'single', width: 24 },
      children: [{ kind: 'text', text: 'Hello, Mercury' }],
    },
  },
  {
    name: 'two-columns-gap',
    cols: 40,
    rows: 4,
    root: {
      kind: 'box',
      style: { flexDirection: 'row', gap: 3 },
      children: [
        { kind: 'text', text: 'left lane' },
        { kind: 'text', text: 'right lane' },
      ],
    },
  },
  {
    name: 'wrap-narrow',
    cols: 12,
    rows: 6,
    root: {
      kind: 'box',
      style: { width: 12 },
      children: [
        { kind: 'text', style: { wrap: 'wrap' }, text: 'the quick brown fox jumps' },
      ],
    },
  },
  {
    name: 'wide-glyphs',
    cols: 24,
    rows: 3,
    root: {
      kind: 'box',
      style: { flexDirection: 'column' },
      children: [
        { kind: 'text', text: 'あい mixed 漢字' },
        { kind: 'text', text: 'crab and anchor' },
      ],
    },
  },
  {
    name: 'styled-runs',
    cols: 30,
    rows: 3,
    root: {
      kind: 'box',
      style: { flexDirection: 'column' },
      children: [
        { kind: 'text', style: { color: 'red', bold: true }, text: 'alert text' },
        { kind: 'text', style: { inverse: true }, text: 'inverted' },
      ],
    },
  },
  {
    name: 'nested-borders-grow',
    cols: 44,
    rows: 8,
    root: {
      kind: 'box',
      style: { flexDirection: 'row', width: 44, height: 8 },
      children: [
        {
          kind: 'box',
          style: { borderStyle: 'round', width: 14, flexShrink: 0 },
          children: [{ kind: 'text', text: 'rail' }],
        },
        {
          kind: 'box',
          style: { borderStyle: 'single', flexGrow: 1, padding: 1 },
          children: [{ kind: 'text', style: { wrap: 'wrap' }, text: 'center content that wraps within the padded frame' }],
        },
      ],
    },
  },
]

console.log('bedrock frame golden — the production composition pipeline')

type Golden = Record<string, ReturnType<typeof renderScene>>
const results: Golden = {}
for (const scene of SCENES) {
  const a = renderScene(scene)
  const b = renderScene(scene)
  check(
    `determinism: ${scene.name}`,
    JSON.stringify(a) === JSON.stringify(b),
  )
  results[scene.name] = a
}
console.log(`  ${SCENES.length} scenes composed`)

if (record) {
  writeFileSync(GOLDEN, JSON.stringify(results, null, 1) + '\n')
  console.log(`  recorded → ${GOLDEN}`)
} else {
  check('golden exists (run --record once)', existsSync(GOLDEN))
  if (existsSync(GOLDEN)) {
    const golden: Golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    check(
      'scene inventory matches',
      JSON.stringify(Object.keys(golden).sort()) === JSON.stringify(Object.keys(results).sort()),
    )
    let mismatches = 0
    for (const name of Object.keys(golden)) {
      if (!results[name]) continue
      if (JSON.stringify(golden[name]) !== JSON.stringify(results[name])) {
        mismatches++
        console.log(`  [FAIL] ${name}:`)
        console.log(`    golden:\n${golden[name]!.lines.map(l => '      |' + l).join('\n')}`)
        console.log(`    live:\n${results[name]!.lines.map(l => '      |' + l).join('\n')}`)
      }
    }
    check('all composed grids match the golden', mismatches === 0, `${mismatches} scenes diverged`)
  }
}

if (failures > 0) {
  console.log(`\nbedrock frame golden: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock frame golden: green')
