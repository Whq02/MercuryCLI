#!/usr/bin/env bun
import { plugin } from 'bun'
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_SHELL_ENGINE = 'system'
delete process.env.MERCURY_SHELL_MAX_OUTPUT
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'spawn-failure-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })
const posix = (path: string): string => path.replace(/\\/g, '/')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const note = (text: string): void => console.log(`        note: ${text}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const clip = (text: string, limit = 260): string => JSON.stringify(text.length > limit ? `${text.slice(0, limit)}…` : text)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the spawn-failure proof exceeded 240s; a step is hanging, look for the last section header printed above and the command it ran (exec in src/platform/shell/shellExec.ts, or the tool under test)')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

console.log('============================================================')
console.log(' Shell spawn failure — a command that never started is not an interruption')
console.log('============================================================')

const OVERSIZE = 1_200_000
const REFUSAL = /ENAMETOOLONG|E2BIG/
const oversized = `: ${'x'.repeat(OVERSIZE)}; echo reached-the-end`

const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { PowerShellTool } = await import('../../src/tools/powershell/PowerShellTool.tsx')
const { MonitorTool } = await import('../../src/tools/monitor/MonitorTool.ts')
const { exec } = await import('../../src/platform/shell/shellExec.ts')
const { formatError } = await import('../../src/tools/kit/toolErrors.ts')
const { INTERRUPT_MESSAGE } = await import('../../src/engine/message-shapes/turnCut.ts')
const { isDenialResultText } = await import('../../src/engine/message-shapes/rejectionText.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { getSessionId, setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
const { runToolUse } = await import('../../src/engine/tool-dispatch/toolExecution.ts')
const { addSessionHooks } = await import('../../src/integrations/event-hooks/sessionHooks.ts')
const { createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
const { buildMessageLookups } = await import('../../src/engine/messages/lookups.ts')
const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.ts')
const { toolResultRowsOf } = await import('../../src/engine/rows/project.ts')
const { findTaskOutcome } = await import('../../src/engine/tasks/taskOutcomeEnvelope.ts')
const { processBashCommand } = await import('../../src/engine/user-input/processBashCommand.tsx')
const { getCachedPowerShellPath } = await import('../../src/platform/shell/powershellDetection.ts')
setIsInteractive(false)

let appState = getDefaultAppState()
const setAppState = (update: (state: typeof appState) => typeof appState): void => {
  appState = update(appState)
}
const makeContext = (controller: AbortController = new AbortController()): never =>
  ({
    options: { commands: [], verbose: false, engineModel: 'claude-sonnet-5', tools: [BashTool], mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
    abortController: controller,
    readFileState: new Map(),
    getAppState: () => appState,
    setAppState,
    messages: [],
    setResponseLength: () => undefined,
    updateFileHistoryState: () => undefined,
    updateAttributionState: () => undefined,
    toolUseId: 'spawn-failure',
  }) as never

type ToolLike = {
  call: (input: never, context: never) => Promise<{ data: unknown }>
  mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown; is_error?: boolean }
}
type Thrown = { threw: boolean; interrupted?: boolean; ran?: boolean; model: string }
async function failure(tool: ToolLike, input: Record<string, unknown>): Promise<Thrown> {
  try {
    await tool.call(input as never, makeContext())
  } catch (error) {
    const shell = error as { interrupted?: boolean; ran?: boolean }
    return { threw: true, interrupted: shell.interrupted, ran: shell.ran, model: formatError(error) }
  }
  return { threw: false, model: '(no throw)' }
}

section('§1 the exec seam: a spawn the platform refuses settles as a command that never ran')
{
  const handle = await exec(oversized, new AbortController().signal, 'bash', { timeout: 20_000, shouldAutoBackground: false })
  const settled = await handle.result
  note(`status ${handle.status}, code ${settled.code}, interrupted ${settled.interrupted}, stderr ${clip(settled.stderr, 120)}`)
  check('the oversized command is refused by the platform inside the spawn call itself, before any shell runs', REFUSAL.test(settled.stderr), `${clip(settled.stderr)} — the spawn of the oversized command should fail with ENAMETOOLONG or E2BIG; check exec in src/platform/shell/shellExec.ts and that OVERSIZE still exceeds the platform limit`)
  check('the refusal is typed as a command that never ran: preSpawnError carries it', typeof settled.preSpawnError === 'string' && REFUSAL.test(settled.preSpawnError), `${JSON.stringify(settled.preSpawnError)} — a refused spawn must settle through createFailedCommand in src/platform/shell/shellProcess.ts with the platform error in preSpawnError`)
  check('it is not an interruption: interrupted is false and the handle never reads killed', settled.interrupted === false && handle.status !== 'killed', `interrupted ${settled.interrupted}, status ${handle.status} — a spawn the platform refuses must not be marked interrupted or killed; see createFailedCommand in src/platform/shell/shellProcess.ts`)
  check('nothing ran: no output reached the result', settled.stdout === '', clip(settled.stdout))
  const aborted = new AbortController()
  aborted.abort('interrupt')
  const pre = await exec('echo never', aborted.signal, 'bash', { timeout: 20_000, shouldAutoBackground: false })
  const preSettled = await pre.result
  check('control: an operator abort before the spawn is still an interruption, killed and untyped', preSettled.interrupted === true && pre.status === 'killed' && preSettled.preSpawnError === undefined, `${JSON.stringify({ interrupted: preSettled.interrupted, status: pre.status, preSpawnError: preSettled.preSpawnError })} — an abort before the spawn must stay interrupted and killed with no preSpawnError; see exec in src/platform/shell/shellExec.ts`)
}

section('§2 the Bash tool: what the model reads')
{
  const bash = BashTool as unknown as ToolLike
  const refused = await failure(bash, { command: oversized })
  note(`the model reads ${clip(refused.model, 200)}`)
  check('the call fails: an error result, never a quiet success', refused.threw, 'BashTool.call must throw a ShellError when the result carries a preSpawnError; see src/tools/shell/BashTool.tsx')
  check('the failure says the command never ran: not interrupted, ran false', refused.interrupted === false && refused.ran === false, `${JSON.stringify({ interrupted: refused.interrupted, ran: refused.ran })} — the ShellError thrown for a preSpawnError in src/tools/shell/BashTool.tsx must carry interrupted false and ran false`)
  check('the words name the cause the platform gave', REFUSAL.test(refused.model), clip(refused.model))
  check('the headline is the failure headline the product already uses', refused.model.startsWith('Shell command failed'), `${clip(refused.model)} — the model text comes from formatError in src/tools/kit/toolErrors.ts for the ShellError thrown by src/tools/shell/BashTool.tsx`)
  check('no user interruption is claimed', !refused.model.includes(INTERRUPT_MESSAGE) && !/interrupted by user/i.test(refused.model), `${clip(refused.model)} — a command that never started must not read as a user interruption; see formatError in src/tools/kit/toolErrors.ts`)
  check('no exit line is invented for a shell that never started', !/Exited with code/.test(refused.model), `${clip(refused.model)} — no exit line may be printed when there was no shell; see formatError in src/tools/kit/toolErrors.ts`)
  check("the cockpit's denial reader does not take the result for a stop", isDenialResultText(refused.model) === false, `${clip(refused.model)} — isDenialResultText in src/engine/message-shapes/rejectionText.ts must not match this failure text`)
  const lookup = await failure(bash, { command: `${oversized}; grep -c zzz /dev/null` })
  check('a lookup command whose exit 1 is an answer is still a failure when it never started: not "no matches found"', lookup.threw && REFUSAL.test(lookup.model) && !/no matches found/.test(lookup.model), `${clip(lookup.model)} — the preSpawnError throw in src/tools/shell/BashTool.tsx must come before any exit-1-is-a-result reading`)
  const ordinary = await failure(bash, { command: 'echo before; exit 3' })
  check('control: a command that ran and failed keeps its exit words', ordinary.model.startsWith('Shell command failed (exit code 3)') && /Exited with code 3/.test(ordinary.model) && ordinary.interrupted === false && ordinary.ran === true, `${clip(ordinary.model)} — a command that ran and failed must keep its failure headline and exit line; see formatError in src/tools/kit/toolErrors.ts and src/tools/shell/BashTool.tsx`)
  const stopped = new AbortController()
  stopped.abort('interrupt')
  const returned = (await bash.call({ command: 'echo never' } as never, makeContext(stopped))).data as { interrupted?: boolean }
  const block = bash.mapToolResultToToolResultBlockParam(returned as never, 'spawn-failure')
  check('control: a command stopped by the operator before it started still comes back interrupted', returned.interrupted === true && block.is_error === true && /aborted before completion/.test(String(block.content)), `${JSON.stringify({ interrupted: returned.interrupted, block }).slice(0, 300)} — an abort before the call must still return interrupted with the aborted-before-completion error block; see src/tools/shell/BashTool.tsx`)
}

section('§3 the tool pipeline: result, row, cockpit lookups and hooks around the same failure')
{
  const hookDir = join(SCRATCH, 'hooks')
  mkdirSync(hookDir, { recursive: true })
  const recorder = (event: string): string => posix(join(hookDir, `${event}.jsonl`))
  addSessionHooks(setAppState as never, { sessionId: String(getSessionId()) }, { 'tool.after': [{ name: 'recorder', match: 'Bash', run: `cat >> ${recorder('tool.after')}; echo >> ${recorder('tool.after')}` }] } as never, { kind: 'agent', type: 'spawn-rig' })
  const gate = (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never
  const context = makeContext()
  const id = 'toolu_spawn_failure'
  const block = { type: 'tool_use' as const, id, name: 'Bash', input: { command: oversized } }
  const assistant = createAssistantMessage({ content: [block as never], isVirtual: true })
  const updates: Array<{ message?: { type?: string; toolUseResult?: unknown; message?: { content?: unknown } }; shellRun?: unknown }> = []
  for await (const update of runToolUse(block as never, assistant, gate, context)) updates.push(update as never)
  const results: Array<{ text: string; isError: boolean; toolUseResult: unknown; shellRun: unknown; content: unknown }> = []
  for (const update of updates) {
    const message = update.message
    if (!message || message.type !== 'user' || !Array.isArray(message.message?.content)) continue
    for (const part of message.message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (part.type !== 'tool_result' || part.tool_use_id !== id) continue
      const text = typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? (part.content as Array<{ text?: string }>).map(piece => piece.text ?? '').join('') : ''
      results.push({ text, isError: part.is_error === true, toolUseResult: message.toolUseResult, shellRun: update.shellRun, content: message.message.content })
    }
  }
  const result = results[0]
  note(`the tool result reads ${clip(result?.text ?? '(none)', 200)}`)
  check('one result reaches the model, and it is an error result', results.length === 1 && result?.isError === true, `${results.length} result(s) — runToolUse in src/engine/tool-dispatch/toolExecution.ts must yield exactly one error tool_result for the failed call`)
  check('it carries the cause and claims neither an interruption nor an exit line', result !== undefined && REFUSAL.test(result.text) && !result.text.includes(INTERRUPT_MESSAGE) && !/Exited with code/.test(result.text), `${clip(result?.text ?? '')} — the error result must carry the platform cause and no interruption or exit line; see runToolUse in src/engine/tool-dispatch/toolExecution.ts`)
  check("the result's own summary and the shell-run fact keep their shape: the failure headline, and no fact for a command that never ran", result?.toolUseResult === 'Error: Shell command failed' && result.shellRun === undefined, `${JSON.stringify({ toolUseResult: result?.toolUseResult, shellRun: result?.shellRun })} — runToolUse in src/engine/tool-dispatch/toolExecution.ts must set toolUseResult to the failure headline and leave shellRun unset`)
  const rows = result === undefined ? [] : (toolResultRowsOf({ session_id: 'spawn-failure', turn: 1 } as never, result.content) as Array<{ type: string; status: string; output: string }>)
  check('the transcript row reads status error', rows.length === 1 && rows[0]?.type === 'tool_result' && rows[0]?.status === 'error', `${JSON.stringify(rows.map(row => ({ type: row.type, status: row.status })))} — toolResultRowsOf in src/engine/rows/project.ts must give one tool_result row with status error`)
  const raw = [assistant, ...updates.map(update => update.message).filter(message => message !== undefined)] as never[]
  const lookups = buildMessageLookups(normalizeMessages(raw as never) as never, raw as never)
  check('the cockpit lookups read the call as an error', lookups.resolvedToolUseIDs.has(id) && lookups.erroredToolUseIDs.has(id), 'buildMessageLookups in src/engine/messages/lookups.ts must list the call in resolvedToolUseIDs and erroredToolUseIDs')
  check('…and not as a denied or interrupted one', !lookups.deniedToolUseIDs.has(id), `${[...lookups.deniedToolUseIDs].join(',')} — buildMessageLookups in src/engine/messages/lookups.ts must not list a failed call in deniedToolUseIDs`)
  const fired = (event: string): Array<Record<string, unknown>> => {
    const file = join(hookDir, `${event}.jsonl`)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(entry => entry.call_id === id)
  }
  for (let waited = 0; fired('tool.after').length < 1 && waited < 5_000; waited += 100) await sleep(100)
  const failureFires = fired('tool.after')
  check('tool.after fires once with ok false, reading the failure headline and no cut', failureFires.length === 1 && failureFires[0]?.ok === false && failureFires[0]?.error === 'Shell command failed' && failureFires[0]?.cut === false && failureFires[0]?.tool === 'Bash', `${JSON.stringify(failureFires)} — the tool.after announcement in src/engine/tool-dispatch/toolExecution.ts must carry ok false, the failure headline and cut false for a failed call`)
}

section('§4 a background launch that never started')
{
  const bash = BashTool as unknown as ToolLike
  const before = new Set(Object.keys(appState.tasks))
  const refused = await failure(bash, { command: oversized, run_in_background: true })
  check('the launch answers with the same failure: the cause, no interruption, no exit line', refused.threw && REFUSAL.test(refused.model) && !refused.model.includes(INTERRUPT_MESSAGE) && !/Exited with code/.test(refused.model), `${clip(refused.model)} — a background launch that never started must throw the same ShellError as a foreground one; see src/tools/shell/BashTool.tsx`)
  const taskId = Object.keys(appState.tasks).find(key => !before.has(key))
  const task = taskId === undefined ? undefined : (appState.tasks[taskId] as unknown as { status?: string; result?: { interrupted?: boolean } })
  check('the board task reads failed and not interrupted', task?.status === 'failed' && task.result?.interrupted === false, `${JSON.stringify(task === undefined ? null : { status: task.status, result: task.result })} — the board task of a launch that never started must settle failed and not interrupted; see the background path in src/tools/shell/BashTool.tsx`)
  let envelope: Awaited<ReturnType<typeof findTaskOutcome>>
  for (let waited = 0; taskId !== undefined && waited < 10_000; waited += 50) {
    envelope = await findTaskOutcome(getSessionId(), taskId)
    if (envelope) break
    await sleep(50)
  }
  note(`the outcome record: ${JSON.stringify({ state: envelope?.state, interrupted: envelope?.interrupted, terminationReason: envelope?.terminationReason })}`)
  check('the outcome record is a failure, not a stop by the user', envelope?.state === 'failed' && envelope.interrupted === false && envelope.terminationReason === undefined, `${JSON.stringify({ state: envelope?.state, interrupted: envelope?.interrupted, terminationReason: envelope?.terminationReason, exitCode: envelope?.exitCode })} — the outcome record (findTaskOutcome in src/engine/tasks/taskOutcomeEnvelope.ts) must read failed, not interrupted, with no terminationReason`)
}

section('§5 the PowerShell tool shares the road')
{
  const powershell = await getCachedPowerShellPath()
  if (powershell === null) {
    console.log('  [SKIP] no PowerShell on this host — the PowerShell tool is not enabled here')
  } else {
    const refused = await failure(PowerShellTool as unknown as ToolLike, { command: oversized })
    note(`the model reads ${clip(refused.model, 200)}`)
    check('the call fails and the words name the cause the platform gave', refused.threw && REFUSAL.test(refused.model), `${clip(refused.model)} — PowerShellTool must throw a ShellError carrying the preSpawnError; see src/tools/powershell/PowerShellTool.tsx`)
    check('no user interruption is claimed and the failure is not marked interrupted', refused.interrupted === false && !refused.model.includes(INTERRUPT_MESSAGE), `${JSON.stringify({ interrupted: refused.interrupted, model: refused.model.slice(0, 160) })} — a refused spawn must not read as an interruption; see src/tools/powershell/PowerShellTool.tsx`)
    check("the cockpit's denial reader does not take it for a stop", isDenialResultText(refused.model) === false, `${clip(refused.model)} — isDenialResultText in src/engine/message-shapes/rejectionText.ts must not match this failure text`)
  }
}

section('§6 a user-typed command that never started')
{
  const outcome = await processBashCommand(oversized, [], [], makeContext(), (() => undefined) as never)
  const texts = (outcome.messages as Array<{ message?: { content?: unknown } }>).map(message => (typeof message.message?.content === 'string' ? message.message.content : JSON.stringify(message.message?.content)))
  const answered = texts.filter(text => !text.startsWith('<local-command-caveat>') && !text.startsWith('<bash-input>'))
  note(`the transcript answers ${clip(answered.join(' | '), 200)}`)
  check('the answer is not an interruption the user never made', !answered.some(text => text.includes(INTERRUPT_MESSAGE)), `${clip(answered.join(' | '))} — a user-typed command that never started must not be answered with an interruption; see processBashCommand in src/engine/user-input/processBashCommand.tsx`)
  check("the answer is the command's stderr carrying the cause", answered.some(text => text.includes('<bash-stderr>') && REFUSAL.test(text)), `${clip(answered.join(' | '))} — processBashCommand in src/engine/user-input/processBashCommand.tsx must answer with a bash-stderr block carrying the platform cause`)
}

section('§7 Monitor never announces a command the platform could not start')
{
  const refused = await failure(MonitorTool as unknown as ToolLike, { command: oversized, description: 'oversize proof', timeout_ms: 60_000 })
  check('Monitor refuses instead of announcing a start', refused.threw && !refused.model.includes('Monitor started'), `${clip(refused.model)} — MonitorTool must throw when the result has a preSpawnError; see src/tools/monitor/MonitorTool.ts`)
  check('Monitor names the command-line limit', /command.line.*(?:limit|too long)/i.test(refused.model), `${clip(refused.model)} — the refusal text MonitorTool throws (src/tools/monitor/MonitorTool.ts) must name the command-line limit`)
  check('Monitor reports no user interruption and no running command', refused.interrupted === false && refused.ran === false, `${clip(refused.model)} — the ShellError thrown in src/tools/monitor/MonitorTool.ts must carry interrupted false and ran false`)
}

clearTimeout(watchdog)
rmSync(SCRATCH, { recursive: true, force: true })
rmSync(process.env.MERCURY_CONFIG_DIR as string, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL SPAWN-FAILURE PROOFS PASS' : `\n${failures} SPAWN-FAILURE PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
