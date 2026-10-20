import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { runEngineCommand, resolveShellEngine, resetEngineSessionForTest } = await import('../../src/utils/shell/engineSession.ts')
const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
const { generateTaskId } = await import('../../src/Task.ts')
const engine = resolveShellEngine('brush')
assert.equal(engine.engine, 'brush', 'the proof requires the bundled persistent shell engine')
if (engine.engine !== 'brush') throw new Error(engine.reason)
let checks = 0
const check = (name: string, value: unknown) => { assert.ok(value, name); checks++; console.log('PASS ' + name) }
const outputs: InstanceType<typeof TaskOutput>[] = []
const controller = new AbortController()
try {
  const command = runEngineCommand(engine.binaryPath, "export QC_LIVE_MARK=kept; printf 'live-first\\n'; sleep 3; printf 'live-last\\n'", { signal: controller.signal, timeout: 10000, cwd: process.cwd() })
  outputs.push(command.taskOutput)
  const deadline = Date.now() + 2500
  let live = ''
  while (Date.now() < deadline) {
    if (existsSync(command.taskOutput.path)) live = readFileSync(command.taskOutput.path, 'utf8')
    if (live.includes('live-first')) break
    await delay(25)
  }
  check('persistent engine output reaches the live tail file before command exit', command.status === 'running' && live.includes('live-first') && !live.includes('live-last'))
  const result = await command.result
  check('live disk visibility does not mark a small result truncated or change its bytes', result.code === 0 && result.stdout === 'live-first\nlive-last\n' && !command.taskOutput.isOverflowed)
  const stderrCommand = runEngineCommand(engine.binaryPath, `node -e "process.stderr.write('live-error\\\\n'); setTimeout(() => process.stdout.write('error-done\\\\n'), 3000)"`, { signal: controller.signal, timeout: 10000, cwd: process.cwd() })
  outputs.push(stderrCommand.taskOutput)
  const stderrDeadline = Date.now() + 2500
  let stderrLive = ''
  while (Date.now() < stderrDeadline) {
    if (existsSync(stderrCommand.taskOutput.path)) stderrLive = readFileSync(stderrCommand.taskOutput.path, 'utf8')
    if (stderrLive.includes('live-error')) break
    await delay(25)
  }
  check('external stderr is visible while the persistent engine command runs', stderrCommand.status === 'running' && stderrLive.includes('live-error') && !stderrLive.includes('error-done'))
  check('stdout and external stderr settle once in observed order', (await stderrCommand.result).stdout === 'live-error\nerror-done\n')
  const next = runEngineCommand(engine.binaryPath, "printf '%s' \"$QC_LIVE_MARK\"", { signal: controller.signal, timeout: 10000, cwd: process.cwd() })
  outputs.push(next.taskOutput)
  check('live capture retains the persistent engine session state', (await next.result).stdout === 'kept')
  const small = new TaskOutput(generateTaskId('local_bash'), null, false)
  outputs.push(small)
  small.writeStdout('before\n'); small.mirrorToDisk(); small.mirrorToDisk(); small.writeStdout('after\n'); small.writeStderr('warning\n')
  await small.flush()
  check('mirroring starts with prior output and stays idempotent', readFileSync(small.path, 'utf8') === 'before\nafter\n[stderr] warning\n')
  check('mirroring preserves small stdout and stderr result channels', await small.getStdout() === 'before\nafter\n' && small.getStderr() === 'warning\n' && !small.isOverflowed)
  const spill = new TaskOutput(generateTaskId('local_bash'), null, false, 32)
  outputs.push(spill)
  spill.mirrorToDisk(); spill.writeStdout('first\n'); spill.writeStderr('error\n'); spill.writeStdout('x'.repeat(40) + '\n'); spill.writeStdout('last\n'); await spill.flush()
  check('crossing the original spill budget duplicates no mirrored bytes', spill.isOverflowed && readFileSync(spill.path, 'utf8') === 'first\n[stderr] error\n' + 'x'.repeat(40) + '\nlast\n')
  check('spill still names its complete artifact', (await spill.getStdout()).includes(spill.path))
  const ordinary = new TaskOutput(generateTaskId('local_bash'), null, false)
  outputs.push(ordinary); ordinary.writeStdout('ordinary\n'); await ordinary.flush()
  check('an ordinary small pipe capture remains memory-only', !existsSync(ordinary.path) && await ordinary.getStdout() === 'ordinary\n')
  console.log('ENGINE LIVE OUTPUT GREEN — ' + checks + ' checks')
} finally {
  controller.abort()
  await resetEngineSessionForTest()
  for (const output of outputs) { await output.flush(); output.clear(); await output.deleteOutputFile() }
}
