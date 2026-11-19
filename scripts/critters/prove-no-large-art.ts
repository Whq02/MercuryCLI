import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CRITTERS, critterDefForKey } from '../../src/utils/cockpit/critterData.js'

const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
let failures = 0
const check = (label: string, okay: boolean): void => {
  console.log(`${okay ? 'PASS' : 'FAIL'} ${label}`)
  if (!okay) failures++
}
const snapshot = JSON.parse(read('scripts/critters/fixtures/retained-critter-grids.json')) as {
  base: string
  critters: Array<{ name: string; mini: string[]; squareDock: string[]; sleep: unknown }>
  dockPainterSha256: string
  dockEyeProofSha256: string
}
check('the retained-grid fixture names the verified base', snapshot.base === '5f210214fa7eddf68146fdbdeb9fefdf8ee15e96')
check('the retained-grid roster is complete', JSON.stringify(CRITTERS.map(d => d.name)) === JSON.stringify(snapshot.critters.map(d => d.name)))
for (const before of snapshot.critters) {
  const def = critterDefForKey(before.name)
  check(`${before.name}: dock unchanged cell for cell`, JSON.stringify(def.squareDock) === JSON.stringify(before.squareDock))
  check(`${before.name}: mini and its sleep pose unchanged cell for cell`, JSON.stringify(def.mini) === JSON.stringify(before.mini) && JSON.stringify(def.sleep.mini) === JSON.stringify(before.sleep))
}
const scratch = mkdtempSync(join(tmpdir(), 'critter-fixture-recording-'))
try {
  const out = join(scratch, 'frames.json')
  const kept = ['mini', 'square'].map(form => ({ form, grid: ['historical-cells'], marker: 'keep historical provenance' }))
  const existing = { base: 'historical-base', frames: [...kept, { form: 'unknown-fixture-form', grid: ['discard'] }] }
  writeFileSync(out, JSON.stringify(existing))
  execFileSync(process.execPath, [join(root, 'scripts/critters/gen-zzz-frames.ts'), root, out], { cwd: root, env: process.env, stdio: 'pipe', windowsHide: true })
  check('the recorder prunes unknown forms without recomposing surviving rows or provenance',
    JSON.stringify(JSON.parse(readFileSync(out, 'utf8'))) === JSON.stringify({ ...existing, frames: kept }))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`NO-LARGE-ART ${failures === 0 ? 'GREEN' : 'RED'} — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
