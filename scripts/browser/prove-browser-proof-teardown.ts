import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '../..'))
const world = mkdtempSync(join(tmpdir(), 'browser-teardown-pin-'))
let failures = 0
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
}
function alive(pid: number) {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()
  return state.length > 0 && !state.startsWith('Z')
}
try {
  for (const mode of ['normal', 'wall', 'term', 'kill-request', 'unresponsive'] as const) {
    const dir = join(world, mode)
    mkdirSync(dir)
    const receipt = join(dir, 'browser.json')
    const fixture = join(dir, 'fixture.ts')
    writeFileSync(fixture, `import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
if (process.env.PROOF_BROWSER_PATH) process.env.MERCURY_BROWSER_PATH = process.env.PROOF_BROWSER_PATH
const { ensureBrowserSession } = await import(${JSON.stringify(join(root, 'src/services/browser/browserSession.ts'))})
const { processOwnerForLane } = await import(${JSON.stringify(join(root, 'src/services/run/resolveOwner.ts'))})
const s = await ensureBrowserSession(processOwnerForLane(null))
if ('state' in s) throw new Error(s.note)
const child = s.browser.process()!
const profile = child.spawnargs.find(arg => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length)
const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], {encoding:'utf8'}).trim().split('\\n').map(line => line.trim().split(/\\s+/).map(Number))
const helpers: number[] = []
const visit = (pid: number) => { for (const [candidate, parent] of rows) if (parent === pid) { helpers.push(candidate!); visit(candidate!) } }
visit(child.pid!)
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({pid:child.pid, profile, helpers}))
${mode === 'kill-request' ? "child.kill('SIGKILL'); process.exit(0)" : mode === 'unresponsive' ? "process.kill(child.pid!, 'SIGSTOP'); setInterval(() => {}, 1000)" : mode === 'normal' ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}
`)
    const runner = join(dir, 'run-all.sh')
    writeFileSync(runner, `#!/usr/bin/env bash\n# gate-class: cpu\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}\n`)
    const child = spawn('bash', [join(root, 'scripts/gate/run-suite.sh'), runner, mode === 'wall' || mode === 'unresponsive' ? '6' : '30', dir], { cwd: root, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', b => { output += b })
    child.stderr.on('data', b => { output += b })
    const ended = new Promise<number | null>(r => child.on('exit', r))
    if (mode === 'term') {
      const deadline = Date.now() + 20_000
      while (!existsSync(receipt) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
      child.kill('SIGTERM')
    }
    const code = await ended
    const log = existsSync(join(dir, `${mode}.out`)) ? readFileSync(join(dir, `${mode}.out`), 'utf8') : output
    check(`${mode} launched the product browser`, existsSync(receipt), `rc=${code}${!existsSync(receipt) ? ` ${log}` : ''}`)
    if (!existsSync(receipt)) continue
    const { pid, profile, helpers } = JSON.parse(readFileSync(receipt, 'utf8')) as {pid:number; profile:string; helpers:number[]}
    check(`${mode} ends the browser process`, !alive(pid), `pid=${pid}`)
    check(`${mode} ends the browser helpers`, helpers.length > 0 && helpers.every(pid => !alive(pid)), `helpers=${helpers.length}, live=${helpers.filter(alive).length}`)
    check(`${mode} removes the browser profile`, !existsSync(profile), profile)
    check(`${mode} ${mode === 'unresponsive' ? 'kills only after the protocol wait expires' : 'quits through the protocol before any kill'}`, (mode === 'unresponsive' ? /proof browser: .*fallback=true/ : /proof browser: .* protocol=closed .*fallback=false/).test(log), log.trim())
    check(`${mode} preserves the runner result`, code === (mode === 'wall' || mode === 'unresponsive' ? 137 : mode === 'term' ? 143 : 0), String(code))
    if (alive(pid)) process.kill(pid, 'SIGKILL')
    rmSync(profile, { recursive: true, force: true })
  }
} finally {
  rmSync(world, { recursive: true, force: true })
}
process.exitCode = failures ? 1 : 0
