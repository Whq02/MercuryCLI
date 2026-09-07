#!/usr/bin/env bun
import '../lib/hermetic.ts'

process.env.MERCURY_SHELL_ENGINE = 'brush'

import { join, sep } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const { resolveShellEngine, runEngineCommand, resetEngineSessionForTest } = await import(
  join(ROOT, 'src/utils/shell/engineSession.ts')
)
const { getCwd } = await import(join(ROOT, 'src/utils/cwd.ts'))
const state = await import(join(ROOT, 'src/bootstrap/state.ts'))
const { quote } = await import(join(ROOT, 'src/utils/bash/shellQuote.ts'))
const { stripExtendedLengthPrefix } = await import(join(ROOT, 'src/utils/windowsPaths.ts'))
const os = await import('node:os')
const fs = await import('node:fs')
const sameDir = (a: string, b: string): boolean => {
  const spell = (s: string): string => stripExtendedLengthPrefix(s.trim())
  try {
    const sa = fs.statSync(spell(a), { bigint: true })
    const sb = fs.statSync(spell(b), { bigint: true })
    if (sa.ino !== 0n && sb.ino !== 0n) return sa.dev === sb.dev && sa.ino === sb.ino
    const resolved = (s: string): string => {
      const r = fs.realpathSync.native(spell(s))
      return process.platform === 'win32' ? stripExtendedLengthPrefix(r).toLowerCase() : r
    }
    return resolved(a) === resolved(b)
  } catch {
    return false
  }
}
const lastLine = (text: string): string => text.trim().split(/\r?\n/).pop() ?? ''

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
  const allThree = ordered.stdout.includes('out1') && ordered.stdout.includes('err1') && ordered.stdout.includes('out2')
  check('stderr is folded into stdout in order (exec 2>&1)',
    allThree && ordered.stdout.indexOf('out1') < ordered.stdout.indexOf('err1') && ordered.stdout.indexOf('err1') < ordered.stdout.indexOf('out2'),
    JSON.stringify(ordered.stdout))
}

section('§2 a variable, a function and the cwd persist across three calls')
{
  resetEngineSessionForTest()
  const scratch = fs.mkdtempSync(join(os.tmpdir(), 'brush-cwd-'))
  state.setCwdState(fs.realpathSync(scratch))

  const c1 = await run('BRUSH_PROBE=persisted; greet() { echo "hi $1"; }; echo call1')
  check('call 1 runs', c1.code === 0 && c1.stdout.includes('call1'))

  const c2 = await run('echo "var=$BRUSH_PROBE"; greet world')
  check('call 2 sees the variable set in call 1', c2.stdout.includes('var=persisted'), JSON.stringify(c2.stdout))
  check('call 2 sees the function defined in call 1', c2.stdout.includes('hi world'), JSON.stringify(c2.stdout))

  const pairRoot = fs.mkdtempSync(join(os.tmpdir(), 'engine-samedir-'))
  const dirA = join(pairRoot, 'a')
  const dirB = join(pairRoot, 'b')
  const linkA = join(pairRoot, 'a-link')
  fs.mkdirSync(dirA)
  fs.mkdirSync(dirB)
  fs.symlinkSync(dirA, linkA, process.platform === 'win32' ? 'junction' : 'dir')
  check('the directory comparison: a directory and a link to it are one directory', sameDir(dirA, linkA))
  check('…a sibling directory is not', !sameDir(dirA, dirB))
  check('…a trailing separator does not change identity', sameDir(dirA, dirA + sep))
  check('…a spelling that does not exist is never the target', !sameDir(dirA, join(pairRoot, 'missing')))
  if (process.platform === 'darwin') check('…/tmp and /private/tmp are one directory (the Mac link pair)', sameDir('/tmp', '/private/tmp'))
  fs.rmSync(pairRoot, { recursive: true, force: true })

  const target = fs.realpathSync(os.tmpdir())
  const c3 = await run(`cd -- ${quote([target])} && pwd -P`)
  check('call 3 can cd and reports the new cwd', c3.code === 0 && sameDir(lastLine(c3.stdout), target), `code=${c3.code} out=${JSON.stringify(c3.stdout)}`)
  const c4 = await run('pwd -P')
  check('call 4 starts where call 3 left off (cwd slaved through onCwd)', sameDir(lastLine(c4.stdout), target), `getCwd=${getCwd()} out=${JSON.stringify(c4.stdout)}`)
  check('the session records the directory in its native form (no extended-length prefix) and it is the target', !getCwd().startsWith('\\\\?\\') && sameDir(getCwd(), target), `getCwd=${getCwd()}`)
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

section('§6 the session ends on request: the switch road and the exit cleanup end the live brush')
{
  resetEngineSessionForTest()
  const { endEngineSession } = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))
  const { runCleanupFunctions } = await import(join(ROOT, 'src/utils/cleanupRegistry.ts'))
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const diedWithin = async (pid: number, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!alive(pid)) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return !alive(pid)
  }
  const first = await run('echo "pid=$$"')
  const firstPid = Number(/pid=(\d+)/.exec(first.stdout)?.[1] ?? -1)
  check('the session answers with its own pid', firstPid > 1 && alive(firstPid), JSON.stringify(first.stdout.slice(0, 40)))
  await endEngineSession()
  check('the switch road ends the live brush', firstPid > 1 && (await diedWithin(firstPid, 2_500)), `pid ${firstPid} still alive`)
  const second = await run('echo "pid=$$"')
  const secondPid = Number(/pid=(\d+)/.exec(second.stdout)?.[1] ?? -1)
  check('the next command spawns a fresh session with no note owed', second.code === 0 && secondPid > 1 && secondPid !== firstPid && second.stderr === '', `pid ${secondPid} stderr ${JSON.stringify(second.stderr)}`)
  await runCleanupFunctions()
  check('the exit cleanup registry ends the session too (registered at the first spawn)', secondPid > 1 && (await diedWithin(secondPid, 2_500)), `pid ${secondPid} still alive`)
}

section('§7 an engine that ends during its start refuses the command at once, with the reason')
{
  resetEngineSessionForTest()
  const notABinary = fs.mkdtempSync(join(os.tmpdir(), 'engine-not-a-binary-'))
  const controller = new AbortController()
  const refused = (await runEngineCommand(notABinary, 'echo never', { timeout: 3_000, signal: controller.signal }).result) as Result & { preSpawnError?: string }
  check('the command settles as a start failure (code 1), never as the timeout (143) after the whole wait', refused.code === 1 && !refused.interrupted, JSON.stringify(refused))
  check('…and the result names the failed start, typed as a not-started result', /shell engine failed to start/.test(refused.stderr) && typeof refused.preSpawnError === 'string', JSON.stringify(refused.stderr))
  fs.rmSync(notABinary, { recursive: true, force: true })
  resetEngineSessionForTest()
  const recovered = await run('echo alive')
  check('the real engine still spawns fresh afterwards, with no note owed', recovered.code === 0 && recovered.stdout.includes('alive') && recovered.stderr === '', JSON.stringify(recovered))
}

section('§8 an engine that dies between commands: the pipe error is heard, the loss is said')
{
  resetEngineSessionForTest()
  const { engineChildForTest } = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))
  await run('DEAD_MARK=set; echo ready')
  const child = engineChildForTest()
  check('the live engine is reachable through the seam', child !== null && typeof child?.pid === 'number')
  check("the engine's stdin pipe carries an error listener", (child?.stdin?.listenerCount('error') ?? 0) >= 1, `listeners=${child?.stdin?.listenerCount('error') ?? 'none'}`)
  let unheard: string | null = null
  const onUncaught = (error: unknown): void => {
    unheard = String(error)
  }
  process.on('uncaughtException', onUncaught)
  const exited = new Promise<void>(resolve => child?.once('exit', () => resolve()))
  child?.kill('SIGKILL')
  const writeQuietly = (): void => {
    try {
      child?.stdin?.write('x\n', () => {})
    } catch {
    }
  }
  writeQuietly()
  await exited
  writeQuietly()
  await new Promise(resolve => setTimeout(resolve, 100))
  process.off('uncaughtException', onUncaught)
  check('a write to the dead engine is heard, never an uncaught error', unheard === null, unheard ?? '')
  const after = await run('echo "[${DEAD_MARK:-gone}]"')
  check('the next command runs on a fresh engine and finds the state gone', after.code === 0 && after.stdout.includes('[gone]'), JSON.stringify(after))
  check('…and its result says the session ended between commands', /ended between commands/.test(after.stderr) && /restarted/.test(after.stderr), JSON.stringify(after.stderr))
  const later = await run('echo "[${DEAD_MARK:-gone}]"')
  check('the note rides one result only', later.stderr === '', JSON.stringify(later.stderr))
}

section('§9 an interrupt with one command running and one waiting in line: the note survives the aborted queued command')
{
  resetEngineSessionForTest()
  await run('QUEUE_MARK=set')
  const gate = join(fs.mkdtempSync(join(os.tmpdir(), 'engine-gate-')), 'in-flight')
  const turn = new AbortController()
  const running = runEngineCommand(binaryPath, `: > ${quote([gate])}; sleep 30`, { timeout: 30_000, signal: turn.signal })
  const waiting = runEngineCommand(binaryPath, 'echo b', { timeout: 30_000, signal: turn.signal })
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(gate) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  check('the first command is in flight (its gate file exists)', fs.existsSync(gate))
  turn.abort('stop')
  const ra = (await running.result) as Result
  const rb = (await waiting.result) as Result
  check('the running command is interrupted', ra.interrupted && ra.code === 137, JSON.stringify(ra))
  check('the waiting command is aborted before execution and carries no note', rb.interrupted && rb.code === 145 && rb.stderr === 'Command was aborted before execution', JSON.stringify(rb.stderr))
  const next = await run('echo "[${QUEUE_MARK:-gone}]"')
  check('the next command finds the state gone', next.stdout.includes('[gone]'), JSON.stringify(next.stdout))
  check('…and is told — the note the aborted command must not swallow', /interrupted/.test(next.stderr) && /reset/.test(next.stderr), JSON.stringify(next.stderr))
}

resetEngineSessionForTest()
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '✅ ALL SHELL-ENGINE SESSION PROOFS PASS' : `❌ ${failures} SHELL-ENGINE SESSION PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
