#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOOLS = readFileSync(join(root, 'src/tools.ts'), 'utf-8')
const SLEEP = readFileSync(join(root, 'src/tools/SleepTool/SleepTool.tsx'), 'utf-8')
const ROSTER = readFileSync(join(root, 'src/constants/tools.ts'), 'utf-8')
const AGENT_FILTER = readFileSync(join(root, 'src/tools/AgentTool/agentToolUtils.ts'), 'utf-8')
const blockOf = (text: string, name: string): string => text.split(`export const ${name}`)[1]?.split('])')[0] ?? ''

let failures = 0
const check = (label: string, cond: boolean): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}

console.log('============================================================')
console.log(' Sleep tool — stamp-gated + interruptible contract')
console.log('============================================================')

check('SleepTool const loads unconditionally ',
  /import \{ SleepTool \} from '\.\/tools\/SleepTool\/SleepTool\.js'/.test(TOOLS) &&
  /const SLEEP_TOOL = cycleTolerant\(\(\) => SleepTool\)/.test(TOOLS))
check('Sleep joins the tool catalog array (the cycle-tolerant row)',
  /SLEEP_TOOL,/.test(TOOLS))

check('built via buildTool against the prompt name', /buildTool\(\{[\s\S]*name:\s*SLEEP_TOOL_NAME/.test(SLEEP))
check('concurrency-safe (isConcurrencySafe → true)',
  /isConcurrencySafe\(\)\s*\{[\s\S]*?return true/.test(SLEEP))
check('read-only (isReadOnly → true)', /isReadOnly\(\)\s*\{[\s\S]*?return true/.test(SLEEP))
check('INTERRUPTIBLE: listens to abortController.signal',
  /abortController/.test(SLEEP) && /signal\.addEventListener\('abort'/.test(SLEEP))
check('resolves early on abort and flags interrupted', /interrupted\s*=\s*true/.test(SLEEP))
check('honest result reports interrupted + slept_seconds',
  /interrupted,/.test(SLEEP) && /slept_seconds:/.test(SLEEP))
check('duration is capped (MAX_SLEEP_SECONDS)', /Math\.min\(seconds,\s*MAX_SLEEP_SECONDS\)/.test(SLEEP))
check('cleans up the timer + listener (no leak)',
  /clearTimeout\(timer\)/.test(SLEEP) && /removeEventListener\('abort'/.test(SLEEP))
check('explicit (unmarked) classifier opt-out — toAutoClassifierInput → ""',
  /toAutoClassifierInput\(\)\s*\{[\s\S]*?return ''/.test(SLEEP))

check("a sub-agent's roster: Sleep is not in the deny set every agent loses",
  !blockOf(ROSTER, 'ALL_AGENT_DISALLOWED_TOOLS').includes('SLEEP_TOOL_NAME'))
check("a BACKGROUND sub-agent's roster keeps the async allow-set alone, and Sleep is in it",
  AGENT_FILTER.includes('if (isAsync) {\n      if (ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) return true') && blockOf(ROSTER, 'ASYNC_AGENT_ALLOWED_TOOLS').includes('SLEEP_TOOL_NAME,'))
check("a sub-agent's wait shadows the background shells it owns, by the spawning agent's id",
  /SUBAGENT_TRACKED_TASK_TYPES[\s\S]*?\['local_bash',/.test(SLEEP) && /SUBAGENT_TRACKED_TASK_TYPES\.has\(t\.type\) && t\.agentId === selfTaskId/.test(SLEEP))
check("the sub-agent's ceiling is the same one (one MAX_SLEEP_SECONDS)",
  (SLEEP.match(/MAX_SLEEP_SECONDS = /g) ?? []).length === 1)

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ Sleep tool — stamp-gated, concurrency-safe, interruptible, honest')
  process.exit(0)
} else {
  console.log(` ❌ Sleep tool — ${failures} invariant(s) broken`)
  process.exit(1)
}
