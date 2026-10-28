import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(import.meta.dir, '../..')
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

if (process.argv[2] === '--child') {
  const dir = process.argv[3]!
  const road = process.argv[4]!
  const { registerCleanup } = await import('../../src/utils/cleanupRegistry.ts')
  registerCleanup(() => { throw new Error('fixture cleanup throws synchronously') })
  const { enableConfigs } = await import('../../src/utils/config.ts')
  enableConfigs()
  const { setCwd } = await import('../../src/utils/Shell.ts')
  await setCwd(dir)
  const { setupGracefulShutdown, gracefulShutdown, crashShutdown } = await import('../../src/utils/gracefulShutdown.ts')
  setupGracefulShutdown()
  const { ensureScratchpadDir, armScratchpadSweep } = await import('../../src/utils/scratchpad.ts')
  const scratch = ensureScratchpadDir()
  armScratchpadSweep()
  writeFileSync(join(scratch, 'owned.txt'), 'fixture')
  const { connectToServer } = await import('../../src/services/mcp/client.ts')
  const marker = join(dir, 'mcp.pid')
  const client = await connectToServer('exit-fixture', { type: 'stdio', command: 'node', args: [join(root, 'scripts/core-runtime/mcp-stub-server.mjs'), '--spawn-marker', marker], scope: 'dynamic' })
  if (client.type !== 'connected') throw new Error(JSON.stringify(client))
  const pids = [Number(readFileSync(marker, 'utf8').split(' ')[0])]
  for (const name of ['probe', 'media', 'watch']) {
    const child = spawn('node', ['-e', 'setInterval(()=>{},1000)', name], { stdio: 'ignore' })
    pids.push(child.pid!)
    registerCleanup(async () => {
      const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await ended
    })
  }
  writeFileSync(join(dir, 'ready.json'), JSON.stringify({ pids, scratch }))
  process.stdin.once('data', () => {
    if (road === 'exit') void gracefulShutdown(0)
    else if (road === 'crash') void crashShutdown(1)
    else if (road === 'interrupt') {
      process.kill(process.pid, 'SIGINT')
      setTimeout(() => process.kill(process.pid, 'SIGINT'), 20).unref()
    } else process.kill(process.pid, 'SIGHUP')
  })
} else {
  let failures = 0
  for (const road of ['exit', 'interrupt', 'hangup', 'crash']) {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-throw-'))
    const home = join(dir, 'home')
    mkdirSync(home)
    const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none' }
    delete env.MERCURY_HOME
    delete env.MERCURY_CONCOURSE_WORKER
    const child = spawn(process.execPath, [import.meta.path, '--child', dir, road], { env, cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', c => { output += c })
    child.stderr.on('data', c => { output += c })
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    const deadline = Date.now() + 15000
    while (!existsSync(join(dir, 'ready.json')) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    if (!existsSync(join(dir, 'ready.json'))) {
      child.kill('SIGKILL')
      await exited
      console.error(`FAIL ${road}: fixture never ready: ${output}`)
      failures++
      rmSync(dir, { recursive: true, force: true })
      continue
    }
    const ready = JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')) as { pids: number[]; scratch: string }
    child.stdin.write('exit\n')
    const code = await Promise.race([exited, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 8000).unref())])
    await new Promise(resolve => setTimeout(resolve, 5000))
    const left = ready.pids.filter(alive)
    const scratchLeft = existsSync(ready.scratch)
    const ok = code === (road === 'exit' ? 0 : road === 'crash' ? 1 : road === 'interrupt' ? 130 : 129) && left.length === 0 && !scratchLeft
    console.log(`${ok ? 'PASS' : 'FAIL'} ${road}: exit=${code}, children=${left.length}, scratch=${scratchLeft}`)
    if (!ok) failures++
    if (code === 'timeout') { child.kill('SIGKILL'); await exited }
    for (const pid of left) { try { process.kill(pid, 'SIGKILL') } catch {} }
    rmSync(ready.scratch, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
  process.exitCode = failures === 0 ? 0 : 1
}
