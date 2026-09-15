#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-empty-command-refused')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'empty-command-'))
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const ASK = 'empty-command-probe'
const seen: Record<string, SeenResult> = {}
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  const last = req.results[req.results.length - 1]
  switch (req.step) {
    case 0:
      return [{ type: 'tool_use', name: 'Bash', input: { command: '', run_in_background: true, description: 'an empty background launch' } }]
    case 1:
      if (last) seen.emptyBackground = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'echo still-runs', run_in_background: true, description: 'a real background launch' } }]
    case 2:
      if (last) seen.realBackground = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: ' \n\t ', run_in_background: true, description: 'a whitespace background launch' } }]
    case 3:
      if (last) seen.blankBackground = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'true', description: 'a real foreground run' } }]
    case 4:
      if (last) seen.realForeground = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: '', description: 'an empty foreground run' } }]
    case 5:
      if (last) seen.emptyForeground = last
      return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 2', description: 'a pause for the settle' } }]
    default:
      return [{ type: 'text', text: 'done' }]
  }
})

let turn: { exitCode: number | null; stderr: string } = { exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: ASK, timeoutMs: 120_000, extraArgv: ['--dangerously-bypass-permissions'] })
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
for (const [k, v] of Object.entries(seen)) show(k, v)

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
const rows: Array<{ taskId: string; command: string }> = []
for (const file of outcomeFiles(join(scratch, 'home'))) {
  for (const row of JSON.parse(readFileSync(file, 'utf8')).envelopes as Array<{ taskId: string; command: string; taskType: string }>) if (row.taskType === 'local_bash') rows.push({ taskId: row.taskId, command: row.command })
}
console.log(`\nbackground shell records: ${JSON.stringify(rows)}`)

const refused = (r: SeenResult | undefined): boolean => r !== undefined && r.isError && /command is empty/.test(r.text) && /nothing to run/i.test(r.text)
tally.section('A. a command with nothing to run is refused at the tool, before any spawn')
tally.check('A1 an empty background launch is refused with words naming the fact', refused(seen.emptyBackground), seen.emptyBackground?.text.slice(0, 300))
tally.check('A2 a whitespace-only background launch is refused the same way', refused(seen.blankBackground), seen.blankBackground?.text.slice(0, 300))
tally.check('A3 an empty foreground run is refused the same way', refused(seen.emptyForeground), seen.emptyForeground?.text.slice(0, 300))
tally.check('A4 no refused launch became a background task', !/Running in the background/.test(seen.emptyBackground?.text ?? '') && !/Running in the background/.test(seen.blankBackground?.text ?? ''), `${seen.emptyBackground?.text.slice(0, 120)} | ${seen.blankBackground?.text.slice(0, 120)}`)

tally.section('B. a real launch still lands and is the only shell task on record')
const realId = /\(ID: (b[0-9a-z]+)\)/.exec(seen.realBackground?.text ?? '')?.[1] ?? null
tally.check('B1 a real background launch answers its id', realId !== null && !seen.realBackground?.isError, seen.realBackground?.text.slice(0, 200))
tally.check('B2 a real foreground run between the refusals is untouched', seen.realForeground !== undefined && !seen.realForeground.isError, seen.realForeground?.text.slice(0, 200))
tally.check('B3 the outcome record carries that launch and no empty-command row', rows.length === 1 && rows[0]?.taskId === realId && rows[0]?.command === 'echo still-runs', JSON.stringify(rows))

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
