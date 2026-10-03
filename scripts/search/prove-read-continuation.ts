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
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd, base: fixture.base, ask: 'read continuation proof', timeoutMs: 90_000, extraArgv: ['--sovereign'], extraEnv: { ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' } })
} finally {
  await fixture.close()
}
console.log(JSON.stringify({ dist: DIST, scratch, results, exitCode: turn.exitCode }, null, 2))
const wideLine = results[0]?.text.split('\n')[0] ?? ''
tally.check('the oversized single-line Read is read, not refused: the one requested line comes back numbered', results[0]?.isError === false && wideLine.startsWith('2\twide wide '), results[0]?.text.slice(0, 200))
tally.check('the line is clipped at the display bound and the mark counts every character it cut', wideLine.length <= 2050 && wideLine.endsWith('… [truncated 158000 characters]'), wideLine.slice(-120))
tally.check('the clipped read keeps its source anchor for the window', /\(anchor: ra:[0-9a-f]+:L2\+1\)/.test(results[0]?.text ?? ''), results[0]?.text.slice(-400))
tally.check('the oversized notebook Read actually refuses', results[1]?.isError === true && /exceeds maximum allowed tokens/.test(results[1].text), results[1]?.text)
tally.check('the notebook refusal claims no offset/limit window and names the cell-slice remedy', results[1] !== undefined && !/Read\(offset/.test(results[1].text) && !/[Uu]se offset and limit/.test(results[1].text) && results[1].text.includes("jq '.cells[:10]'"), results[1]?.text)
tally.finish()
