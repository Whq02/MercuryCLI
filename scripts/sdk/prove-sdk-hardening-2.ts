import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect, MercuryExitError, rowOf, run } from '../../sdk/src/index.ts'
import { fixtureOutcomeRow, fixtureSessionRow, fixtureTurn } from '../../sdk/src/testing.ts'
import { PYTHON } from './runtime.ts'

const root = resolve(import.meta.dir, '../..')
const scratch = mkdtempSync(join(tmpdir(), 'sdk-hardening-2-'))
const fixture = join(scratch, 'mercury.mjs')
const text = { type: 'text', seq: 2, timestamp: '2000-01-01T00:00:00.000Z', session_id: 'fixture-session', message_id: 'fixture-message', block: 0, text: 'A whole text row.' }
assert(rowOf(text).ok, 'the fixture text row is a valid row')
const [turn, outcome] = fixtureTurn({ answer: 'ok' })
writeFileSync(fixture, `import { createInterface } from 'node:readline'
import { writeSync } from 'node:fs'
const scenario = process.argv[2]
const session = ${JSON.stringify(fixtureSessionRow())}
const text = ${JSON.stringify(text)}
const turn = ${JSON.stringify({ ...turn, state: 'started' })}
const outcome = ${JSON.stringify(fixtureOutcomeRow({ answer: 'ok' }))}
const turnOutcome = ${JSON.stringify(outcome)}
const line = value => writeSync(1, JSON.stringify(value) + '\\n')
const die = () => process.kill(process.pid, 'SIGKILL')
if (scenario === 'cut-run') { line(session); writeSync(1, JSON.stringify(text).slice(0, 40)); die() }
else if (scenario === 'whole-run') { line(session); writeSync(1, JSON.stringify(outcome)) }
else if (scenario === 'late-run') setTimeout(() => { line(session); setTimeout(() => line(outcome), 300) }, 300)
else if (scenario === 'hang-run') { process.stderr.write('up\\n'); line(session); setInterval(() => {}, 1000) }
else if (scenario === 'text-run') { line(session); line(text); line(outcome) }
else if (scenario === 'stderr-run') { process.stderr.write('a warning line\\n'); line(session); line(outcome) }
else createInterface({ input: process.stdin }).on('line', raw => {
  const message = JSON.parse(raw)
  const reply = result => line({ jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') reply({ protocol: 1, runner: { version: '1.0.11', pid: process.pid }, session_id: 'fixture-session' })
  else if (message.method === 'session/facts') { writeSync(1, '{"jsonrpc":"2.0","method":"row","params":{"type":"te'); die() }
  else if (message.method === 'queue/add') {
    reply({ accepted: true })
    line({ jsonrpc: '2.0', method: 'row', params: { ...turn, message_ids: [message.params.id] } })
    line({ jsonrpc: '2.0', method: 'row', params: turnOutcome })
  }
}).on('close', () => process.exit(0))
`)
const mercury = (scenario: string) => ['node', fixture, scenario]
const windows = process.platform === 'win32'
const failures: string[] = []
const check = async (name: string, body: () => Promise<void>): Promise<void> => {
  try { await body(); console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}\n${error instanceof Error ? error.stack : String(error)}`) }
}
const cutExit = (door: 'run' | 'runner') => (error: unknown): boolean => error instanceof MercuryExitError && error.door === door && error.message.endsWith('the last stdout line was cut off') && (windows || error.exit?.signal === 'SIGKILL')
const guard = setTimeout(() => { console.error('FAIL the second hardening proof timed out'); process.exit(1) }, 150000)
try {
  await check('a run whose process is killed mid-row rejects with its exit, not a wire error, and a whole last row without a newline is still read', async () => {
    const cut = run({ mercury: mercury('cut-run'), prompt: 'x' })
    const seen: string[] = []
    await assert.rejects((async () => { for await (const row of cut) seen.push(row.type) })(), cutExit('run'))
    await assert.rejects(cut.outcome, cutExit('run'))
    assert.deepEqual(seen, ['session'])
    assert.equal((await run({ mercury: mercury('whole-run'), prompt: 'x' }).outcome).answer, 'ok')
  })
  await check('a session whose runner is killed mid-row rejects its requests with the exit, not a wire error', async () => {
    const session = await connect({ mercury: mercury('cut-runner') })
    try { await assert.rejects(session.facts(), cutExit('runner')) } finally { await session.close() }
  })
  const py = spawnSync(PYTHON, [join(root, 'scripts/sdk/python-hardening-2.py'), fixture], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(root, 'sdk-py/src') }, encoding: 'utf8', timeout: 120000 })
  process.stdout.write(py.stdout)
  process.stderr.write(py.stderr)
  if (py.status !== 0) failures.push(`python-hardening-2.py exited ${py.status ?? py.signal}${py.error ? `: ${py.error.message}` : ''}`)
  if (/never retrieved|Task was destroyed|was never awaited/.test(py.stderr)) failures.push('python-hardening-2.py left an unretrieved exception or an unawaited task')
} finally { clearTimeout(guard); rmSync(scratch, { recursive: true, force: true }) }
assert.deepEqual(failures, [])
