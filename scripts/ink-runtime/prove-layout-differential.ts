#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCellLayoutNode } from '../../src/screen/renderer/layout/cellLayout.js'
import type { LayoutNode } from '../../src/screen/renderer/layout/node.js'
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

const YOGA_ADAPTER = join(import.meta.dir, '..', '..', 'src', 'screen', 'renderer', 'layout', 'yoga.ts')
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
  const { createYogaLayoutNode } = await import('../../src/screen/renderer/layout/yoga.js')
  const oracleRun = (s: Scene) => runScene(s, createYogaLayoutNode as () => LayoutNode)
  await compareScenes(allScenes(), oracleRun)
  await compareScenes(randomScenes(400, 0xce11).map(s => ({ ...s, name: `x${s.name}` })), oracleRun)
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
  `${mismatchScenes} scenes diverged; the first divergences are printed above, fix the cell engine in src/screen/renderer/layout/cellLayout.ts (calculateLayout) until its rects match the oracle or goldens/layout-corpus.json`,
)


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
  check('repeat-layout silence: zero measure calls on unchanged relayout', calls === first, `${calls - first} extra calls; calculateLayout in src/screen/renderer/layout/cellLayout.ts must not re-run setMeasureFunc callbacks on a clean node`)
  check('repeat-layout produced a real first measure', first > 0, 'the first calculateLayout in src/screen/renderer/layout/cellLayout.ts never called the measure function set with setMeasureFunc')
}

{
  const n = createCellLayoutNode()
  check(
    'getComputed* are NaN before first calculateLayout',
    Number.isNaN(n.getComputedWidth()) && Number.isNaN(n.getComputedLeft()),
    'getComputedWidth and getComputedLeft in src/screen/renderer/layout/cellLayout.ts must return NaN until calculateLayout has run'
  )
}

{
  const scene = allScenes().find(s => s.name === 'relayout-content-change')!
  const rects = runScene(scene, createCellLayoutNode)
  check(
    'relayout purity: content restored ⇒ rects restored (owned engine)',
    JSON.stringify(rects[0]) === JSON.stringify(rects[3]),
    'pass 3 of scene relayout-content-change differs from pass 0; calculateLayout in src/screen/renderer/layout/cellLayout.ts keeps state from the changed content'
  )
}

{
  const scenes = randomScenes(8, 0xd37e)
  for (const scene of scenes) {
    const a = runScene(scene, createCellLayoutNode)
    const b = runScene(scene, createCellLayoutNode)
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      check(`determinism: ${scene.name}`, false, `${firstDivergence(a, b)}; two runs of one scene gave different rects, so calculateLayout in src/screen/renderer/layout/cellLayout.ts depends on state outside the tree`)
    }
  }
}

void lcg

if (failures > 0) {
  console.log(`\nbedrock layout differential: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log(`\nbedrock layout differential: green (${comparedScenes} scenes)`)
