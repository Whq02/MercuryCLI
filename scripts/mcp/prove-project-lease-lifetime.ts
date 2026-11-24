#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'bun:test'
import type { TurnParams } from '../../src/engine/turnDoor.ts'
import type { ToolUseContext } from '../../src/tools/kit/tool.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(proofHome, 'work')
const secondRoot = join(proofHome, 'second')
mkdirSync(root, { recursive: true })
mkdirSync(secondRoot, { recursive: true })
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setOriginalCwd(root)
bootstrap.setProjectRoot(root)
bootstrap.setCwdState(root)
bootstrap.switchSession('00000000-0000-4000-8000-000000000046' as never, root)
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { beginCrewmateProjectLeases, projectLeaseHolder, takeProjectLeases, releaseProjectLeases, listProjectLeases } = await import('../../src/integrations/vulcan/engine/leases.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { registerAsyncCrewmate, killAsyncCrewmate } = await import('../../src/engine/tasks/local-agent/crewmateTask.tsx')
const realQuery = await import('../../src/engine/turnDoor.ts')
const modes = new Map<string, string>()
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${JSON.stringify(detail)}; fix the agent lease lifetime in beginAgentProjectLeases and takeProjectLeases (src/integrations/vulcan/engine/leases.ts) and where runAgent starts and ends it (src/tools/crewmate/runCrewmate.ts)` : ''}`)
}
mock.module('../../src/engine/turnDoor.ts', () => ({
  ...realQuery,
  turnDoor: async function* (params: TurnParams) {
    const id = params.toolUseContext.agentId!
    const result = await takeProjectLeases(root, [`${id}.ts`], projectLeaseHolder(id))
    check(`${id}: the running agent takes its lease`, result.ok, result)
    yield createAssistantMessage({ content: 'Lease acquired.' })
    if (modes.get(id) === 'failure') throw new Error('lease fixture failure')
  },
}))
const { runCrewmate } = await import('../../src/tools/crewmate/runCrewmate.ts')
const MODEL = 'claude-opus-4-8'
const definition = { agentType: 'lease-proof', whenToUse: 'lease fixture', source: 'projectSettings', omitProjectInstructions: true, getSystemPrompt: () => 'Lease fixture.' } as never
const allow = (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input })) as never
const paths = async (at = root): Promise<string[]> => (await listProjectLeases(at)).map(lease => lease.path).sort()
function launch(agentId: string, mode: string) {
  modes.set(agentId, mode)
  let state = getDefaultAppState()
  const setAppState = (update: (prev: typeof state) => typeof state): void => { state = update(state) }
  const task = registerAsyncCrewmate({ agentId, description: 'lease fixture', prompt: 'Lease fixture.', setAppState })
  const controller = task.abortController!
  const context = {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: MODEL, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => state,
    setAppState,
    setAppStateForTasks: setAppState,
    messages: [],
    startTurn: realQuery.turnDoor,
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
  const stream = runCrewmate({ agentDefinition: definition, promptMessages: [createUserMessage({ content: 'Lease fixture.' })], toolUseContext: context, canUseTool: allow, isAsync: true, canShowPermissionPrompts: false, querySource: 'agent:custom:lease-proof' as never, availableTools: [], model: MODEL, override: { agentId, abortController: controller, systemPrompt: ['Lease fixture.'], userContext: {}, systemContext: {} }, cwd: root })
  return { stream, controller, setAppState }
}
async function firstLease(run: ReturnType<typeof launch>): Promise<void> {
  for (;;) {
    const row = await run.stream.next()
    if (row.done) throw new Error('agent ended before acquiring its lease')
    if (row.value.type === 'assistant') return
  }
}
async function drain(run: ReturnType<typeof launch>): Promise<string> {
  try {
    for await (const _row of run.stream) {}
    return ''
  } catch (error) {
    return String(error)
  }
}
const foreign = { ...projectLeaseHolder('success'), sessionId: 'other-session' }
try {
  await takeProjectLeases(root, ['main.ts'], projectLeaseHolder())
  await takeProjectLeases(root, ['sibling.ts'], projectLeaseHolder('sibling'))
  await takeProjectLeases(root, ['foreign.ts'], foreign)
  for (const mode of ['success', 'failure', 'interrupt', 'kill', 'return']) {
    const run = launch(mode, mode)
    await firstLease(run)
    check(`${mode}: the lease exists before the end`, (await paths()).includes(`${mode}.ts`))
    if (mode === 'interrupt') run.controller.abort('operator-interrupt')
    if (mode === 'kill') killAsyncCrewmate(mode, run.setAppState)
    if (mode === 'interrupt' || mode === 'kill') {
      check(`${mode}: abort frees the lease before the stream unwinds`, !(await paths()).includes(`${mode}.ts`))
    }
    let error = ''
    if (mode === 'return') await run.stream.return()
    else error = await drain(run)
    check(`${mode}: the expected end road ran`, mode === 'failure' ? error.includes('lease fixture failure') : mode === 'interrupt' || mode === 'kill' ? error.includes('abort') || error.includes('Abort') : error === '', error)
    check(`${mode}: the agent's lease is gone without a hook`, !(await paths()).includes(`${mode}.ts`))
    check(`${mode}: remaining leases are exactly the other holders`, JSON.stringify(await paths()) === '["foreign.ts","main.ts","sibling.ts"]', await paths())
  }

  const resumed = launch('success', 'success')
  await firstLease(resumed)
  check('a completed agent can take leases after resume', (await paths()).includes('success.ts'))
  check('the resumed run settles', await drain(resumed) === '')
  check('resume cleanup leaves another session with the same agent id untouched', JSON.stringify(await paths()) === '["foreign.ts","main.ts","sibling.ts"]', await paths())

  const predecessor = launch('handover', 'success')
  await firstLease(predecessor)
  const successor = launch('handover', 'success')
  await firstLease(successor)
  await predecessor.stream.return()
  check('a predecessor unwind leaves its successor leases intact', (await paths()).includes('handover.ts'))
  predecessor.controller.abort()
  check('a predecessor abort leaves its successor leases intact', (await paths()).includes('handover.ts'))
  await successor.stream.return()
  check('the successor releases its leases at its own end', !(await paths()).includes('handover.ts'))

  const controller = new AbortController()
  const end = beginCrewmateProjectLeases('pending', controller.signal)
  const holder = projectLeaseHolder('pending')
  const pending = takeProjectLeases(root, ['pending.ts'], holder).then(() => '', error => String(error))
  controller.abort()
  const resumedController = new AbortController()
  const endResumed = beginCrewmateProjectLeases('pending', resumedController.signal)
  check('an in-flight take from an aborted lifetime cannot land after resume', (await pending).includes('agent has ended') && !(await paths()).includes('pending.ts'))
  await end()
  check('a resumed lifetime takes new leases', (await takeProjectLeases(root, ['pending-new.ts'], holder)).ok)
  await takeProjectLeases(secondRoot, ['second.ts'], holder)
  await endResumed()
  check('ending a lifetime releases every project it touched', !(await paths()).includes('pending-new.ts') && (await paths(secondRoot)).length === 0)
  const late = await takeProjectLeases(root, ['late.ts'], holder).then(() => '', error => String(error))
  check('a late take after the agent ended is refused', late.includes('agent has ended') && !(await paths()).includes('late.ts'), late)
} finally {
  await releaseProjectLeases(root, foreign)
  const { runCleanupFunctions } = await import('../../src/platform/processes/cleanupRegistry.ts')
  await runCleanupFunctions()
  mock.restore()
  try {
    removeScratch(proofHome, { maxRetries: 4, retryDelayMs: 50 })
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
  }
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
