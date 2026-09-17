import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-read-continuation')
const scratch = mkdtempSync(join(tmpdir(), 'read-continuation-'))
const cwd = join(scratch, 'work')
mkdirSync(cwd)
const hugeLine = join(cwd, 'wide.txt')
writeFileSync(hugeLine, 'first\n' + 'wide '.repeat(32_000) + '\nlast\n')
const notebook = join(cwd, 'wide.ipynb')
writeFileSync(
  notebook,
  JSON.stringify({
    cells: Array.from({ length: 40 }, (_, i) => ({ cell_type: 'code', source: [`cell_${i} = "${'x'.repeat(4_000)}"\n`], outputs: [], metadata: {} })),
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }),
)
const results: SeenResult[] = []
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== 'read continuation proof') return [{ type: 'text', text: 'ok' }]
  if (req.step > 0 && req.results[0]) results.push(req.results[0])
  if (req.step === 0) return [{ type: 'tool_use', name: 'Read', input: { file_path: hugeLine, offset: 2, limit: 1 } }]
  if (req.step === 1) return [{ type: 'tool_use', name: 'Read', input: { file_path: notebook } }]
  return [{ type: 'text', text: 'Continuation proof complete.' }]
})
let turn
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd, base: fixture.base, ask: 'read continuation proof', timeoutMs: 90_000, extraArgv: ['--dangerously-bypass-permissions'], extraEnv: { ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' } })
} finally {
  await fixture.close()
}
console.log(JSON.stringify({ dist: DIST, scratch, results, exitCode: turn.exitCode }, null, 2))
tally.check('the oversized single-line Read actually refuses', results[0]?.isError === true && /exceeds maximum allowed tokens/.test(results[0].text), results[0]?.text)
tally.check('the throw road names its bounded next window at the requested offset', results[0]?.text.includes('Read(offset: 2, limit: 1)') === true, results[0]?.text)
tally.check('the single-line limit explains why another Read cannot split it', results[0]?.text.includes('single line') === true && /search/.test(results[0].text), results[0]?.text)
tally.check('the oversized notebook Read actually refuses', results[1]?.isError === true && /exceeds maximum allowed tokens/.test(results[1].text), results[1]?.text)
tally.check('the notebook refusal claims no offset/limit window and names the cell-slice remedy', results[1] !== undefined && !/Read\(offset/.test(results[1].text) && !/[Uu]se offset and limit/.test(results[1].text) && results[1].text.includes("jq '.cells[:10]'"), results[1]?.text)
tally.finish()
