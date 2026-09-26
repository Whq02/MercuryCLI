#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'sleep-tool-home-'))
delete process.env.MERCURY_HOME

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

console.log('\n— new input for the active turn ends the wait at once —')
{
  const queue = await import('../../src/input-core/command-queue.ts')
  const { SleepTool } = await import('../../src/tools/SleepTool/SleepTool.tsx')
  type SleepResult = { data: { message: string; slept_seconds: number; interrupted: boolean; clamped?: string } }
  const NEW_INPUT = 'new input arrived for this turn (it follows this result)'
  const rig = (abort: AbortController, agentId?: string): never => ({ abortController: abort, getAppState: () => ({ tasks: {} }), agentId }) as never
  let seq = 0
  const line = (value: string, extra: Record<string, unknown> = {}): never => ({ value, mode: 'prompt', uuid: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, ...extra }) as never
  const bounded = (pending: Promise<SleepResult>, ms: number): Promise<SleepResult | null> => Promise.race([pending, new Promise<null>(r => setTimeout(() => r(null), ms))])

  queue.resetCommandQueue()
  const abort60 = new AbortController()
  const at60 = Date.now()
  const wait60 = SleepTool.call({ seconds: 60 }, rig(abort60)) as Promise<SleepResult>
  setTimeout(() => queue.enqueue(line('stop and report what you have')), 100)
  const early = await bounded(wait60, 2_000)
  const elapsed60 = Date.now() - at60
  if (early === null) abort60.abort()
  const released = early ?? (await wait60)
  check('a prompt queued during a 60 s wait ends it within the moment it lands, typed as an interrupt with the new-input reason',
    early !== null && early.data.interrupted === true && early.data.message === `Sleep interrupted after 0s: ${NEW_INPUT}` && early.data.slept_seconds === 0 && elapsed60 < 1_000,
    early === null ? `the wait was still open ${elapsed60} ms after the words landed; released by abort it read ${JSON.stringify(released.data)}` : `${JSON.stringify(early.data)} after ${elapsed60} ms`)
  const kept = queue.getDrainableCommands(false)
  check('the words stay queued for the drain, exactly once — the wait reads the queue and never takes from it',
    kept.length === 1 && kept[0]?.value === 'stop and report what you have', JSON.stringify(kept.map(c => c.value)))
  const text = (SleepTool.mapToolResultToToolResultBlockParam(released.data as never, 'toolu_n') as { content: string }).content
  check('the tool result carries the reason in the interrupt grammar', text.includes(`"message":"Sleep interrupted after 0s: ${NEW_INPUT}"`) && text.includes('"interrupted":true'), text)

  queue.resetCommandQueue()
  const at3 = Date.now()
  const wait3 = SleepTool.call({ seconds: 3 }, rig(new AbortController())) as Promise<SleepResult>
  setTimeout(() => queue.enqueue(line('a second thought')), 100)
  const short = await wait3
  const elapsed3 = Date.now() - at3
  check('a 3 s wait steered at 100 ms does not run its full length',
    short.data.interrupted === true && elapsed3 < 1_000, `the wait ran its full length: ${JSON.stringify(short.data)} after ${elapsed3} ms`)

  queue.resetCommandQueue()
  queue.enqueue(line('queued before the wait began'))
  const abortEntry = new AbortController()
  const atEntry = Date.now()
  const waitEntry = SleepTool.call({ seconds: 60 }, rig(abortEntry)) as Promise<SleepResult>
  const entry = await bounded(waitEntry, 1_000)
  const elapsedEntry = Date.now() - atEntry
  if (entry === null) abortEntry.abort()
  const releasedEntry = entry ?? (await waitEntry)
  check('words already queued when the wait begins end it at entry', entry !== null && entry.data.interrupted === true && entry.data.message === `Sleep interrupted after 0s: ${NEW_INPUT}` && elapsedEntry < 500,
    entry === null ? `the wait was still open ${elapsedEntry} ms after it began with the words already queued; released by abort it read ${JSON.stringify(releasedEntry.data)}` : `${JSON.stringify(entry.data)} after ${elapsedEntry} ms`)

  queue.resetCommandQueue()
  queue.enqueue(line('for the next turn', { priority: 'later' }))
  queue.enqueue(line('/compact'))
  queue.enqueue(line('for another agent', { agentId: 'agent-elsewhere' }))
  queue.enqueue(line('<task-notification>a shell finished</task-notification>', { mode: 'task-notification', priority: 'next' }))
  queue.enqueue(line('ls', { mode: 'bash' }))
  queue.enqueue(line('a channel message', { isMeta: true }))
  const atFull = Date.now()
  const full = (await SleepTool.call({ seconds: 2 }, rig(new AbortController()))) as SleepResult
  const elapsedFull = Date.now() - atFull
  check('a later-band line, a slash command, another agent\'s line, a task notification, a bash line and a meta prompt do not end the wait: it runs its full length',
    full.data.interrupted === false && full.data.message === 'Slept for 2s' && elapsedFull >= 1_950, `${JSON.stringify(full.data)} after ${elapsedFull} ms`)
  check('the drain would take the same view: none of those is an operator prompt for this turn', !queue.getDrainableCommands(false).some(c => c.mode === 'prompt' && queue.isOperatorLine(c) && !queue.isSlashCommand(c) && c.agentId === undefined))

  queue.resetCommandQueue()
  queue.holdQueuedWordsForTurnEnd(true)
  queue.enqueue(line('held until the turn ends'))
  const atHeld = Date.now()
  const held = (await SleepTool.call({ seconds: 1 }, rig(new AbortController()))) as SleepResult
  const elapsedHeld = Date.now() - atHeld
  check('a line the queue holds for the turn boundary does not end the wait', held.data.interrupted === false && elapsedHeld >= 950, `${JSON.stringify(held.data)} after ${elapsedHeld} ms`)
  queue.holdQueuedWordsForTurnEnd(false)

  queue.resetCommandQueue()
  const atSub = Date.now()
  const subWait = SleepTool.call({ seconds: 1 }, rig(new AbortController(), 'agent-1')) as Promise<SleepResult>
  setTimeout(() => queue.enqueue(line('the operator speaks to the chat')), 100)
  const sub = await subWait
  const elapsedSub = Date.now() - atSub
  check("a sub-agent's wait never ends on the operator's words — they are for the chat's turn, not its own", sub.data.interrupted === false && elapsedSub >= 950, `${JSON.stringify(sub.data)} after ${elapsedSub} ms`)

  queue.resetCommandQueue()
  const abortStill = new AbortController()
  setTimeout(() => abortStill.abort(), 60)
  const aborted = (await SleepTool.call({ seconds: 30 }, rig(abortStill))) as SleepResult
  check('the abort road is unchanged, byte for byte', JSON.stringify(aborted.data) === '{"message":"Sleep interrupted after 0s","slept_seconds":0,"interrupted":true}', JSON.stringify(aborted.data))
  queue.resetCommandQueue()
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ Sleep tool — stamp-gated, concurrency-safe, interruptible, honest')
  process.exit(0)
} else {
  console.log(` ❌ Sleep tool — ${failures} invariant(s) broken`)
  process.exit(1)
}
