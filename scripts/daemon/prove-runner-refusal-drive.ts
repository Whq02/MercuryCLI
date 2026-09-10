#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const MODEL = 'claude-opus-4-8'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${t}`)
}
const j = (v: unknown): string => JSON.stringify(v)

if (!existsSync(DIST)) {
  console.error('build the product before the drive')
  process.exit(1)
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  console.error('node is required on PATH')
  process.exit(1)
}
const python = Bun.which('python3')
if (!python) {
  console.error('python3 is required on PATH for the eval kernel leg')
  process.exit(1)
}

type Envelope = Record<string, unknown> & { type: string; subtype?: string; request_id?: string; request?: Record<string, unknown> }
type Runner = {
  pid: number
  send(o: unknown): void
  waitFor(pred: (e: Envelope) => boolean, label: string, timeoutMs?: number): Promise<Envelope | undefined>
  quiesce(action: 'prepare' | 'commit' | 'cancel', token: string): Promise<{ ok: boolean; phase?: string; reason?: string }>
  exited: Promise<number | null>
  alive(): boolean
  envelopes: Envelope[]
  stderr(): string
}

const alivePid = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function startRunner(fixture: FixtureApi, home: string, cwd: string, extraArgs: string[]): Promise<Runner> {
  const env = {
    HOME: home,
    PATH: `${dirname(python!)}:/usr/bin:/bin:${dirname(nodeBin!)}`,
    TERM: 'dumb',
    BROWSER: '/usr/bin/true',
    MERCURY_CONFIG_DIR: join(home, '.mercury'),
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_DAP_ADAPTERS_FILE: join(home, 'dap-adapters.json'),
  }
  const child = spawn(nodeBin!, [DIST, '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--model', MODEL, ...extraArgs], { cwd, env })
  const killer = setTimeout(() => child.kill('SIGKILL'), 150_000)
  const envelopes: Envelope[] = []
  const waiters: Array<{ pred: (e: Envelope) => boolean; res: (e: Envelope) => void }> = []
  let buf = ''
  let stderr = ''
  child.stdout.on('data', d => {
    buf += String(d)
    for (;;) {
      const nl = buf.indexOf('\n')
      if (nl === -1) break
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Envelope
        envelopes.push(e)
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.pred(e)) waiters.splice(i, 1)[0]!.res(e)
        }
      } catch {}
    }
  })
  child.stderr.on('data', d => (stderr += String(d)))
  const exited = new Promise<number | null>(res => child.on('close', code => { clearTimeout(killer); res(code) }))
  let done = false
  void exited.then(() => { done = true })
  const waitFor = (pred: (e: Envelope) => boolean, label: string, timeoutMs = 60_000): Promise<Envelope | undefined> =>
    new Promise(res => {
      const hit = envelopes.find(pred)
      if (hit) return res(hit)
      const t = setTimeout(() => {
        console.log(`  [dbg] waitFor timeout: ${label}; envelopes=${j(envelopes.map(e => `${e.type}:${e.subtype ?? ''}`))} stderr=${stderr.slice(-400)}`)
        res(undefined)
      }, timeoutMs)
      waiters.push({ pred, res: e => { clearTimeout(t); res(e) } })
    })
  const send = (o: unknown): void => {
    if (!done) child.stdin.write(JSON.stringify(o) + '\n')
  }
  let seq = 0
  const quiesce = async (action: 'prepare' | 'commit' | 'cancel', token: string): Promise<{ ok: boolean; phase?: string; reason?: string }> => {
    const request_id = `req_quiesce_${++seq}`
    send({ type: 'control_request', request_id, request: { subtype: 'quiesce', action, token } })
    const reply = (await waitFor(e => e.type === 'control_response' && j(e).includes(request_id), `quiesce ${action} answer`, 20_000)) as
      | (Envelope & { response?: { subtype?: string; response?: { phase?: string }; error?: string } })
      | undefined
    if (reply === undefined) return { ok: false, reason: 'no answer' }
    const inner = reply.response
    return inner?.subtype === 'success' ? { ok: true, phase: inner.response?.phase } : { ok: false, reason: inner?.error }
  }
  return { pid: child.pid!, send, waitFor, quiesce, exited, alive: () => !done && alivePid(child.pid!), envelopes, stderr: () => stderr }
}

const TOKEN = 'retire-drive-token-0001'
const TOKEN_2 = 'retire-drive-token-0002'
const TOKEN_3 = 'retire-drive-token-0003'
const TOKEN_4 = 'retire-drive-token-0004'
const TOKEN_5 = 'retire-drive-token-0005'

const home = mkdtempSync(join(tmpdir(), 'runner-refusal-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'runner-refusal-cwd-'))
mkdirSync(join(home, '.mercury'), { recursive: true })
const mockAdapter = join(ROOT, 'scripts', 'dap', 'mock-dap-adapter.mjs')
const adaptersFile = join(home, 'dap-adapters.json')
writeFileSync(adaptersFile, JSON.stringify({ mockrefusal: { command: nodeBin, args: [mockAdapter], fileTypes: ['.mrf'] } }))
const debugProgram = join(cwd, 'probe.mrf')
writeFileSync(debugProgram, 'x\n')

const turns: ScriptedTurn[] = [
  { kind: 'hang', deltas: ['thinking about it…'] },
  { kind: 'tool_use', name: 'Service', input: { op: 'start', name: 'refusal-sleeper', command: nodeBin, args: ['-e', 'setInterval(() => {}, 1000)'], readiness: [{ kind: 'stable', ms: 200 }], lifecycle: 'session' }, id: 'toolu_service_start' },
  { kind: 'text', text: 'SERVICE-UP-DONE.' },
  { kind: 'tool_use', name: 'Service', input: { op: 'stop', name: 'refusal-sleeper' }, id: 'toolu_service_stop' },
  { kind: 'text', text: 'SERVICE-DOWN-DONE.' },
  { kind: 'tool_use', name: 'Debug', input: { op: 'launch', program: debugProgram, file: debugProgram, lines: [3] }, id: 'toolu_debug_launch' },
  { kind: 'text', text: 'DEBUG-UP-DONE.' },
  { kind: 'tool_use', name: 'Debug', input: { op: 'disconnect' }, id: 'toolu_debug_disconnect' },
  { kind: 'text', text: 'DEBUG-DOWN-DONE.' },
  { kind: 'tool_use', name: 'Eval', input: { language: 'py', code: "print('kernel-up')\nheld = 2 * 21\nheld", title: 'refusal probe' }, id: 'toolu_eval_probe' },
  { kind: 'text', text: 'KERNEL-TURN-DONE.' },
  { kind: 'tool_use', name: 'Eval', input: { language: 'py', code: 'held', title: 'retained probe' }, id: 'toolu_eval_retained' },
  { kind: 'text', text: 'RETAINED-TURN-DONE.' },
  { kind: 'tool_use', name: 'Eval', input: { language: 'py', code: 'held', title: 'fresh probe', reset: true }, id: 'toolu_eval_fresh' },
  { kind: 'text', text: 'FRESH-TURN-DONE.' },
]
const fixture = await startFixtureApi(turns)
const runner = await startRunner(fixture, home, cwd, ['--permission-channel', 'stdio'])

try {
  section('§1 the runner is up and idle: a quiesce prepare with a bad token is refused before any state is read')
  runner.send({ type: 'control_request', request_id: 'req_init', request: { subtype: 'initialize' } })
  const init = await runner.waitFor(e => e.type === 'control_response' && j(e).includes('req_init'), 'initialize ack')
  check('initialize is acknowledged', init !== undefined && j(init).includes('"success"'), j(init ?? {}).slice(0, 200))
  const badToken = await runner.quiesce('prepare', 'short')
  check('a malformed token is refused as invalid', !badToken.ok && /invalid preparation token/.test(badToken.reason ?? ''), j(badToken))

  section('§2 a turn is running: prepare is refused naming the turn, and the turn is untouched')
  runner.send({ type: 'user', message: { role: 'user', content: 'refusal probe one' }, parent_tool_use_id: null })
  await fixture.messageRequestStarted(1)
  const midTurn = await runner.quiesce('prepare', TOKEN)
  check("prepare during the hanging turn is refused with 'a turn is running'", !midTurn.ok && /a turn is running/.test(midTurn.reason ?? ''), j(midTurn))
  const commitMidTurn = await runner.quiesce('commit', TOKEN)
  check('a commit with no standing preparation is refused (the refusal invalidated it)', !commitMidTurn.ok && /preparation is absent or invalidated/.test(commitMidTurn.reason ?? ''), j(commitMidTurn))
  check('the runner is still alive after the refusals', runner.alive())
  runner.send({ type: 'control_request', request_id: 'req_int', request: { subtype: 'interrupt' } })
  const interrupted = await runner.waitFor(e => e.type === 'result', 'interrupted result')
  check('the hanging turn ends only when interrupted, not by the refused park', interrupted !== undefined && interrupted.subtype === 'error_during_execution', j({ s: interrupted?.subtype }))


  const allowNext = async (label: string, seen: Set<string>, marker: string): Promise<Envelope | undefined> => {
    const ask = await runner.waitFor(e => (e.type === 'control_request' && e.request?.subtype === 'can_use_tool' && !seen.has(e.request_id ?? '')) || (e.type === 'result' && j(e).includes(marker)), label)
    if (ask?.type !== 'control_request') return undefined
    if (ask.request_id !== undefined) seen.add(ask.request_id)
    runner.send({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow', updated_input: (ask.request as { input?: unknown } | undefined)?.input ?? {} } } })
    return ask
  }
  const seenAsks = new Set<string>()
  const resultAfter = async (marker: string, label: string): Promise<Envelope | undefined> => runner.waitFor(e => e.type === 'result' && j(e).includes(marker), label)

  section('§2b a live session service is a hold on the real runner; stopping it lifts the hold')
  runner.send({ type: 'user', message: { role: 'user', content: 'refusal probe service up' }, parent_tool_use_id: null })
  await allowNext('service-start ask', seenAsks, 'SERVICE-UP-DONE.')
  const serviceUp = await resultAfter('SERVICE-UP-DONE.', 'service-up result')
  check('the service started through the Service tool', serviceUp?.subtype === 'success' && runner.envelopes.some(e => j(e).includes('refusal-sleeper')), j({ s: serviceUp?.subtype }))
  const withService = await runner.quiesce('prepare', 'retire-drive-token-0007')
  check("prepare is refused with '1 service (a live process) would not survive a park'", !withService.ok && /1 service \(a live process\) would not survive a park/.test(withService.reason ?? ''), j(withService))
  runner.send({ type: 'user', message: { role: 'user', content: 'refusal probe service down' }, parent_tool_use_id: null })
  await allowNext('service-stop ask', seenAsks, 'SERVICE-DOWN-DONE.')
  const serviceDown = await resultAfter('SERVICE-DOWN-DONE.', 'service-down result')
  check('the service stopped through the Service tool', serviceDown?.subtype === 'success', j({ s: serviceDown?.subtype }))
  const afterService = await runner.quiesce('prepare', 'retire-drive-token-0008')
  check('with the service stopped, prepare is answered prepared (the hold was the service, not the runner)', afterService.ok && afterService.phase === 'prepared', j(afterService))
  const cancelService = await runner.quiesce('cancel', 'retire-drive-token-0008')
  check('the preparation is cancelled so the runner stays for the next hold', cancelService.ok && cancelService.phase === 'cancelled', j(cancelService))

  section('§2c a live debug session is a hold on the real runner; disconnecting lifts it')
  runner.send({ type: 'user', message: { role: 'user', content: 'refusal probe debug up' }, parent_tool_use_id: null })
  await allowNext('debug-launch ask', seenAsks, 'DEBUG-UP-DONE.')
  const debugUp = await resultAfter('DEBUG-UP-DONE.', 'debug-up result')
  check('the debug session launched through the Debug tool against the stdio adapter', debugUp?.subtype === 'success' && runner.envelopes.some(e => j(e).includes('toolu_debug_launch') && j(e).includes('mockrefusal')), j({ s: debugUp?.subtype }))
  const withDebug = await runner.quiesce('prepare', 'retire-drive-token-0009')
  check("prepare is refused with '1 debug session (a live process) would not survive a park'", !withDebug.ok && /1 debug session \(a live process\) would not survive a park/.test(withDebug.reason ?? ''), j(withDebug))
  runner.send({ type: 'user', message: { role: 'user', content: 'refusal probe debug down' }, parent_tool_use_id: null })
  await allowNext('debug-disconnect ask', seenAsks, 'DEBUG-DOWN-DONE.')
  const debugDown = await resultAfter('DEBUG-DOWN-DONE.', 'debug-down result')
  check('the debug session disconnected through the Debug tool', debugDown?.subtype === 'success', j({ s: debugDown?.subtype }))
  const afterDebug = await runner.quiesce('prepare', 'retire-drive-token-0010')
  check('with the debug session gone, prepare is answered prepared', afterDebug.ok && afterDebug.phase === 'prepared', j(afterDebug))
  await runner.quiesce('cancel', 'retire-drive-token-0010')

  section('§3 a permission ask is pending: prepare is refused on the pending control request')
  runner.send({ type: 'user', message: { role: 'user', content: 'refusal probe two' }, parent_tool_use_id: null })
  const ask = await runner.waitFor(e => e.type === 'control_request' && e.request?.subtype === 'can_use_tool' && !seenAsks.has(e.request_id ?? ''), 'can_use_tool ask')
  if (ask?.request_id !== undefined) seenAsks.add(ask.request_id)
  check('the Eval call raised a can_use_tool ask on the wire', ask !== undefined && (ask.request as { tool_name?: string } | undefined)?.tool_name === 'Eval', j(ask ?? {}).slice(0, 200))
  const withAsk = await runner.quiesce('prepare', TOKEN_2)
  check('prepare is refused while the ask stands (the turn still runs, the ask holds it)', !withAsk.ok && /a turn is running|pending control request/.test(withAsk.reason ?? ''), j(withAsk))
  runner.send({ type: 'control_response', response: { subtype: 'success', request_id: ask?.request_id, response: { behavior: 'allow', updated_input: (ask?.request as { input?: unknown } | undefined)?.input ?? {} } } })
  const kernelResult = (await runner.waitFor(e => e.type === 'result' && j(e).includes('KERNEL-TURN-DONE.'), 'kernel turn result')) as (Envelope & { result?: string }) | undefined
  check('the Eval turn completes after the ask is allowed', kernelResult?.subtype === 'success' && kernelResult.result === 'KERNEL-TURN-DONE.', j({ s: kernelResult?.subtype, r: kernelResult?.result }))
  check('the cell ran on a real kernel', runner.envelopes.some(e => j(e).includes('kernel-up')), j(runner.envelopes.filter(e => e.type === 'user').map(e => j(e).slice(0, 160))))

  section('§4 the turn is over but a live eval kernel remains: prepare is refused naming the kernel as a live process')
  const withKernel = await runner.quiesce('prepare', TOKEN_3)
  check("prepare is refused with 'eval kernel (a live process) would not survive a park'", !withKernel.ok && /1 eval kernel \(a live process\) would not survive a park/.test(withKernel.reason ?? ''), j(withKernel))
  check('the runner is alive and idle after the kernel refusal', runner.alive())

  section('§5 the kernel is still there for the next cell (a refusal disposed nothing)')
  runner.send({ type: 'user', message: { role: 'user', content: 'refusal probe three' }, parent_tool_use_id: null })
  const ask2 = await runner.waitFor(e => e.type === 'control_request' && e.request?.subtype === 'can_use_tool' && !seenAsks.has(e.request_id ?? ''), 'second can_use_tool ask')
  if (ask2?.request_id !== undefined) seenAsks.add(ask2.request_id)
  runner.send({ type: 'control_response', response: { subtype: 'success', request_id: ask2?.request_id, response: { behavior: 'allow', updated_input: (ask2?.request as { input?: unknown } | undefined)?.input ?? {} } } })
  const retained = (await runner.waitFor(e => e.type === 'result' && j(e).includes('RETAINED-TURN-DONE.'), 'retained turn result')) as (Envelope & { result?: string }) | undefined
  const toolResultOf = (toolUseId: string): string => {
    for (const e of runner.envelopes) {
      if (e.type !== 'user') continue
      const content = (e as { message?: { content?: unknown } }).message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
        if (block.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue
        return typeof block.content === 'string' ? block.content : j(block.content)
      }
    }
    return ''
  }
  const retainedResult = toolResultOf('toolu_eval_retained')
  check("the second cell READ `held` without assigning it, and its own correlated tool_result carries 42: the kernel that ran the first cell is the one that ran the second", retained?.subtype === 'success' && /\b42\b/.test(retainedResult) && !/NameError|not defined/.test(retainedResult), retainedResult.slice(0, 300))
  const stillHeld = await runner.quiesce('prepare', TOKEN_4)
  check('prepare is still refused on the kernel after the second cell', !stillHeld.ok && /eval kernel/.test(stillHeld.reason ?? ''), j(stillHeld))

  section('§6 a cancel after a refusal is honest; a fresh prepare stays refused while the kernel lives')
  const cancel = await runner.quiesce('cancel', TOKEN_4)
  check('cancel answers cancelled', cancel.ok && cancel.phase === 'cancelled', j(cancel))
  const again = await runner.quiesce('prepare', TOKEN_5)
  check('the kernel refusal is not stateful noise: it repeats while the kernel is alive', !again.ok && /eval kernel/.test(again.reason ?? ''), j(again))
  check('the runner never exited through any refused or cancelled request', runner.alive())
  check('the kernel has no release road but the idle reaper (15 minutes): the refusal stands for as long as the kernel does, which is the law the census states', (await runner.quiesce('prepare', 'retire-drive-token-0011')).ok === false)

  section('§6b the controlled negative: a cell that RESETS the kernel reads `held` on a fresh one and gets NameError')
  runner.send({ type: 'user', message: { role: 'user', content: 'refusal probe fresh' }, parent_tool_use_id: null })
  await allowNext('fresh-kernel ask', seenAsks, 'FRESH-TURN-DONE.')
  const fresh = (await runner.waitFor(e => e.type === 'result' && j(e).includes('FRESH-TURN-DONE.'), 'fresh turn result')) as (Envelope & { result?: string }) | undefined
  const freshResult = toolResultOf('toolu_eval_fresh')
  check("after reset the same read fails with NameError in ITS correlated tool_result: state lives in the kernel, not in the runner, so the earlier 42 was the retained kernel's", fresh?.subtype === 'success' && /NameError|not defined/.test(freshResult) && !/\b42\b/.test(freshResult), freshResult.slice(0, 300))
  check('the replacement kernel is itself a hold (the census counts kernels, not history)', (await runner.quiesce('prepare', 'retire-drive-token-0012')).ok === false)
} finally {
  runner.send({ type: 'control_request', request_id: 'req_end', request: { subtype: 'interrupt' } })
  const code = await Promise.race([
    (async () => { const c = await runner.exited; return c })(),
    (async () => { await new Promise(r => setTimeout(r, 2_000)); return 'still-up' as const })(),
  ])
  if (code === 'still-up') {
    process.kill(runner.pid, 'SIGTERM')
    await Promise.race([runner.exited, new Promise(r => setTimeout(r, 10_000))])
  }
  if (alivePid(runner.pid)) process.kill(runner.pid, 'SIGKILL')
  await runner.exited
  await fixture.close()
  rmSync(home, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
}

section('§7 the kernel, the ask and the turn are the refusals the runner speaks; the daemon side records the last one')
{
  const print = await Bun.file(join(ROOT, 'src', 'cli', 'print.ts')).text()
  check('the runner names the turn before the queue, the tasks and the census', /refusal: \(\) => \{\s*if \(driver\.isRunning\(\)\) return 'a turn is running'\s*if \(getCommandQueue\(\)\.some\(isMainThreadCommand\)\) return 'a prompt is queued'/.test(print))
  const supervisor = await Bun.file(join(ROOT, 'src', 'daemon', 'concourseSupervisor.ts')).text()
  check('a refused retirement lands parkRefused on the record with the reason and who asked', /w\.parkRefused = \{ reason: result\.reason, at: Date\.now\(\), by \}/.test(supervisor))
}

if (failures > 0) {
  console.log(`\n${failures} FAIL`)
  process.exit(1)
}
console.log('\nPASS the real headless runner refuses to park while a turn runs, an ask is pending, or a kernel, a service or a debug session lives; each release makes it parkable again; it never exits through a refusal')
