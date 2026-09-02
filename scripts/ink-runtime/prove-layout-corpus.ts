#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLayoutNode } from '../../src/ink/layout/engine.js'
import { allScenes, runScene, type SceneRects } from './layoutScenes.js'

const GOLDEN = join(import.meta.dir, 'goldens', 'layout-corpus.json')
const record = process.argv.includes('--record')

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
    const paths = new Set([...Object.keys(pa), ...Object.keys(pb)])
    for (const path of paths) {
      const ra = JSON.stringify(pa[path])
      const rb = JSON.stringify(pb[path])
      if (ra !== rb) return `pass ${p} node ${path}: ${ra} vs ${rb}`
    }
  }
  return ''
}

console.log('bedrock layout corpus — the production engine oracle')
const scenes = allScenes()
const results: Record<string, SceneRects[]> = {}

for (const scene of scenes) {
  const run1 = runScene(scene, createLayoutNode)
  const run2 = runScene(scene, createLayoutNode)
  check(
    `determinism: ${scene.name}`,
    JSON.stringify(run1) === JSON.stringify(run2),
    firstDivergence(run1, run2),
  )
  results[scene.name] = run1
}

{
  const rc = results['relayout-content-change']
  check('relayout purity: content restored ⇒ rects restored',
    rc !== undefined && JSON.stringify(rc[0]) === JSON.stringify(rc[3]),
    rc ? firstDivergence([rc[0]!], [rc[3]!]) : 'scene missing')
}

console.log(`  ${scenes.length} scenes exercised`)

if (record) {
  writeFileSync(GOLDEN, JSON.stringify(results, null, 1) + '\n')
  console.log(`  recorded → ${GOLDEN}`)
} else {
  check('golden exists (run --record once)', existsSync(GOLDEN))
  if (existsSync(GOLDEN)) {
    const golden: Record<string, SceneRects[]> = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    const goldenNames = Object.keys(golden)
    const liveNames = Object.keys(results)
    check(
      `scene inventory matches (${goldenNames.length} recorded)`,
      JSON.stringify(goldenNames.sort()) === JSON.stringify([...liveNames].sort()),
      'corpus drift — regenerate deliberately with --record',
    )
    let mismatches = 0
    for (const name of goldenNames) {
      if (!results[name]) continue
      const d = firstDivergence(golden[name]!, results[name]!)
      if (d) {
        mismatches++
        if (mismatches <= 5) console.log(`  [FAIL] ${name}: ${d}`)
      }
    }
    check(`all scene rectangles match the golden`, mismatches === 0, `${mismatches} scenes diverged`)
  }
}

if (failures > 0) {
  console.log(`\nbedrock layout corpus: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock layout corpus: green')
