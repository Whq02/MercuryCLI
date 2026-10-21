import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as sdk from '../../sdk/src/index.ts'
import { connect, run, MercuryError, MercuryExitError, MercurySpawnError, MercuryUsageError } from '../../sdk/src/index.ts'
import { startFixtureServer } from '../../sdk/src/testing.ts'

const root = resolve(import.meta.dir, '../..')
const fake = (source: string) => ['node', '-e', source, '--']
const init = { protocol: 1, runner: { version: 'fixture', pid: 1 }, session_id: 's' }
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const failures: string[] = []
async function check(name: string, test: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const ceiling = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer within 20 s')), 20000) })
  try { await Promise.race([test(), ceiling]); console.log(`PASS ${name}`) } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error}`) } finally { clearTimeout(timer) }
}
const scratch = mkdtempSync(join(tmpdir(), 'sdk-lifecycle-'))
try {
  await check('a missing working directory is named, not blamed on the executable', async () => {
    const missing = join(scratch, 'no-such-dir')
    await assert.rejects(run({ mercury: fake('process.exit(0)'), cwd: missing, prompt: 'x' }).outcome, (e: unknown) => e instanceof MercurySpawnError && e.message.includes(`the working directory does not exist: ${missing}`))
    await assert.rejects(connect({ mercury: fake('process.exit(0)'), cwd: missing }), (e: unknown) => e instanceof MercurySpawnError && e.message.includes('the working directory does not exist'))
  })
  await check('an executable that is not there points at the install and the mercury option', async () => {
    await assert.rejects(run({ mercury: 'mercury-sdk-no-such-binary-proof', prompt: 'x' }).outcome, (e: unknown) => e instanceof MercurySpawnError && e.message.includes('https://mercury-cli.ai') && e.message.includes('mercury option'))
  })
  await check('the runner door classifies exits like the run door and says which door it was', async () => {
    await assert.rejects(connect({ mercury: fake("process.stderr.write(\"error: unknown option '--x'\\n\");process.exit(2)") }), (e: unknown) => e instanceof MercuryUsageError && e.door === 'runner' && e.message === "error: unknown option '--x'")
    await assert.rejects(connect({ mercury: fake("process.stderr.write('boot failure: cannot open the store\\n');process.exit(1)") }), (e: unknown) => e instanceof MercuryExitError && e.door === 'runner' && e.message === 'mercury runner exited 1 before the session was closed: boot failure: cannot open the store')
    const task = run({ mercury: fake('process.exit(3)'), prompt: 'x' })
    await assert.rejects(task.outcome, (e: unknown) => e instanceof MercuryExitError && e.door === 'run' && e.message === 'mercury run exited 3 before an outcome row')
    await task.exit
  })
  await check('MercuryRun.close() and await using end a streaming run', async () => {
    const fixture = await startFixtureServer({ rows: [], inputCount: 1 })
    try {
      const task = run({ mercury: fixture.mercury, input: 'rows' })
      await task.sendPrompt('one')
      await task.close()
      assert.equal(task.child.exitCode !== null || task.child.signalCode !== null, true)
      {
        await using disposable = run({ mercury: fixture.mercury, input: 'rows' })
        await disposable.sendPrompt('two')
      }
      assert.equal(fixture.received.length, 2)
    } finally { await fixture.close() }
  })
  await check('prompt() takes an AbortSignal: a timed-out wait releases the session for the next prompt', async () => {
    const session = await connect({ mercury: fake(`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:${JSON.stringify(init)}}));if(m.method==='queue/add')console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{accepted:true}}))})`) })
    try {
      await assert.rejects(session.prompt('never answered', { signal: AbortSignal.timeout(50) }), (e: unknown) => e instanceof MercuryError && e.message === 'prompt: cancelled')
      await assert.rejects(session.prompt('pre-aborted', { signal: AbortSignal.abort() }), (e: unknown) => e instanceof MercuryError && e.message === 'prompt: cancelled')
      const second = session.prompt('next', { signal: AbortSignal.timeout(50) })
      await assert.rejects(second, (e: unknown) => e instanceof MercuryError && e.message === 'prompt: cancelled')
    } finally { await session.close() }
  })
  await check('a host that exits terminates the children it still has', async () => {
    const host = join(scratch, 'host.mjs')
    writeFileSync(host, `import { run, connect } from ${JSON.stringify(join(root, 'sdk/src/index.ts'))}
const child = ['node', '-e', "process.stdin.resume();setInterval(()=>{},1000)", '--']
const task = run({ mercury: child, input: 'rows' })
const session = new (await import(${JSON.stringify(join(root, 'sdk/src/runner.ts'))})).MercurySession({ mercury: child })
console.log(task.child.pid, session.child.pid)
setTimeout(() => process.exit(0), 200)
`)
    const result = spawnSync('bun', [host], { encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 0, result.stderr)
    const pids = result.stdout.trim().split(/\s+/).map(Number)
    assert.equal(pids.length, 2)
    for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(50)
    assert.deepEqual(pids.filter(alive), [], 'children outlived the host')
  })
  await check('the package version is the manifest version', async () => {
    const pkg = JSON.parse(await Bun.file(join(root, 'sdk/package.json')).text())
    assert.equal(sdk.VERSION, pkg.version)
    const pyproject = await Bun.file(join(root, 'sdk-py/pyproject.toml')).text()
    assert(pyproject.includes(`version = "${sdk.VERSION}"`))
    assert((await Bun.file(join(root, 'sdk-py/src/mercury_cli_sdk/version.py')).text()).includes(`'${sdk.VERSION}'`))
  })
  const python = spawnSync('python3', [resolve(import.meta.dir, 'python-lifecycle.py')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: resolve(root, 'sdk-py/src') }, encoding: 'utf8', timeout: 60000 })
  console.log(python.stdout.trim()); if (python.status !== 0) { failures.push('Python lifecycle'); console.error(python.stderr) }
  await check('a Python consumer exits 0 with no fatal error: the fixture bridge with stdin still open, an unclosed sync session, an unclosed tool server', async () => {
    const consumer = spawnSync('python3', [resolve(import.meta.dir, 'python-clean-exit.py')], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: resolve(root, 'sdk-py/src') }, encoding: 'utf8', timeout: 60000 })
    assert.equal(consumer.signal, null, `the consumer died by ${consumer.signal}: ${consumer.stderr}`)
    assert(!/Fatal Python error/.test(consumer.stderr), `a Python process wrote a fatal error:\n${consumer.stderr}`)
    assert.equal(consumer.status, 0, consumer.stdout + consumer.stderr)
    assert(consumer.stdout.includes('consumer finished'), consumer.stdout)
  })
} finally { rmSync(scratch, { recursive: true, force: true }) }
assert.deepEqual(failures, [])
console.log('PASS SDK lifecycle: cwd and executable words, door-aware exits, run close and dispose, prompt signals, host-exit cleanup, clean Python exit, one version')
