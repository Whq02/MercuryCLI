import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ROOT, argument, git, scratch } from './support.ts'

type Family = { id: string; paths: string[]; script: string; args: string[]; output: (path: string, dir: string) => Buffer }
const tracked = git('ls-files', '-z').split('\0').filter(Boolean)
const historical = new Set<string>()
const historicalLines = readFileSync(join(import.meta.dir, 'frames-historical.tsv'), 'utf8').trimEnd().split('\n')
assert.equal(historicalLines.shift(), 'path\tprover\tdeclaration\tcaller')
for (const line of historicalLines) {
  const [path, prover, declaration, caller, extra] = line.split('\t')
  assert.ok(path && prover && declaration && caller && extra === undefined, `incomplete historical record: ${line}`)
  assert.ok(tracked.includes(path) && tracked.includes(prover), `untracked historical frame or prover: ${path}`)
  assert.ok(!historical.has(path), `duplicate historical frame: ${path}`)
  assert.ok(/historical|BEFORE|poison control/.test(declaration), `no historical declaration: ${path}`)
  const source = readFileSync(join(ROOT, prover), 'utf8')
  assert.ok(source.includes(declaration) && source.includes(caller), `historical declaration moved: ${path}`)
  const named = source.includes(path) || (path.startsWith('scripts/visual-contract/baselines/') && source.includes('scripts/visual-contract/baselines/'))
  assert.ok(named, `prover does not name historical frame: ${path}`)
  historical.add(path)
}
assert.deepEqual(tracked.filter(path => path.startsWith('scripts/visual-contract/baselines/') && path.endsWith('.json') && !historical.has(path)), [], 'unclassified historical captures')
console.log(`HISTORICAL FRAMES (${historical.size}; declarations verified, never regenerated)`)
for (const path of historical) console.log(`[HISTORICAL] ${path}`)
const currentFrames = tracked.filter(path => !historical.has(path)).filter(path =>
  /^design-system\/live\/grids\/.*\.json$/.test(path) ||
  /^scripts\/ui\/fixtures\/[^/]+\/.*\.txt$/.test(path) ||
  /^scripts\/engine-connector\/fixtures\/crew-tokens\/.*\.txt$/.test(path) ||
  /(?:^|\/)\S+-frames(?:-[^/]+)?\.json$/.test(path),
)
const allowed = new Map<string, string>()
const lines = readFileSync(join(import.meta.dir, 'frames-moved.tsv'), 'utf8').trimEnd().split('\n')
assert.equal(lines.shift(), 'path\tbug\tlane\tcommit')
for (const line of lines) {
  const [path, bug, lane, commit, extra] = line.split('\t')
  assert.ok(path && bug && lane && commit && extra === undefined, `incomplete movement record: ${line}`)
  assert.ok(currentFrames.includes(path), `unknown frame in movement record: ${path}`)
  assert.ok(!allowed.has(path), `duplicate movement record: ${path}`)
  assert.ok(!/[?*{}]/.test(path), 'movement records name individual files, never globs')
  allowed.set(path, `${bug} (${lane}, ${commit})`)
}
const work = argument('--work-dir') ?? scratch('engine-frames-')
mkdirSync(work, { recursive: true })
const families: Family[] = []
const file = (path: string, dir: string): Buffer => readFileSync(join(dir, basename(path)))
for (const [id, path] of [
  ['face-doors', 'scripts/ui/fixtures/face-doors/'], ['face-logins', 'scripts/ui/fixtures/face-logins/'],
  ['kit-menu', 'scripts/ui/fixtures/kit-menu/'], ['motion-menu', 'scripts/ui/fixtures/motion-menu/'],
  ['saturn-screen', 'scripts/ui/fixtures/saturn-screen/'],
]) {
  families.push({ id: id!, paths: currentFrames.filter(name => name.startsWith(path!)), script: 'scripts/engine-pass/render-stills.ts', args: [id!, '$OUT'], output: file })
}
families.push(
  { id: 'agent-face', paths: currentFrames.filter(path => path.startsWith('scripts/ui/fixtures/agent-face/')), script: 'scripts/ui/agent-face-stills.ts', args: ['--frames', '$OUT'], output: file },
  { id: 'crew-tokens', paths: currentFrames.filter(path => path.startsWith('scripts/engine-connector/fixtures/crew-tokens/')), script: 'scripts/engine-connector/prove-crew-token-rows.ts', args: ['--frames', '$OUT'], output: file },
  { id: 'settings-popup-header', paths: currentFrames.filter(path => path.startsWith('scripts/ui/fixtures/settings-popup-header/')), script: 'scripts/ui/prove-settings-popup-header.ts', args: ['--frames', '$OUT'], output: file },
  { id: 'live-grids', paths: currentFrames.filter(path => path.startsWith('design-system/live/grids/')), script: 'scripts/ui/generate-visual-baseline.ts', args: ['--out', '$OUT', '--jobs', '1'], output: (path, dir) => readFileSync(join(dir, 'grids', basename(path))) },
  { id: 'crew-screens', paths: currentFrames.filter(path => /crew-screens-frames-/.test(path)), script: 'scripts/ui/prove-crew-screens-unchanged.ts', args: ['--frames', '$OUT', '--jobs', '1'], output: (path, dir) => {
    const size = /frames-(.*)\.json$/.exec(path)![1]!
    const stored = JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, string[]>
    const frames = Object.fromEntries(Object.keys(stored).map(name => [name, readFileSync(join(dir, 'after', `${name}-${size}.txt`), 'utf8').trimEnd().split('\n')]))
    return Buffer.from(JSON.stringify(frames, null, 1) + '\n')
  } },
)
const covered = families.flatMap(family => family.paths)
assert.equal(new Set(covered).size, covered.length, 'a frame has more than one writer')
assert.deepEqual(currentFrames.filter(path => !covered.includes(path)), [], 'a stored frame has no writer road')
const fixtureJson = tracked.filter(path => /^scripts\/[^/]+\/fixtures\/.*\.json$/.test(path))
for (const path of fixtureJson) {
  if (currentFrames.includes(path) || historical.has(path)) continue
  const value = JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
  const isGrid = value && typeof value === 'object' && (Array.isArray(value.grid) || Array.isArray(value.frames) || (Array.isArray(value.text) && Array.isArray(value.styles)))
  assert.ok(!isGrid, `unregistered frame-shaped fixture: ${path}`)
}
if (argument('--only') === 'historical') {
  console.log(`[PASS] ${historical.size} historical declarations verified; current-frame renders not run`)
  process.exit(0)
}
const hashes = new Map([...currentFrames, ...historical].map(path => [path, createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')]))
const only = argument('--only')
const selected = families.filter(family => only === undefined || only.split(',').includes(family.id))
assert.ok(selected.length, 'no frame family selected')
let failures = 0
const results: Array<{ path: string; same: boolean; allowed: string | null; error?: string }> = []
for (const family of selected) {
  assert.ok(family.paths.length, `empty frame family: ${family.id}`)
  const dir = join(work, family.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const run = spawnSync(process.execPath, [join(ROOT, family.script), ...family.args.map(arg => arg === '$OUT' ? dir : arg)], {
    cwd: ROOT, env: process.env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 900_000,
  })
  writeFileSync(join(work, `${family.id}.log`), run.stdout + '\n' + run.stderr)
  if (run.status !== 0) {
    failures++
    console.log(`[FAIL] ${family.id} writer exit ${run.status}; ${join(work, `${family.id}.log`)}`)
  }
  for (const path of family.paths) {
    try {
      const actual = family.output(path, dir)
      const expected = readFileSync(join(ROOT, path))
      const same = actual.equals(expected)
      const movement = allowed.get(path) ?? null
      results.push({ path, same, allowed: movement })
      if (!same && movement === null) failures++
      let first = 0
      while (first < Math.min(actual.length, expected.length) && actual[first] === expected[first]) first++
      console.log(`[${same ? 'PASS' : movement ? 'NAMED' : 'FAIL'}] ${path}${same ? '' : movement ? ` — ${movement}` : ` — first changed byte ${first}; ${expected.length} -> ${actual.length} bytes`}`)
    } catch (error) {
      failures++
      results.push({ path, same: false, allowed: allowed.get(path) ?? null, error: String(error) })
      console.log(`[FAIL] ${path} — ${String(error)}`)
    }
  }
}
for (const [path, digest] of hashes) assert.equal(createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'), digest, `writer modified committed frame: ${path}`)
writeFileSync(join(work, 'frames.json'), JSON.stringify({ complete: only === undefined, checked: results.length, currentFrames: currentFrames.length, historical: tracked.filter(path => path.startsWith('scripts/visual-contract/baselines/')), results, failures }, null, 2) + '\n')
console.log(`[${failures ? 'FAIL' : 'PASS'}] frame identity: ${results.length}/${currentFrames.length} frames re-rendered, ${failures} failures; stored bytes untouched; receipts ${work}`)
process.exit(failures ? 1 : 0)
