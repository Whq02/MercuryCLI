import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_WINDOWS_SHELL_ROAD = 'no-bash'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { runEngineCommand, resolveShellEngine, resetEngineSessionForTest } = await import('../../src/platform/shell/engineSession.ts')
const { exec } = await import('../../src/platform/shell/shellExec.ts')
const { mapResultToBlock } = await import('../../src/tools/shell/resultBlock.ts')
const { TaskOutput } = await import('../../src/engine/task-framework/taskOutput.ts')
const { generateTaskId } = await import('../../src/engine/tasks/taskBase.ts')
const engine = resolveShellEngine('brush')
assert.equal(engine.engine, 'brush', 'the proof requires the bundled persistent shell engine')
if (engine.engine !== 'brush') throw new Error(engine.reason)
let checks = 0
const check = (name: string, value: unknown) => { assert.ok(value, name + ' — fix runEngineCommand in src/platform/shell/engineSession.ts (live output, kill, session state) or the mirror and spill in src/engine/task-framework/taskOutput.ts (mirrorToDisk, writeStdout, flush)'); checks++; console.log('PASS ' + name) }
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
  check('settled non-overflowed engine command removes its live mirror file', !existsSync(command.taskOutput.path))
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
  check('subsequent non-overflowed engine commands remove their live mirror files', !existsSync(stderrCommand.taskOutput.path) && !existsSync(next.taskOutput.path))
  const killed = runEngineCommand(engine.binaryPath, "printf 'before-kill\\n'; sleep 10", { signal: controller.signal, timeout: 10000, cwd: process.cwd() })
  outputs.push(killed.taskOutput)
  const killDeadline = Date.now() + 2500
  let killLive = ''
  while (Date.now() < killDeadline) {
    if (existsSync(killed.taskOutput.path)) killLive = readFileSync(killed.taskOutput.path, 'utf8')
    if (killLive.includes('before-kill')) break
    await delay(25)
  }
  killed.kill()
  await killed.result
  const unlinkDeadline = Date.now() + 2500
  while (Date.now() < unlinkDeadline && existsSync(killed.taskOutput.path)) await delay(25)
  check('killing a running engine command removes its live mirror file', killLive.includes('before-kill') && !existsSync(killed.taskOutput.path))
  const overflowed = runEngineCommand(engine.binaryPath, `node -e "process.stdout.write('x'.repeat(9 * 1024 * 1024) + '\\\\n')"`, { signal: controller.signal, timeout: 15000, cwd: process.cwd() })
  outputs.push(overflowed.taskOutput)
  const overflowResult = await overflowed.result
  check('an overflowed engine command keeps its spilled artifact on disk', overflowed.taskOutput.isOverflowed && overflowResult.stdout.includes(overflowed.taskOutput.path) && existsSync(overflowed.taskOutput.path))
  const bg = await exec("sleep 0.3; printf 'bg-engine:%s\\n' \"$BRUSH_VERSION\"", controller.signal, 'bash', { timeout: 10000, cwd: process.cwd(), shouldAutoBackground: true, backgroundIntent: true })
  outputs.push(bg.taskOutput)
  const bgAccepted = bg.background(bg.taskOutput.taskId)
  const bgBlock = mapResultToBlock({ stdout: '', stderr: '', interrupted: false, backgroundTaskId: bg.taskOutput.taskId }, 'toolu_bg_engine')
  const bgNoticeText = typeof bgBlock.content === 'string' ? bgBlock.content : ''
  const bgNamedPath = /Output: (.+?)\.(?: |$)/.exec(bgNoticeText)?.[1] ?? ''
  const bgResult = await bg.result
  const bgBody = bgNamedPath !== '' && existsSync(bgNamedPath) ? readFileSync(bgNamedPath, 'utf8') : ''
  check('a background command on the engine road keeps the output file its result names after exit', bgAccepted && bgResult.code === 0 && bgResult.backgroundTaskId === bg.taskOutput.taskId && bgNamedPath === bg.taskOutput.path && bgBody === `bg-engine:${engine.version}\n`)
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
