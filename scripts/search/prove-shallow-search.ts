import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-shallow-search')
const scratch = mkdtempSync(join(tmpdir(), 'shallow-search-'))
const work = join(scratch, 'work')
mkdirSync(work)
writeFileSync(join(work, 'target.txt'), 'needle\n')
let files = 1
for (let branch = 0; branch < 8; branch++) {
  let dir = join(work, `branch-${branch}`)
  mkdirSync(dir)
  for (let depth = 0; depth < 12; depth++) {
    dir = join(dir, `level-${depth}`)
    mkdirSync(dir)
    writeFileSync(join(dir, 'target.txt'), 'needle\n')
    files++
    for (let n = 0; n < 250; n++) {
      writeFileSync(join(dir, `padding-${n}.dat`), 'padding\n')
      files++
    }
  }
}
const results: SeenResult[] = []
const walls: number[] = []
const operations = [
  { name: 'Glob', input: { pattern: 'target.txt', path: work } },
  { name: 'Grep', input: { pattern: 'needle', glob: '/target.txt', path: work, head_limit: 0 } },
  { name: 'Grep', input: { pattern: 'needle', glob: 'target.txt', path: work, head_limit: 0 } },
  { name: 'Grep', input: { pattern: 'needle', glob: '**/target.txt', path: work, head_limit: 0 } },
  { name: 'Glob', input: { pattern: 'branch-0/level-0/target.txt', path: work } },
]
let started = 0
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== 'shallow search proof') return [{ type: 'text', text: 'ok' }]
  if (req.step > 0) {
    walls.push(performance.now() - started)
    if (req.results[0]) results.push(req.results[0])
  }
  const operation = operations[req.step]
  if (operation === undefined) return [{ type: 'text', text: 'Search proof complete.' }]
  started = performance.now()
  return [{ type: 'tool_use', ...operation }]
})
let turn
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: 'shallow search proof', timeoutMs: 120_000, extraArgv: ['--dangerously-bypass-permissions'], extraEnv: { ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' } })
} finally {
  await fixture.close()
}
const paths = (result: SeenResult | undefined): string[] => (result?.text ?? '').split('\n').filter(line => line.endsWith('target.txt'))
console.log(JSON.stringify({ dist: DIST, scratch, files, depth: 13, walls, results, exitCode: turn.exitCode }, null, 2))
tally.check('the fixture contains more than twenty thousand files at depth thirteen', files > 20_000)
tally.check('the built product completed all five searches', results.length === 5 && turn.result?.is_error === false, turn.stderr)
tally.check('Glob: a bare filename returns only the root file', paths(results[0]).length === 1 && !paths(results[0])[0]?.includes('branch-'), results[0]?.text.slice(0, 1000))
tally.check('Glob: the shallow search completed without a cut-off', results[0]?.isError === false && !/INCOMPLETE SEARCH|truncated/.test(results[0]?.text ?? ''))
tally.check('Grep: a root-anchored glob returns only the root file', paths(results[1]).length === 1 && !paths(results[1])[0]?.includes('branch-'), results[1]?.text.slice(0, 1000))
tally.check('Grep: the anchored search completed without a cut-off', results[1]?.isError === false && !/INCOMPLETE SEARCH|truncated/.test(results[1]?.text ?? ''))
tally.check('Grep: a separator-free glob keeps its any-depth reach', results[2]?.isError === false && paths(results[2]).length === 97, `${paths(results[2]).length} paths`)
tally.check('an explicit recursive glob still searches every depth', results[3]?.isError === false && paths(results[3]).length === 97, `${paths(results[3]).length} paths`)
tally.check('a finite path pattern still reaches its stated depth', results[4]?.isError === false && paths(results[4]).length === 1 && paths(results[4])[0]?.includes('branch-0/level-0/target.txt') === true)
tally.finish()
