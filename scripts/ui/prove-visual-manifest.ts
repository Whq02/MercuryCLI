#!/usr/bin/env bun
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveExecutionProfile } from '../lib/executionProfile.ts'
import {
  LIVE_DIR, MANIFEST_PATH, gridDigest, readManifest, readStoredGrid, styleDigest,
} from './visualBaseline.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log(' Visual manifest — real-binary baseline self-consistency')

const manifest = readManifest()
check('manifest exists + parses', manifest !== null, MANIFEST_PATH + ' (readManifest in scripts/ui/visualBaseline.ts found no valid file there; regenerate it with scripts/ui/generate-visual-baseline.ts)')
if (manifest) {
  check('schema 1', manifest.schema === 1, `schema is ${manifest.schema} in ${MANIFEST_PATH} (regenerate with scripts/ui/generate-visual-baseline.ts)`)
  check('has entries', manifest.entries.length > 0, `${manifest.entries.length} (the manifest in design-system/live/manifest.json lists no entries; regenerate with scripts/ui/generate-visual-baseline.ts)`)
  check(
    'generator recorded',
    manifest.generator === 'scripts/ui/generate-visual-baseline.ts',
    `generator is ${JSON.stringify(manifest.generator)} in ${MANIFEST_PATH} (rewrite the manifest by running scripts/ui/generate-visual-baseline.ts instead of editing it by hand)`,
  )

  const ids = manifest.entries.map(e => e.id)
  check('ids unique', new Set(ids).size === ids.length, `two entries in ${MANIFEST_PATH} share an id (regenerate with scripts/ui/generate-visual-baseline.ts)`)
  check('ids sorted', ids.every((id, i) => i === 0 || ids[i - 1].localeCompare(id) <= 0), `entries in ${MANIFEST_PATH} are out of id order (regenerate with scripts/ui/generate-visual-baseline.ts)`)

  let sourceShaOk = false
  try {
    execSync(`git cat-file -e ${manifest.sourceSha}^{tree}`, {
      cwd: join(import.meta.dir, '..', '..'),
      stdio: 'pipe',
    })
    sourceShaOk = true
  } catch {
    sourceShaOk = false
  }
  const wellFormedSha = /^[0-9a-f]{40}$/.test(manifest.sourceSha)
  const profile = resolveExecutionProfile(join(import.meta.dir, '..', '..'))
  if (!sourceShaOk && wellFormedSha && profile.kind === 'hosted-gate') {
    console.log(`  - sourceSha ${manifest.sourceSha} is a tree id this checkout's history does not hold (the hosted gate runs the published tree, whose history is rewritten); the tree check runs where the source history lives`)
  } else {
    check('sourceSha is a real source tree of this repo', sourceShaOk, manifest.sourceSha + ' (git cannot find this tree in this repo; regenerate the baseline with scripts/ui/generate-visual-baseline.ts from a checkout that holds the source history)')
  }

  const REQUIRED: Array<keyof (typeof manifest.entries)[number]> = [
    'id', 'sourceSha', 'buildDigest', 'scenario', 'cols', 'rows', 'theme',
    'colorMode', 'motion', 'mouse', 'stateFixture', 'terminalProfile',
    'gridPath', 'gridDigest', 'styleDigest', 'masks',
  ]
  let shapeBad = 0
  let pathBad = 0
  let digestBad = 0
  let geometryBad = 0
  for (const e of manifest.entries) {
    if (REQUIRED.some(k => e[k] === undefined || e[k] === '')) {
      shapeBad++
      continue
    }
    if (!e.gridPath.startsWith('grids/') || e.gridPath.includes('..')) {
      pathBad++
      continue
    }
    if (!existsSync(join(LIVE_DIR, e.gridPath))) {
      pathBad++
      console.log(`    missing grid: ${e.gridPath}`)
      continue
    }
    const grid = readStoredGrid(e)
    if (grid.cols !== e.cols || grid.rows !== e.rows || grid.text.length !== e.rows) {
      geometryBad++
      console.log(`    geometry drift: ${e.id} grid=${grid.cols}x${grid.rows}`)
      continue
    }
    if (gridDigest(grid, e.masks) !== e.gridDigest || styleDigest(grid, e.masks) !== e.styleDigest) {
      digestBad++
      console.log(`    digest mismatch: ${e.id}`)
    }
  }
  check('every entry carries the full shape', shapeBad === 0, `${shapeBad} short (an entry in ${MANIFEST_PATH} lacks a required field; regenerate with scripts/ui/generate-visual-baseline.ts)`)
  check('every gridPath is present + confined', pathBad === 0, `${pathBad} bad (see the missing grid lines above; grid files live under design-system/live/grids, regenerate with scripts/ui/generate-visual-baseline.ts)`)
  check('every grid matches its recorded geometry', geometryBad === 0, `${geometryBad} drifted (see the geometry drift lines above; regenerate with scripts/ui/generate-visual-baseline.ts)`)
  check('every grid re-digests to its manifest record', digestBad === 0, `${digestBad} mismatched (see the digest mismatch lines above; a grid under design-system/live/grids changed without its manifest record, regenerate with scripts/ui/generate-visual-baseline.ts)`)
}

{
  const { readdirSync, statSync, readFileSync: rf } = await import('node:fs')
  const ROOT = join(import.meta.dir, '..', '..')
  const activeDocs: string[] = ['design-system/readme.md']
  const addDir = (rel: string, filter: (n: string) => boolean): void => {
    try {
      for (const n of readdirSync(join(ROOT, rel))) {
        const p = join(ROOT, rel, n)
        if (statSync(p).isDirectory()) addDir(join(rel, n), filter)
        else if (filter(n)) activeDocs.push(join(rel, n))
      }
    } catch {
    }
  }
  const stale: string[] = []
  for (const doc of activeDocs) {
    let text = ''
    try {
      text = rf(join(ROOT, doc), 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/design-system\/guidelines\/([A-Za-z0-9._-]+\.(?:html|md))/g)) {
      if (!existsSync(join(ROOT, 'design-system', 'guidelines', m[1]))) {
        stale.push(`${doc} → ${m[0]}`)
      }
    }
  }
  check('no active doc points at an archived/missing guideline card', stale.length === 0, stale.join('; ') + ' (point each listed doc at a design-system/guidelines card that exists, or remove the link)')
}

if (failures > 0) {
  console.log(`\n❌ visual manifest — ${failures} failed`)
  process.exit(1)
}
console.log('\n✅ visual manifest self-consistent')
