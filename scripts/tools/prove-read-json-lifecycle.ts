import { fork, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const tree = resolve(dirname(script), '../..')
const root = process.env.PROVE_ROOT ?? tree
const node = join(tree, 'dist/vendor/node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const processScript = join(root, 'src/tools/FileReadTool/jsonQueryProcess.mjs')
const pack = join(tree, 'vendor/json-query/extracted')
const mode = process.argv[2]
if (mode === '--owner') {
  const home = process.env.READ_QUERY_HOME!
  if (homedir() !== home) throw new Error('The runtime did not take the proof home')
  const scenario = process.argv[3]
  const directory = join(home, 'query')
  mkdirSync(directory, { recursive: true })
  const child = fork(processScript, [], { execPath: node, execArgv: [], stdio: ['pipe', 'ignore', 'pipe', 'ipc'], env: { ...process.env, HOME: home, USERPROFILE: home } })
  let begun = 0, reply: any, started = false
  const watchdog = setTimeout(() => { child.kill('SIGKILL'); process.exit(1) }, 3500)
  child.stderr?.on('data', chunk => process.stderr.write(chunk))
  child.on('message', (message: any) => {
    if (message.started && !started) {
      started = true
      begun = performance.now()
      process.send?.({ started: true, pid: child.pid })
      if (scenario === 'cancel') child.kill('SIGKILL')
      else if (scenario === 'disconnect') child.disconnect()
      else if (scenario === 'exit') process.exit(0)
    } else if (message.result || message.error) reply = message
  })
  child.once('exit', code => {
    clearTimeout(watchdog)
    child.stdin?.destroy()
    child.stderr?.destroy()
    process.send?.({ ended: true, code, elapsed: performance.now() - begun, reply }, () => process.exit(started ? 0 : 1))
  })
  child.send({ pack, directory, sourceSize: 2, query: scenario === 'success' ? '.' : 'until(false; .)', offset: 0, limit: 100, raw: false, compact: true })
  child.stdin!.end('{}')
} else {
  let passed = 0, failed = 0
  const check = (name: string, ok: boolean, detail = '') => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : ` ${detail}`}`) }
  check('the disposable query process ships in source', existsSync(processScript))
  check('the release Node is present for the lifecycle reading', existsSync(node))
  const base = process.env.RP_SCRATCH ?? process.env.MERCURY_TMPDIR ?? process.env.MERCURY_CONFIG_DIR
  if (!base) throw new Error('The proof needs its scratch root')
  if (existsSync(processScript) && existsSync(node)) {
    for (const runtime of [...new Set([process.execPath, node])]) {
      for (const scenario of ['success', 'cancel', 'disconnect', 'exit', 'killed']) {
        const home = realpathSync(mkdtempSync(join(base, 'query-life-')))
        let childPid: number | undefined, received: any, started = false, expired = false
        const owner = fork(script, ['--owner', scenario], { execPath: runtime, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, HOME: home, USERPROFILE: home, READ_QUERY_HOME: home } })
        let stderr = ''
        owner.stderr?.on('data', chunk => { stderr += String(chunk) })
        const timer = setTimeout(() => { expired = true; owner.kill('SIGKILL'); if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch {} } }, 4000)
        owner.on('message', (message: any) => {
          if (message.started) {
            started = true
            childPid = message.pid
            if (scenario === 'killed') owner.kill('SIGKILL')
          }
          if (message.ended) received = message
        })
        await new Promise<void>(resolve => owner.once('close', () => resolve()))
        clearTimeout(timer)
        if (scenario === 'exit' || scenario === 'killed') await new Promise(resolve => setTimeout(resolve, 500))
        let alive = false
        if (childPid) { try { process.kill(childPid, 0); alive = true } catch {} }
        const name = runtime === node ? 'release Node' : 'proof runtime'
        const result = scenario === 'success' ? received?.code === 0 && received?.reply?.result?.shown === 1 : scenario === 'cancel' || scenario === 'disconnect' ? received?.elapsed < 2000 : true
        check(`${name}: ${scenario} starts the engine and leaves no child`, started && !expired && !alive && result, JSON.stringify({ childPid, alive, received, expired, stderr }))
        if (alive && childPid) { try { process.kill(childPid, 'SIGKILL') } catch {} }
        rmSync(home, { recursive: true, force: true })
      }
    }
  }
  console.log(`${passed}/${passed + failed} checks`)
  process.exitCode = failed ? 1 : 0
}
