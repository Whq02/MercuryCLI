#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
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
delete process.env.MERCURY_SHELL_ENGINE
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'timeout-output-')))
process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { TaskStopTool } = await import('../../src/tools/TaskStopTool/TaskStopTool.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const BashToolResultMessage = (await import('../../src/tools/BashTool/BashToolResultMessage.tsx')).default

let appState = getDefaultAppState()
const contextWith = (tools: ReadonlyArray<{ name: string }>, toolUseId: string): unknown => ({
  options: { engineModel: 'claude-sonnet-5', tools, commands: [], mcpClients: [], mcpResources: {} },
  readFileState: new Map(),
  getAppState: () => appState,
  setAppState: (update: (state: typeof appState) => typeof appState) => {
    appState = update(appState)
  },
  abortController: new AbortController(),
  toolUseId,
})
type Out = { stdout: string; backgroundTaskId?: string; timeoutAutoBackgroundedAfterMs?: number; backgroundPid?: number; backgroundLifetime?: string; stopOffered?: boolean }
type Caller = { call: (input: never, context: never) => Promise<{ data: unknown }> }
type Mapper = { mapToolResultToToolResultBlockParam: (output: never, id: string) => { content: unknown; is_error?: boolean } }
const contentOf = (tool: Mapper, out: unknown, id: string): string => {
  const block = tool.mapToolResultToToolResultBlockParam(out as never, id)
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

section('§1 a command that prints and then hangs, timeout 2000: the result carries what it printed and names TaskStop')
const withStop = contextWith([{ name: 'TaskStop' }, { name: 'Bash' }], 'timeout-output-1')
const startedAt = Date.now()
const first = await (BashTool as unknown as Caller).call({ command: 'echo started; while true; do sleep 1; done', timeout: 2000 } as never, withStop as never)
const ms = Date.now() - startedAt
const out = first.data as Out
const content = contentOf(BashTool as unknown as Mapper, out, 'timeout-output-1')
check('the call came back at its timeout, not later', ms >= 1800 && ms < 8000, `${ms} ms`)
check('the result carries a background task id', typeof out.backgroundTaskId === 'string' && /^b[0-9a-z]+$/.test(out.backgroundTaskId), JSON.stringify(out.backgroundTaskId))
check('the result marks the move as timeout-driven at 2000 ms', out.timeoutAutoBackgroundedAfterMs === 2000, String(out.timeoutAutoBackgroundedAfterMs))
check('data.stdout holds the output so far', out.stdout.includes('started'), JSON.stringify(out.stdout))
check('the mapped text starts with the output so far', content.startsWith('started'), JSON.stringify(content.slice(0, 80)))
check('the text keeps `Command timed out after 2s and was moved to the background with ID: b`', content.includes('Command timed out after 2s and was moved to the background with ID: b'), JSON.stringify(content.slice(0, 200)))
check('the text says it was not stopped and where the rest of the output goes', content.includes('; it was not stopped. Its output so far is above; the rest goes to ') && content.includes(`${out.backgroundTaskId}.output`), JSON.stringify(content))
check('the text keeps `absolute deadline of` and states the deadline from now (10× 2 s = 20 s)', content.includes('absolute deadline of 10× the timeout (20s from now), after which it will be killed.'), JSON.stringify(content))
check('the text names TaskStop with the task id as the way to end it now', content.includes(`TaskStop with task_id "${out.backgroundTaskId}" ends it now, with the processes under it.`), JSON.stringify(content))
check("the text says when this session ends it (an open session: a notice after the next tool result or in a new turn)", content.includes('When it ends, a notice reaches you after your next tool result, or in a new turn once yours is over.'), JSON.stringify(content))
check('the text names the two roads for next time', content.includes('Next time, pass a larger `timeout` if it needs longer, or `run_in_background` for a command meant to keep running.'), JSON.stringify(content.slice(-160)))
check('the result is not an error', (BashTool as unknown as Mapper).mapToolResultToToolResultBlockParam(out as never, 'x').is_error !== true)
check('the command is still running after the move (its shell is alive)', typeof out.backgroundPid === 'number' && alive(out.backgroundPid), String(out.backgroundPid))

section('§2 TaskStop on that id ends the command and counts the processes it ended')
const stopped = await (TaskStopTool as unknown as Caller).call({ task_id: out.backgroundTaskId } as never, withStop as never)
const stopData = stopped.data as { message?: string; processes_ended?: number; settled?: boolean }
check('TaskStop reports processes_ended ≥ 1', typeof stopData.processes_ended === 'number' && stopData.processes_ended >= 1, JSON.stringify(stopData))
check('TaskStop settled the task', stopData.settled === true, JSON.stringify(stopData))
await new Promise(resolve => setTimeout(resolve, 300))
check('the shell is gone after the stop', typeof out.backgroundPid === 'number' && !alive(out.backgroundPid), String(out.backgroundPid))

section('§3 the cockpit row says the command runs in the background even though the result has output')
const painted = await renderToString(React.createElement(BashToolResultMessage, { content: out as never, verbose: false }), 100)
check('the output line is painted', painted.includes('started'), JSON.stringify(painted))
check('the `Running in the background` row is painted beside it', painted.includes('Running in the background'), JSON.stringify(painted))
const finished = await renderToString(React.createElement(BashToolResultMessage, { content: { stdout: 'done', stderr: '' } as never, verbose: false }), 100)
check('a finished result with output paints no background row', finished.includes('done') && !finished.includes('Running in the background'), JSON.stringify(finished))

section('§4 the same move without TaskStop in the pool, and a command that has printed nothing')
const noStop = contextWith([{ name: 'Bash' }], 'timeout-output-2')
const quiet = await (BashTool as unknown as Caller).call({ command: 'while true; do sleep 1; done', timeout: 2000 } as never, noStop as never)
const quietOut = quiet.data as Out
const quietText = contentOf(BashTool as unknown as Mapper, quietOut, 'timeout-output-2')
check('a silent command says it has printed nothing yet and where its output goes', quietText.startsWith('Command timed out after 2s and was moved to the background with ID: b') && quietText.includes('; it was not stopped. It has printed nothing yet; its output goes to '), JSON.stringify(quietText.slice(0, 220)))
check('without TaskStop in the pool the text does not name it', !quietText.includes('TaskStop'), JSON.stringify(quietText))
if (typeof quietOut.backgroundTaskId === 'string') await (TaskStopTool as unknown as Caller).call({ task_id: quietOut.backgroundTaskId } as never, noStop as never)

for (const dir of [SCRATCH, proofHome]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    continue
  }
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
