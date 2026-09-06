#!/usr/bin/env bun
import '../lib/hermetic.ts'

process.env.MERCURY_SHELL_ENGINE = 'brush'

import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { resolveShellEngine, runEngineCommand, resetEngineSessionForTest } = await import(
  join(ROOT, 'src/utils/shell/engineSession.ts')
)
const { getCwd } = await import(join(ROOT, 'src/utils/cwd.ts'))
const state = await import(join(ROOT, 'src/bootstrap/state.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const resolution = resolveShellEngine('brush')
if (resolution.engine !== 'brush') {
  console.log(`ℹ️  brush pack not vendored on this host (${resolution.reason}) — the engine proof skips cleanly.`)
  process.exit(0)
}
const binaryPath: string = resolution.binaryPath
console.log(`shell engine: brush ${resolution.version} (${resolution.platform}) at ${binaryPath}`)

type Result = { stdout: string; stderr: string; code: number; interrupted: boolean }

async function run(command: string, timeoutMs = 30_000): Promise<Result> {
  const controller = new AbortController()
  const cmd = runEngineCommand(binaryPath, command, {
    timeout: timeoutMs,
    signal: controller.signal,
    onCwd: (cwd: string) => {
      try {
        state.setCwdState(cwd)
      } catch {
      }
    },
  })
  return (await cmd.result) as Result
}

section('§1 sentinel framing · exit codes · stderr folded into stdout')
{
  const ok = await run('echo hello')
  check('a plain command settles code 0 with its stdout', ok.code === 0 && ok.stdout.includes('hello'), `code=${ok.code} out=${JSON.stringify(ok.stdout)}`)

  const one = await run('false')
  check('a failing command reports its real exit code (1)', one.code === 1, `code=${one.code}`)

  const notfound = await run('nosuchcommand_xyz')
  check('command-not-found reports 127', notfound.code === 127, `code=${notfound.code}`)

  const ordered = await run('echo out1; echo err1 >&2; echo out2')
  check('stderr is folded into stdout in order (exec 2>&1)',
    ordered.stdout.indexOf('out1') < ordered.stdout.indexOf('err1') && ordered.stdout.indexOf('err1') < ordered.stdout.indexOf('out2'),
    JSON.stringify(ordered.stdout))
}

section('§2 a variable, a function and the cwd persist across three calls')
{
  resetEngineSessionForTest()
  const os = await import('node:os')
  const fs = await import('node:fs')
  const scratch = fs.mkdtempSync(join(os.tmpdir(), 'brush-cwd-'))
  state.setCwdState(fs.realpathSync(scratch))

  const c1 = await run('BRUSH_PROBE=persisted; greet() { echo "hi $1"; }; echo call1')
  check('call 1 runs', c1.code === 0 && c1.stdout.includes('call1'))

  const c2 = await run('echo "var=$BRUSH_PROBE"; greet world')
  check('call 2 sees the variable set in call 1', c2.stdout.includes('var=persisted'), JSON.stringify(c2.stdout))
  check('call 2 sees the function defined in call 1', c2.stdout.includes('hi world'), JSON.stringify(c2.stdout))

  const c3 = await run('cd /tmp && pwd -P')
  check('call 3 can cd and reports the new cwd', c3.stdout.includes('/tmp') || c3.stdout.includes('/private/tmp'), JSON.stringify(c3.stdout))
  const c4 = await run('pwd -P')
  check('call 4 starts where call 3 left off (cwd slaved through onCwd)',
    c4.stdout.includes('/tmp') || c4.stdout.includes('/private/tmp'), `getCwd=${getCwd()} out=${JSON.stringify(c4.stdout)}`)
}

section('§3 a command printing sentinel-shaped bytes cannot fake completion')
{
  resetEngineSessionForTest()
  const fake = String.fromCharCode(1) + 'deadbeef 0' + String.fromCharCode(2) + '/tmp' + String.fromCharCode(3)
  const r = await run(`printf %s ${JSON.stringify(fake)}; echo REAL_END; true`)
  check('the real command completes with code 0', r.code === 0, `code=${r.code}`)
  check('the whole output — including the spoofed frame — is returned, not cut at the fake', r.stdout.includes('REAL_END'), JSON.stringify(r.stdout.slice(0, 80)))
}

section('§4 a hung command is killed by the timeout; the session respawns and says so')
{
  resetEngineSessionForTest()
  await run('TIMEOUT_MARKER=beforehang')
  const start = Date.now()
  const hung = await run('sleep 30', 700)
  const elapsed = Date.now() - start
  check('the hung command is killed near its timeout, not after 30s', elapsed < 5_000, `elapsed=${elapsed}ms`)
  check('the killed command reports a timeout code', hung.code === 143, `code=${hung.code}`)
  check('the timeout result names the reset (state loss is not silent)', /reset|timed out/i.test(hung.stderr), JSON.stringify(hung.stderr))

  const after = await run('echo "marker=[$TIMEOUT_MARKER]"')
  check('the session respawned — the earlier variable is gone', after.stdout.includes('marker=[]'), JSON.stringify(after.stdout))
  check('the respawn note rode the next result', after.stderr.includes('reset'), JSON.stringify(after.stderr))
}

section('§5 large output rides back within the tool budget')
{
  resetEngineSessionForTest()
  const big = await run('for i in $(seq 1 5000); do echo "line-$i-padding-padding-padding"; done')
  check('a 5000-line run settles code 0', big.code === 0, `code=${big.code}`)
  check('the output is captured (head visible)', big.stdout.includes('line-1-') && big.stdout.length > 1000, `len=${big.stdout.length}`)
}

resetEngineSessionForTest()
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '✅ ALL SHELL-ENGINE SESSION PROOFS PASS' : `❌ ${failures} SHELL-ENGINE SESSION PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
