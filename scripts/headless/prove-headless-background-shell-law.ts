#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bound, childEnv, DIST, MODEL, NODE, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture, type ScriptedRequest } from '../lib/scriptedTurn.ts'

const tally = makeTally()
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const ROOT = resolve(import.meta.dir, '..', '..')
const KEEP = process.argv.includes('--keep')
const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, 'background-shell-law-')))
console.log(`world: ${scratch}`)

const SHELL_ASK = 'start the stand-in server in the background and finish'
const SERVICE_ASK = 'start the stand-in server as a project service and finish'
const SERVICE_ROAD = 'A process that must stay up after this run (a server something checks once the run has ended) is a Service with lifecycle project, not a background shell.'
const TURN_WORDS = 'This run ends when your turn ends (unless a crewmate is still running) and stops this command then'
const PROMPT_ROAD = 'A process that must stay up after the run that started it (a server something checks once the run has ended) is a `Service` with lifecycle project'

function makeTally(): { check: (label: string, cond: boolean, detail?: string) => void; section: (t: string) => void; finish: () => never; failed: () => number } {
  let failures = 0
  let checks = 0
  return {
    check(label, cond, detail = '') {
      checks++
      if (!cond) failures++
      console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
    },
    section(t) {
      console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`)
    },
    failed: () => failures,
    finish() {
      console.log(`\n${checks} checks, ${failures} failures`)
      if (failures > 0) {
        console.log('HEADLESS BACKGROUND SHELL LAW RED')
        process.exit(1)
      }
      console.log('HEADLESS BACKGROUND SHELL LAW GREEN')
      process.exit(0)
    },
  }
}

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
const startResult = (requests: ScriptedRequest[], ask: string): string | undefined => requests.find(r => r.ask.trim() === ask && r.step === 1)?.results[0]?.text
const settleMs = 1_500
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function oneShot(cwd: string, env: NodeJS.ProcessEnv, prompt: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(NODE, [DIST, 'run', prompt, '--format', 'rows', '--mode', 'sovereign', '--model', MODEL], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
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

tally.section('S1 — a one-shot run: a stand-in server started with run_in_background ends with the run (the documented law), and the start result names the road that outlives the run')
{
  const home = join(scratch, 'shell', 'home')
  const cwd = join(scratch, 'shell', 'work')
  seedScratchHome(home, cwd)
  const fixture = await startScriptedFixture(req => {
    if (req.ask.trim() !== SHELL_ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'exec sleep 300', run_in_background: true, description: 'the stand-in server' } }]
    return [{ type: 'text', text: 'started' }]
  })
  const port = Number(new URL(fixture.base).port)
  const run = await oneShot(cwd, childEnv(home, port), SHELL_ASK)
  await fixture.close()
  const text = startResult(fixture.requests, SHELL_ASK) ?? ''
  const notice = text.split('\n').find(line => line.startsWith('Running in the background')) ?? ''
  const pid = Number(/Process id (\d+)\./.exec(notice)?.[1] ?? Number.NaN)
  await sleep(settleMs)
  tally.check('the one-shot run completed', run.code === 0 && run.stdout.includes('"type":"outcome"'), `exit ${String(run.code)} · ${run.stderr.slice(-300)}`)
  tally.check('the start result named the process', Number.isInteger(pid) && pid > 0, JSON.stringify(notice.slice(0, 200)))
  tally.check('the background shell ended with the run: the process the result named is gone after exit', Number.isInteger(pid) && !alive(pid), `pid ${pid} alive=${Number.isInteger(pid) ? alive(pid) : 'n/a'}`)
  tally.check('the start result still says the run stops the command when the turn ends', notice.includes(TURN_WORDS), JSON.stringify(notice))
  tally.check('the start result names the road that outlives the run: a Service with lifecycle project (the field row M39-02)', notice.includes(SERVICE_ROAD), JSON.stringify(notice))
  if (Number.isInteger(pid)) end(pid)
}

tally.section('S2 — the same run with a Service of lifecycle project: the process outlives the run')
{
  const home = join(scratch, 'service', 'home')
  const cwd = join(scratch, 'service', 'work')
  seedScratchHome(home, cwd)
  const fixture = await startScriptedFixture(req => {
    if (req.ask.trim() !== SERVICE_ASK) return [{ type: 'text', text: 'ok' }]
    if (req.step === 0) return [{ type: 'tool_use', name: 'Service', input: { op: 'start', name: 'stand-in-server', command: 'sleep', args: ['300'], lifecycle: 'project' } }]
    return [{ type: 'text', text: 'started' }]
  })
  const port = Number(new URL(fixture.base).port)
  const run = await oneShot(cwd, childEnv(home, port), SERVICE_ASK)
  await fixture.close()
  const text = startResult(fixture.requests, SERVICE_ASK) ?? ''
  const pid = Number(/\(pid (\d+)\)/.exec(text)?.[1] ?? Number.NaN)
  await sleep(settleMs)
  tally.check('the one-shot run completed', run.code === 0 && run.stdout.includes('"type":"outcome"'), `exit ${String(run.code)} · ${run.stderr.slice(-300)}`)
  tally.check('the Service start result names the process and the project lifecycle', Number.isInteger(pid) && pid > 0 && text.includes('lifecycle: project'), JSON.stringify(text.slice(0, 300)))
  tally.check('the service is still running after the run exited', Number.isInteger(pid) && alive(pid), `pid ${pid}`)
  if (Number.isInteger(pid)) end(pid)
}

tally.section('S3 — the words the model reads before choosing: the Bash tool prompt and the sessions doc name the road')
{
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
  const offered = getSimplePrompt(new Set(['Bash', 'Service', 'ToolSearch']))
  const loaded = getSimplePrompt(new Set(['Bash', 'Service']))
  const without = getSimplePrompt(new Set(['Bash']))
  tally.check('the Bash prompt’s Background paragraph names the Service road when the Service tool is offered, with the ToolSearch hint when it is deferred', offered.includes(`${PROMPT_ROAD} (ToolSearch \`select:Service\` loads it when deferred), not a background shell.`) && loaded.includes(`${PROMPT_ROAD}, not a background shell.`), offered.slice(offered.indexOf('Background:'), offered.indexOf('Background:') + 700))
  tally.check('without the Service tool the paragraph stops at the polling rule', !without.includes(PROMPT_ROAD) && without.includes('Never poll with repeated calls.'), '')
  const sessions = readFileSync(join(ROOT, 'docs/SESSIONS.md'), 'utf8')
  tally.check('SESSIONS.md says a headless run ends every background shell and names the Service road for a process that must stay up', sessions.includes('A headless run whose input closes ends every monitor and every') && sessions.includes('lifecycle `project`'), '')
}

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
