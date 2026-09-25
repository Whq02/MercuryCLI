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
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
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
check('duration is bounded (MIN_SLEEP_SECONDS..MAX_SLEEP_SECONDS) through the shared wait-ceiling seam, and the result says when it was',
  /clampWait\('seconds', seconds, MIN_SLEEP_SECONDS, MAX_SLEEP_SECONDS, 's'\)/.test(SLEEP) && /clamped: z\.string\(\)\.optional\(\)/.test(SLEEP))
check('the floor is one real second — never a no-op wait', /const MIN_SLEEP_SECONDS = 1\n/.test(SLEEP))
check('the seconds schema refuses only what has no lawful reading: no .max(), no .positive() — a finite non-negative number always parses',
  /seconds: semanticNumber\(z\.number\(\)\.min\(0\)\)/.test(SLEEP) && !/seconds: semanticNumber\(z\.number\(\)[^)]*\.max\(/.test(SLEEP))
check("the seconds parameter's own words name both bounds and say a value outside them is clamped",
  /seconds: semanticNumber\([\s\S]{0,400}?min \$\{MIN_SLEEP_SECONDS\}, max \$\{MAX_SLEEP_SECONDS\}[\s\S]{0,200}?clamped/.test(SLEEP))
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

{
  const { formatZodValidationError } = await import('../../src/utils/toolErrors.ts')
  const { SleepTool } = await import('../../src/tools/SleepTool/SleepTool.tsx')
  const refusal = (r: { success: boolean; error?: unknown }): string => (r.success ? '' : `InputValidationError: ${formatZodValidationError('Sleep', r.error as never).replace(/\n/g, ' ')}`)
  const above = SleepTool.inputSchema.safeParse({ seconds: 4000 })
  check('a wait of 4000 s passes the schema — no round trip lost to a refusal', above.success === true, refusal(above))
  const negative = SleepTool.inputSchema.safeParse({ seconds: -5 })
  check('a negative wait has no lawful reading and keeps its typed refusal', negative.success === false && refusal(negative).includes('must have a minimum of 0'), refusal(negative))
  const abort = new AbortController()
  const context = { abortController: abort, getAppState: () => ({ tasks: {} }), agentId: undefined } as never
  setTimeout(() => abort.abort(), 60)
  const clamped = (await SleepTool.call({ seconds: 4000 }, context)) as { data: { message: string; slept_seconds: number; interrupted: boolean; clamped?: string } }
  check('a wait above the ceiling runs clamped and its result says so in the ScheduleWakeup grammar', clamped.data.interrupted === true && clamped.data.clamped === 'seconds clamped to 3600 s (the maximum)', JSON.stringify(clamped.data))
  const clampedText = (SleepTool.mapToolResultToToolResultBlockParam(clamped.data as never, 'toolu_s') as { content: string }).content
  check('the tool result text carries the clause', clampedText.includes('"clamped":"seconds clamped to 3600 s (the maximum)"'), clampedText)
  const plainAbort = new AbortController()
  setTimeout(() => plainAbort.abort(), 60)
  const plain = (await SleepTool.call({ seconds: 30 }, { ...(context as object), abortController: plainAbort } as never)) as { data: Record<string, unknown> }
  const plainText = (SleepTool.mapToolResultToToolResultBlockParam(plain.data as never, 'toolu_t') as { content: string }).content
  check('a wait at or below the ceiling carries no clamp field and no clause — byte for byte as before', !('clamped' in plain.data) && plainText === '{"message":"Sleep interrupted after 0s","slept_seconds":0,"interrupted":true}', plainText)
  const startedAt = Date.now()
  const zero = (await SleepTool.call({ seconds: 0 }, { ...(context as object), abortController: new AbortController() } as never)) as { data: { message: string; slept_seconds: number; interrupted: boolean; clamped?: string } }
  const elapsedMs = Date.now() - startedAt
  check('a wait of 0 s is never a no-op: it clamps up to the one-second floor, the timer really arms for 1 s, and the result says so',
    zero.data.interrupted === false && zero.data.slept_seconds === 1 && zero.data.message === 'Slept for 1s' && zero.data.clamped === 'seconds clamped to 1 s (the minimum)' && elapsedMs >= 950 && elapsedMs < 3000,
    `${JSON.stringify(zero.data)} after ${elapsedMs} ms`)
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ Sleep tool — stamp-gated, concurrency-safe, interruptible, honest')
  process.exit(0)
} else {
  console.log(` ❌ Sleep tool — ${failures} invariant(s) broken`)
  process.exit(1)
}
