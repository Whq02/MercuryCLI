#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-layout-differential.ts —
//  the dual-engine differential.
//
//  Runs the shared scene corpus (layoutScenes.ts) AND a much larger seeded
//  random space through BOTH the previous engine (oracle) and Mercury Cell
//  Layout, comparing every node's per-pass rounded rectangle exactly. While
//  the old engine exists in-tree this is the strongest oracle available;
//  after its deletion the frozen golden (prove-layout-corpus.ts) remains the
//  regression anchor and this proof compares Cell Layout against the golden
//  instead of the live oracle.
//
//  Also pins the §6 structural laws on the owned engine:
//    • repeat-layout silence — a second calculateLayout with unchanged
//      inputs re-calls ZERO measure functions;
//    • relayout purity — content restored ⇒ rects restored;
//    • NaN before first layout.
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-layout-differential.ts
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCellLayoutNode } from '../../src/ink/layout/cellLayout.js'
import type { LayoutNode } from '../../src/ink/layout/node.js'
import {
  allScenes,
  lcg,
  productionScenes,
  randomScenes,
  runScene,
  type Scene,
  type SceneRects,
} from './layoutScenes.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function firstDivergence(a: SceneRects[], b: SceneRects[]): string {
  for (let p = 0; p < Math.max(a.length, b.length); p++) {
    const pa = a[p] ?? {}
    const pb = b[p] ?? {}
    const paths = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()
    for (const path of paths) {
      const ra = JSON.stringify(pa[path])
      const rb = JSON.stringify(pb[path])
      if (ra !== rb) return `pass ${p} node ${path}: oracle=${ra} cell=${rb}`
    }
  }
  return ''
}

// Oracle: the live old engine while it exists; the frozen golden afterwards.
const YOGA_ADAPTER = join(import.meta.dir, '..', '..', 'src', 'ink', 'layout', 'yoga.ts')
const GOLDEN = join(import.meta.dir, 'goldens', 'layout-corpus.json')
const oracleLive = existsSync(YOGA_ADAPTER)

console.log(
  `bedrock layout differential — cell engine vs ${oracleLive ? 'LIVE old-engine oracle' : 'frozen golden'}`,
)

let mismatchScenes = 0
let comparedScenes = 0
const reportLimit = 6

async function compareScenes(scenes: Scene[], viaOracle: (s: Scene) => SceneRects[]) {
  for (const scene of scenes) {
    const oracle = viaOracle(scene)
    const cell = runScene(scene, createCellLayoutNode)
    comparedScenes++
    const d = firstDivergence(oracle, cell)
    if (d) {
      mismatchScenes++
      if (mismatchScenes <= reportLimit) console.log(`  [FAIL] ${scene.name}: ${d}`)
    }
  }
}

if (oracleLive) {
  const { createYogaLayoutNode } = await import('../../src/ink/layout/yoga.js')
  const oracleRun = (s: Scene) => runScene(s, createYogaLayoutNode as () => LayoutNode)
  await compareScenes(allScenes(), oracleRun)
  // The extended random space: 400 extra seeded scenes across three widths.
  await compareScenes(randomScenes(400, 0xce11).map(s => ({ ...s, name: `x${s.name}` })), oracleRun)
  // The production-shaped space: Box/Text web defaults, 600 scenes.
  await compareScenes(productionScenes(600), oracleRun)
} else {
  const golden: Record<string, SceneRects[]> = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  for (const scene of allScenes()) {
    const cell = runScene(scene, createCellLayoutNode)
    comparedScenes++
    const d = firstDivergence(golden[scene.name] ?? [], cell)
    if (d) {
      mismatchScenes++
      if (mismatchScenes <= reportLimit) console.log(`  [FAIL] ${scene.name}: ${d}`)
    }
  }
}
check(
  `all ${comparedScenes} scenes agree`,
  mismatchScenes === 0,
  `${mismatchScenes} scenes diverged`,
)

// -- §6 structural laws on the owned engine ---------------------------------

// Repeat-layout silence: second identical calculateLayout calls no measure fn.
{
  let calls = 0
  const root = createCellLayoutNode()
  root.setWidth(40)
  const t = createCellLayoutNode()
  t.setMeasureFunc((w, mode) => {
    calls++
    const n = 23
    if (mode === 'undefined' || !Number.isFinite(w) || w <= 0) return { width: n, height: 1 }
    const cw = Math.max(1, Math.floor(w))
    return { width: Math.min(n, cw), height: Math.max(1, Math.ceil(n / cw)) }
  })
  root.insertChild(t, 0)
  root.calculateLayout(40, undefined)
  const first = calls
  root.calculateLayout(40, undefined)
  check('repeat-layout silence: zero measure calls on unchanged relayout', calls === first, `${calls - first} extra calls`)
  check('repeat-layout produced a real first measure', first > 0)
}

// NaN before first layout.
{
  const n = createCellLayoutNode()
  check(
    'getComputed* are NaN before first calculateLayout',
    Number.isNaN(n.getComputedWidth()) && Number.isNaN(n.getComputedLeft()),
  )
}

// Relayout purity on the owned engine (content change → restore).
{
  const scene = allScenes().find(s => s.name === 'relayout-content-change')!
  const rects = runScene(scene, createCellLayoutNode)
  check(
    'relayout purity: content restored ⇒ rects restored (owned engine)',
    JSON.stringify(rects[0]) === JSON.stringify(rects[3]),
  )
}

// Determinism of the owned engine under a fresh RNG stream.
{
  const scenes = randomScenes(8, 0xd37e)
  for (const scene of scenes) {
    const a = runScene(scene, createCellLayoutNode)
    const b = runScene(scene, createCellLayoutNode)
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      check(`determinism: ${scene.name}`, false, firstDivergence(a, b))
    }
  }
}

// Seeded-random guard for lcg import usage (keeps the helper exercised).
void lcg

if (failures > 0) {
  console.log(`\nbedrock layout differential: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log(`\nbedrock layout differential: green (${comparedScenes} scenes)`)
