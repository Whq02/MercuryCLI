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
const pidOf = (result: Result): number => Number(/pid=(\d+)/.exec(result.stdout)?.[1] ?? -1)

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

async function run(command: string, timeoutMs = 30_000, owner?: string): Promise<Result> {
  const controller = new AbortController()
  const cmd = runEngineCommand(binaryPath, command, {
    timeout: timeoutMs,
    signal: controller.signal,
    ...(owner !== undefined ? { owner } : {}),
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

section('§10 two owners: a shell each — side by side, isolated, reset and ended apart')
{
  resetEngineSessionForTest()
  const { endEngineSession, endEngineSessionFor, engineChildForTest } = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))
  const order: string[] = []
  const a = run('sleep 2; echo A', 30_000, 'owner-a').then(r => {
    order.push('a')
    return r
  })
  const b = run('echo B', 30_000, 'owner-b').then(r => {
    order.push('b')
    return r
  })
  const [ra, rb] = await Promise.all([a, b])
  check("two owners run at the same time: the second owner's short command settles first", order[0] === 'b' && ra.stdout.includes('A') && rb.stdout.includes('B'), `order ${order.join(',')}`)
  const pidA = pidOf(await run('echo "pid=$$"', 30_000, 'owner-a'))
  const pidB = pidOf(await run('echo "pid=$$"', 30_000, 'owner-b'))
  check('each owner has its own engine process', pidA > 1 && pidB > 1 && pidA !== pidB && alive(pidA) && alive(pidB), `pids ${pidA}/${pidB}`)
  await run('OWNER_VAR=a-only; owner_fn() { echo fn-a; }', 30_000, 'owner-a')
  const seenByB = await run('echo "[${OWNER_VAR:-none}]"; owner_fn 2>/dev/null || echo fn-missing', 30_000, 'owner-b')
  check("an owner's variable and function are not seen by another owner", seenByB.stdout.includes('[none]') && seenByB.stdout.includes('fn-missing'), JSON.stringify(seenByB.stdout))
  const seenByA = await run('echo "[$OWNER_VAR]"; owner_fn', 30_000, 'owner-a')
  check('…and stay visible to their owner', seenByA.stdout.includes('[a-only]') && seenByA.stdout.includes('fn-a'), JSON.stringify(seenByA.stdout))
  await run('KEEP_B=kept', 30_000, 'owner-b')
  const hung = await run('sleep 30', 700, 'owner-a')
  check("owner A's hung command is killed with the timeout code", hung.code === 143, `code=${hung.code}`)
  const afterB = await run('echo "[${KEEP_B:-gone}]"', 30_000, 'owner-b')
  check("owner B's state survives owner A's reset, and B's result carries no note", afterB.stdout.includes('[kept]') && afterB.stderr === '', JSON.stringify(afterB))
  const afterA = await run('echo "[${OWNER_VAR:-gone}]"', 30_000, 'owner-a')
  check("owner A's next result carries the reset note and finds its state gone", afterA.stdout.includes('[gone]') && afterA.stderr.includes('reset'), JSON.stringify(afterA))
  const childA = engineChildForTest('owner-a')
  const childB = engineChildForTest('owner-b')
  const freshA = childA?.pid ?? -1
  await endEngineSessionFor('owner-a')
  check("ending owner A's session ends A's process and not B's", freshA > 1 && (await diedWithin(freshA, 2_500)) && childB !== null && childB.pid === pidB && alive(pidB), `A ${freshA} B ${pidB}`)
  const backA = await run('echo "pid=$$"', 30_000, 'owner-a')
  check('a later command from owner A spawns fresh with no note owed', backA.code === 0 && pidOf(backA) > 1 && pidOf(backA) !== freshA && backA.stderr === '', JSON.stringify(backA))
  const lastA = pidOf(backA)
  await endEngineSession()
  check("the switch road ends every owner's session (both processes)", (await diedWithin(lastA, 2_500)) && (await diedWithin(pidB, 2_500)), `A ${lastA} alive=${alive(lastA)} B ${pidB} alive=${alive(pidB)}`)
}

section('§11 the ceiling on engine sessions: nine owners against 8 — the ninth waits and gets a session when an agent ends; a ceiling of 1 leaves none for agents')
{
  resetEngineSessionForTest()
  const { endEngineSessionFor, engineChildForTest, engineWaitingOwnersForTest, resolveEngineSessionCeiling } = await import(join(ROOT, 'src/utils/shell/engineSession.ts'))
  const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))
  const savedPin = process.env.MERCURY_SHELL_ENGINE_SESSIONS
  process.env.MERCURY_SHELL_ENGINE_SESSIONS = '8'
  check('the env pin outranks the setting and the default', resolveEngineSessionCeiling(3) === 8 && resolveEngineSessionCeiling() === 8)
  const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5', 'agent-6', 'agent-7']
  const pids = new Set<number>([pidOf(await run('echo "pid=$$"'))])
  for (const owner of agents) pids.add(pidOf(await run('echo "pid=$$"', 30_000, owner)))
  check('the main conversation and seven sub-agents hold eight distinct sessions', pids.size === 8 && [...pids].every(pid => pid > 1), [...pids].join(','))
  let rowNote = ''
  const ninthController = new AbortController()
  const ninth = runEngineCommand(binaryPath, 'echo ninth; echo "pid=$$"', {
    timeout: 30_000,
    signal: ninthController.signal,
    owner: 'agent-8',
    onProgress: (recent: string) => {
      if (/waiting for a free shell engine session/.test(recent)) rowNote = recent
    },
  })
  let deadline = Date.now() + 10_000
  while (!engineWaitingOwnersForTest().includes('agent-8') && Date.now() < deadline) await pause()
  check('the ninth owner waits for a free session — never a ninth process', engineWaitingOwnersForTest().includes('agent-8') && engineChildForTest('agent-8') === null && ninth.status === 'running', `waiting=${engineWaitingOwnersForTest().join(',')}`)
  check("the wait is said on the ninth's row, with the count and the ceiling", /waiting for a free shell engine session: 7 of 7 sub-agent sessions are in use \(the ceiling is 8/.test(rowNote), JSON.stringify(rowNote))
  await endEngineSessionFor('agent-3')
  const ninthResult = (await ninth.result) as Result
  check('when an agent ends, the waiting owner gets a session and its command runs, on a process of its own', ninthResult.code === 0 && ninthResult.stdout.includes('ninth') && pidOf(ninthResult) > 1 && !pids.has(pidOf(ninthResult)), JSON.stringify(ninthResult))
  check('…and its output carries no trace of the wait (the note was the row\'s, never the output\'s)', !/waiting for a free/.test(ninthResult.stdout) && ninthResult.stderr === '', JSON.stringify(ninthResult))
  check('the ninth is no longer waiting', !engineWaitingOwnersForTest().includes('agent-8'))
  const late = (await runEngineCommand(binaryPath, 'echo late', { timeout: 600, signal: new AbortController().signal, owner: 'agent-9' }).result) as Result & { preSpawnError?: string }
  check("a wait past the call's timeout settles as a not-started result naming the ceiling", late.code === 1 && !late.interrupted && late.stdout === '' && /no shell engine session was free within 1s/.test(late.preSpawnError ?? '') && /the ceiling is 8/.test(late.stderr), JSON.stringify(late))
  const abortController = new AbortController()
  const parked = runEngineCommand(binaryPath, 'echo never', { timeout: 30_000, signal: abortController.signal, owner: 'agent-10' })
  deadline = Date.now() + 10_000
  while (!engineWaitingOwnersForTest().includes('agent-10') && Date.now() < deadline) await pause()
  check('a second waiter is parked too', engineWaitingOwnersForTest().includes('agent-10'))
  abortController.abort('stop')
  const parkedResult = (await parked.result) as Result
  check('a waiting call that is aborted settles as aborted before execution (code 145), and leaves the wait', parkedResult.interrupted && parkedResult.code === 145 && !engineWaitingOwnersForTest().includes('agent-10'), JSON.stringify(parkedResult))
  process.env.MERCURY_SHELL_ENGINE_SESSIONS = '1'
  resetEngineSessionForTest()
  const mainOnly = await run('echo main-runs')
  check('under a ceiling of 1 the main conversation runs', mainOnly.code === 0 && mainOnly.stdout.includes('main-runs'), JSON.stringify(mainOnly))
  const refused = (await runEngineCommand(binaryPath, 'echo agent', { timeout: 30_000, signal: new AbortController().signal, owner: 'agent-1' }).result) as Result & { preSpawnError?: string }
  check("…and a sub-agent's call is refused at once, typed, naming the ceiling and the way round", refused.code === 1 && refused.stdout === '' && /the ceiling is 1/.test(refused.preSpawnError ?? '') && /run_in_background/.test(refused.preSpawnError ?? '') && engineChildForTest('agent-1') === null, JSON.stringify(refused))
  check('the main conversation still runs afterwards, with no note', (await run('echo still')).stderr === '')
  delete process.env.MERCURY_SHELL_ENGINE_SESSIONS
  check('with no pin the setting decides, else 8', resolveEngineSessionCeiling() === 8 && resolveEngineSessionCeiling(3) === 3)
  process.env.MERCURY_SHELL_ENGINE_SESSIONS = '0'
  check('a pin below 1 is ignored', resolveEngineSessionCeiling(3) === 3)
  process.env.MERCURY_SHELL_ENGINE_SESSIONS = 'many'
  check('a pin that is not a whole number is ignored', resolveEngineSessionCeiling() === 8)
  if (savedPin === undefined) delete process.env.MERCURY_SHELL_ENGINE_SESSIONS
  else process.env.MERCURY_SHELL_ENGINE_SESSIONS = savedPin
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
