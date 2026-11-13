#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { bound, childEnv, DIST, MODEL, NODE, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedRequest } from '../lib/scriptedTurn.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`)
}
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'outlive-road-')))
console.log(`world: ${scratch}`)

const ASK = 'keep the stand-in server up after this run'
const LAW = "a long command runs with the Bash tool's run_in_background flag and ends with the session or run that started it"
const ROAD = 'a process that must stay up after that (a server something checks once the run has ended) is a Service with lifecycle project.'
const CLOSING = 'Do not rephrase the command to evade this rule — surface the refusal to the operator instead.'
const START_ROAD = 'A process that must stay up after this run (a server something checks once the run has ended) is a Service with lifecycle project, not a background shell.'
const TURN_WORDS = 'This run ends when your turn ends (unless a crewmate is still running) and stops this command then'
const SIX = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob']

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const end = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
}
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))
const j = (value: unknown): string => JSON.stringify(value)

function oneShot(cwd: string, env: NodeJS.ProcessEnv, flags: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(NODE, [DIST, 'run', '--format', 'rows', '--mode', 'sovereign', '--model', MODEL, ...flags, '--', ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), bound(120_000))
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ code, stderr, stdout })
    })
  })
}

type Played = { code: number | null; stdout: string; stderr: string; offered: string[]; resultAfter: (step: number) => string }
async function play(name: string, flags: string[], calls: Array<{ name: string; input: Record<string, unknown> }>): Promise<Played> {
  const home = join(scratch, name, 'home')
  const cwd = join(scratch, name, 'work')
  seedScratchHome(home, cwd)
  const fixture = await startScriptedFixture(req => {
    if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
    const call = calls[req.step]
    return call === undefined ? [{ type: 'text', text: 'done' }] : [{ type: 'tool_use', name: call.name, input: call.input }]
  })
  const run = await oneShot(cwd, childEnv(home, Number(new URL(fixture.base).port)), flags)
  await fixture.close()
  const asked: ScriptedRequest[] = fixture.requests.filter(req => req.ask.trim() === ASK)
  return {
    code: run.code,
    stdout: run.stdout,
    stderr: run.stderr,
    offered: asked[0]?.toolNames ?? [],
    resultAfter: step => asked.find(req => req.step === step + 1)?.results[0]?.text ?? '',
  }
}
const detached = { name: 'Bash', input: { command: 'nohup sleep 300 > /dev/null 2>&1 &', description: 'the stand-in server, detached' } }
const inBackground = { name: 'Bash', input: { command: 'exec sleep 300', run_in_background: true, description: 'the stand-in server' } }
const asService = { name: 'Service', input: { op: 'start', name: 'stand-in-server', command: 'sleep', args: ['300'], lifecycle: 'project' } }
const namedWholeWord = (text: string, tool: string): boolean => new RegExp(`(^|[^A-Za-z])${tool}([^A-Za-z]|$)`).test(text)

section('S1 — a run with the Service tool: the refusal of a detached start states the law and names the road, and the road it names keeps the process up')
let whole: Played
{
  whole = await play('whole', [], [detached, inBackground, asService])
  const refusal = whole.resultAfter(0)
  const started = whole.resultAfter(1)
  const service = whole.resultAfter(2)
  const shellPid = Number(/Process id (\d+)\./.exec(started)?.[1] ?? Number.NaN)
  const servicePid = Number(/\(pid (\d+)\)/.exec(service)?.[1] ?? Number.NaN)
  await sleep(1_500)
  check('the run completed', whole.code === 0 && whole.stdout.includes('"type":"outcome"'), `exit ${String(whole.code)} · ${whole.stderr.slice(-300)}`)
  check('the run offers the Service tool', whole.offered.includes('Service') && whole.offered.includes('Bash'), j(whole.offered))
  check('the detached start is refused by the self-daemonize ward', refusal.includes("Ward 'self-daemonize' blocked this Bash call"), refusal)
  check('the refusal states the law and then the road that outlives the run, a Service with lifecycle project, before its closing sentence', refusal.includes(`${LAW}; ${ROAD} ${CLOSING}`), refusal)
  check('the background start the refusal points to says the run stops it, and names the same road', started.includes(TURN_WORDS) && started.includes(START_ROAD), started)
  check('…and that background shell ended with the run', Number.isInteger(shellPid) && !alive(shellPid), `pid ${shellPid}`)
  check('the Service the two sentences name started with lifecycle project', Number.isInteger(servicePid) && servicePid > 0 && service.includes('lifecycle: project'), service.slice(0, 300))
  check('…and it is still running after the run exited: the road the refusal names works', Number.isInteger(servicePid) && alive(servicePid), `pid ${servicePid}`)
  if (Number.isInteger(shellPid)) end(shellPid)
  if (Number.isInteger(servicePid)) end(servicePid)
}

section('S2 — a run with a tool list of six and no Service: each sentence stops at the law and names no tool the run does not have')
{
  const six = await play('six', ['--toolset', ...SIX, '--only-mcp', '--block-tools', 'mcp__mercury'], [detached, inBackground])
  const refusal = six.resultAfter(0)
  const started = six.resultAfter(1)
  const shellPid = Number(/Process id (\d+)\./.exec(started)?.[1] ?? Number.NaN)
  await sleep(1_500)
  const notOffered = whole.offered.filter(tool => !six.offered.includes(tool))
  console.log(`  the run offers: ${six.offered.join(', ')}`)
  console.log(`  tools a whole run offers and this one does not: ${notOffered.length}`)
  check('the run completed', six.code === 0 && six.stdout.includes('"type":"outcome"'), `exit ${String(six.code)} · ${six.stderr.slice(-300)}`)
  check('the run offers the six and no Service', SIX.every(tool => six.offered.includes(tool)) && !six.offered.includes('Service'), j(six.offered))
  check('the detached start is refused by the same ward', refusal.includes("Ward 'self-daemonize' blocked this Bash call"), refusal)
  check('the refusal states the law and stops there: its closing sentence follows "that started it."', refusal.includes(`${LAW}. ${CLOSING}`) && !refusal.includes('Service'), refusal)
  check('the background start says the run stops the command, and names no Service', started.includes(TURN_WORDS) && !started.includes('Service'), started)
  check('…and that background shell ended with the run', Number.isInteger(shellPid) && !alive(shellPid), `pid ${shellPid}`)
  const named = [refusal, started].flatMap(text => notOffered.filter(tool => namedWholeWord(text, tool)))
  check('neither sentence names a tool this run does not have', notOffered.length > 0 && named.length === 0, j(named))
  if (Number.isInteger(shellPid)) end(shellPid)
}

if (failures === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
console.log(`\n${checks} checks, ${failures} failures`)
if (failures > 0) {
  console.log('OUTLIVE ROAD RED')
  process.exit(1)
}
console.log('OUTLIVE ROAD GREEN')
