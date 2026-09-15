#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-shell-record-of-sub-agent-launch')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'shell-record-'))
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const ASK = 'shell-record-probe'
const AGENT_PROMPT = 'background agent work'
const SUB_COMMAND = 'sleep 1; echo from-the-sub-agent'
const SUB_DESCRIPTION = 'the sub-agent’s own background run'
const seen: Record<string, SeenResult> = {}
let subShellId: string | null = null
let agentId: string | null = null
const idOf = (t: string | undefined): string | null => /\(ID: (b[0-9a-z]+)\)/.exec(t ?? '')?.[1] ?? null

const fixture = await startScriptedFixture(req => {
  const last = req.results[req.results.length - 1]
  if (req.opening.trim() === AGENT_PROMPT) {
    switch (req.step) {
      case 0:
        return [{ type: 'tool_use', name: 'Bash', input: { command: SUB_COMMAND, run_in_background: true, description: SUB_DESCRIPTION } }]
      case 1:
        if (last) seen.subLaunch = last
        subShellId = idOf(last?.text)
        return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 3', description: 'a pause past the run' } }]
      default:
        return [{ type: 'text', text: 'agent done' }]
    }
  }
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'Agent', input: { description: 'background agent', prompt: AGENT_PROMPT, run_in_background: true } }]
    case 1:
      if (last) seen.agentLaunch = last
      agentId = /\b(a[0-9a-z]{8})\b/.exec(last?.text ?? '')?.[1] ?? null
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 8', description: 'a pause for the background agent' } }]
    case 2:
      return [{ type: 'tool_use', name: 'TaskStop', input: { task_id: subShellId ?? 'bnevermint' } }]
    default:
      if (req.step === 3 && last) seen.stop = last
      return [{ type: 'text', text: 'done' }]
  }
})

let turn: { exitCode: number | null; stderr: string } = { exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: ASK, timeoutMs: 150_000, extraArgv: ['--dangerously-bypass-permissions'] })
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
  for (const line of r.text.split('\n').slice(0, 4)) console.log(`│ ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`)
}
show('the background agent launch', seen.agentLaunch)
show('the sub-agent’s background shell launch', seen.subLaunch)
show('TaskStop on that shell from the lead', seen.stop)

type Row = { taskId: string; taskType: string; command: string; description?: string; agentId?: string; cwd?: string; startTime: number; endTime: number; durationMs: number; exitCode?: number; spawn: string }
const outcomeFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    try {
      if (statSync(path).isDirectory()) outcomeFiles(path, out)
      else if (entry.endsWith('.task-outcomes.json')) out.push(path)
    } catch {}
  }
  return out
}
const rows: Row[] = []
for (const file of outcomeFiles(join(scratch, 'home'))) for (const row of JSON.parse(readFileSync(file, 'utf8')).envelopes as Row[]) if (row.taskType === 'local_bash') rows.push(row)
const row = rows.find(r => r.taskId === subShellId)
console.log(`\nthe record: ${JSON.stringify(row ?? rows)}`)

tally.section('A. a background agent’s background shell is recorded from its launch, not from defaults')
tally.check('A1 the background agent was launched and its shell answered an id', agentId !== null && subShellId !== null, `${seen.agentLaunch?.text.slice(0, 80)} | ${seen.subLaunch?.text.slice(0, 80)}`)
tally.check('A2 the outcome record has a row for that shell', row !== undefined, JSON.stringify(rows.map(r => r.taskId)))
tally.check('A3 the row carries the command the sub-agent ran', row?.command === SUB_COMMAND, JSON.stringify(row?.command))
tally.check('A4 the row carries its description', row?.description === SUB_DESCRIPTION, JSON.stringify(row?.description))
tally.check('A5 the row names the launching agent and its cwd', row !== undefined && row.agentId === agentId && typeof row.cwd === 'string' && row.cwd.length > 0, `agentId=${row?.agentId} (expected ${agentId}) cwd=${row?.cwd}`)
tally.check('A6 the row’s span covers the run, not a moment', row !== undefined && row.durationMs >= 900 && row.durationMs === row.endTime - row.startTime, `durationMs=${row?.durationMs} start=${row?.startTime} end=${row?.endTime}`)
tally.check('A7 the row keeps the true outcome', row?.spawn === 'confirmed' && row?.exitCode === 0, `spawn=${row?.spawn} exit=${row?.exitCode}`)

tally.section('B. the lead’s stop names the run')
tally.check('B1 TaskStop says the run had already completed and names its command', seen.stop !== undefined && !seen.stop.isError && /already completed/.test(seen.stop.text) && seen.stop.text.includes(`(${SUB_COMMAND})`), seen.stop?.text.slice(0, 260))

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
