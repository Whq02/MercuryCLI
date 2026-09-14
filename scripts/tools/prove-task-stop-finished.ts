#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-task-stop-finished')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'task-stop-finished-'))
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const ASK = 'stop-probe'
const AGENT_PROMPT = 'sub agent work'
const NEVER_MINTED = 'bnevermint'
const PANEL_GRACE_SECONDS = 30
const GRACE_MARGIN_SECONDS = 5

let shellId: string | null = null
let agentId: string | null = null
const stops: Record<string, SeenResult> = {}
const launches: Record<string, string> = {}

const fixture = await startScriptedFixture(req => {
  if (req.opening.trim() === AGENT_PROMPT) return [{ type: 'text', text: 'agent done' }]
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 1; printf finished-marker', run_in_background: true, description: 'a short background run' } }]
    case 1: {
      launches.shell = last?.text ?? ''
      shellId = /\(ID: (b[0-9a-z]+)\)/.exec(launches.shell)?.[1] ?? null
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 3', description: 'a pause past the run' } }]
    }
    case 2:
      return [{ type: 'tool_use', name: 'TaskStop', input: { task_id: shellId ?? NEVER_MINTED } }]
    case 3: {
      if (last) stops.shell = last
      return [{ type: 'tool_use', name: 'TaskStop', input: { task_id: NEVER_MINTED } }]
    }
    case 4: {
      if (last) stops.never = last
      return [{ type: 'tool_use', name: 'Agent', input: { description: 'sub work', prompt: AGENT_PROMPT, run_in_background: true } }]
    }
    case 5: {
      launches.agent = last?.text ?? ''
      agentId = /\b(a[0-9a-z]{8})\b/.exec(launches.agent)?.[1] ?? null
      return [{ type: 'tool_use', name: 'Bash', input: { command: `sleep ${PANEL_GRACE_SECONDS + GRACE_MARGIN_SECONDS}`, description: 'a pause past the panel grace' } }]
    }
    case 6:
      return [{ type: 'tool_use', name: 'TaskStop', input: { task_id: agentId ?? NEVER_MINTED } }]
    default: {
      if (req.step === 7 && last) stops.agent = last
      return [{ type: 'text', text: 'done' }]
    }
  }
})

let turn: { exitCode: number | null; stderr: string } = { exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: ASK, timeoutMs: 180_000, extraArgv: ['--dangerously-bypass-permissions'] })
} finally {
  await fixture.close()
}

const show = (label: string, r: SeenResult | undefined): void => {
  console.log(`\n── ${label} ──`)
  if (!r) {
    console.log(`│ (no tool result reached the wire; run exit ${turn.exitCode ?? '?'}: ${turn.stderr.slice(-400)})`)
    return
  }
  console.log(`│ is_error: ${r.isError}`)
  for (const line of r.text.split('\n')) console.log(`│ ${line}`)
}
show('the background launch', launches.shell === undefined ? undefined : { toolUseId: '', text: launches.shell, isError: false })
show('TaskStop on the finished shell task', stops.shell)
show('TaskStop on an id never minted', stops.never)
show('the agent launch', launches.agent === undefined ? undefined : { toolUseId: '', text: launches.agent, isError: false })
show('TaskStop on the finished agent, past the panel grace', stops.agent)

function parsed(r: SeenResult | undefined): Record<string, unknown> | null {
  if (!r) return null
  try {
    return JSON.parse(r.text) as Record<string, unknown>
  } catch {
    return null
  }
}

tally.section('a background shell run that already completed')
tally.check('the run was moved to the background and answered its id', shellId !== null, launches.shell ?? '(no launch)')
const shell = parsed(stops.shell)
const shellMessage = String(shell?.message ?? stops.shell?.text ?? '')
tally.check('the stop is not an error outcome', stops.shell !== undefined && !stops.shell.isError, stops.shell?.text)
tally.check('the answer says the task had already completed', /already completed/.test(shellMessage), shellMessage)
tally.check('…names when it completed', /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(shellMessage), shellMessage)
tally.check('…and where its output file is', shellId !== null && (shellMessage.includes(`${shellId}.output`) || /tool-results/.test(shellMessage)), shellMessage)
tally.check('the structured answer carries the task id and the finished mark', shell?.task_id === shellId && typeof shell?.finished_at === 'string' && typeof shell?.output_path === 'string', JSON.stringify(shell))

tally.section('an id that never existed keeps the bare miss')
tally.check('the stop is an error naming the miss', stops.never !== undefined && stops.never.isError && /No task found with id/.test(stops.never.text), stops.never?.text)

tally.section('a finished agent past the panel grace — unchanged')
tally.check('the agent was launched and answered its id', agentId !== null, launches.agent ?? '(no launch)')
tally.check('the stop is an error naming the transcript end and the resume door', stops.agent !== undefined && stops.agent.isError && /No running task with id/.test(stops.agent.text) && /transcript on disk ends/.test(stops.agent.text) && /SendMessage/.test(stops.agent.text), stops.agent?.text)

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
