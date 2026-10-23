#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const scratch = mkdtempSync(join(tmpdir(), 'task-stop-own-'))
process.env.MERCURY_CONFIG_DIR = scratch
delete process.env.MERCURY_HOME
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const { TaskStopTool } = await import('../../src/tools/TaskStopTool/TaskStopTool.ts')
const { filterToolsForAgent } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { spawnShellTask } = await import('../../src/tasks/LocalShellTask/LocalShellTask.tsx')
const { wrapSpawn } = await import('../../src/utils/ShellCommand.ts')
const { TaskOutput } = await import('../../src/utils/task/TaskOutput.ts')
const { generateTaskId } = await import('../../src/Task.ts')
const { endProcessTree } = await import('../../src/utils/processGroup.ts')
let state: any = { tasks: {} }
const context: any = { agentId: 'child-a', abortController: new AbortController(), getAppState: () => state, setAppState: (f: any) => { state = f(state) } }
let failures = 0
function check(name: string, ok: boolean, detail?: unknown) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok ? ` ${JSON.stringify(detail)}` : ''}`); if (!ok) failures++ }
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
try {
  const shell = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(generateTaskId('local_bash'), null))
  const own = await spawnShellTask({ command: 'fixture wait', description: 'fixture command', shellCommand: shell, agentId: 'child-a' }, context)
  for (const builtIn of [true, false]) check(`TaskStop is available to ${builtIn ? 'built-in' : 'custom'} crewmates`, filterToolsForAgent({ tools: [TaskStopTool] as any, isBuiltIn: builtIn }).length === 1)
  for (const [id, row] of Object.entries({ sibling: { type: 'local_bash', agentId: 'child-b' }, agent: { type: 'local_agent', agentId: 'child-a' }, ownerless: { type: 'local_bash' }, monitor: { type: 'local_bash', kind: 'monitor', agentId: 'child-b' } })) {
    state.tasks[id] = { ...row, id, status: 'running', description: 'fixture target', command: 'fixture', shellCommand: null }
    const v = await TaskStopTool.validateInput({ task_id: id }, context)
    check(`${id} is rejected at validation`, v.result === false && /own.*command/.test((v as any).message ?? ''), v)
    let refused = false
    try { await TaskStopTool.call({ task_id: id }, context) } catch (e) { refused = /own.*command/.test(String(e)) }
    check(`${id} is rejected again at execution`, refused)
    check(`${id} remains running`, state.tasks[id].status === 'running')
  }
  const v = await TaskStopTool.validateInput({ task_id: own.taskId }, context)
  check('own command validates', v.result)
  const result = await TaskStopTool.call({ task_id: own.taskId }, context)
  check('own command settles with the real stop receipt', result.data.settled === true && result.data.interrupted === true && (result.data.processes_ended ?? 0) > 0, result.data)
  check('parent validation still accepts a sibling command', (await TaskStopTool.validateInput({ task_id: 'sibling' }, { ...context, agentId: undefined })).result)
} finally {
  await endProcessTree(child)
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
