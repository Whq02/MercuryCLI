;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'runner-life-config-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'runner-life-teams-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_EFFORT_LEVEL
delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE

import { startFixtureApi, type FixtureApi, type ScriptedTurn } from '../../lib/fixtureApi.ts'

export type { FixtureApi, ScriptedTurn }

const { enableConfigs } = await import('../../../src/utils/config.ts')
enableConfigs()
export const bootstrap = await import('../../../src/bootstrap/state.ts')
const projDir = mkdtempSync(join(tmpdir(), 'runner-life-proj-'))
bootstrap.setOriginalCwd(projDir)
bootstrap.setProjectRoot(projDir)

export const { spawnInProcessTeammate, killInProcessTeammate } = await import(
  '../../../src/utils/swarm/spawnInProcess.ts'
)
export const { runInProcessTeammate } = await import('../../../src/utils/swarm/inProcessRunner.ts')
export const { drainSdkEvents } = await import('../../../src/utils/sdkEventQueue.ts')
export const { readMailbox, writeToMailbox, isIdleNotification } = await import(
  '../../../src/utils/teammateMailbox.ts'
)
export const { injectUserMessageToTeammate } = await import(
  '../../../src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx'
)
export const { getEmptyToolPermissionContext } = await import('../../../src/Tool.ts')
export const { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } = await import(
  '../../../src/utils/fileStateCache.ts'
)
export const { getBuiltInAgents } = await import('../../../src/tools/AgentTool/builtInAgents.ts')
export const { resolveTeammateRole } = await import('../../../src/utils/swarm/roleResolver.ts')
export const { deriveTeamCharter } = await import('../../../src/utils/swarm/teamCharter.ts')
export const { ERROR_MESSAGE_USER_ABORT } = await import('../../../src/services/compact/compact.ts')


let failures = 0
export function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
export function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
export function failureCount(): number {
  return failures
}


const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — runner lifecycle proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()
const WALL_CLOCK_SECONDS = 300
if (process.platform !== 'win32') {
  const wallClock = spawn('/bin/sh', ['-c', `sleep ${WALL_CLOCK_SECONDS} && kill -9 ${process.pid}`], { detached: true, stdio: 'ignore' })
  wallClock.unref()
  process.on('exit', () => {
    try {
      if (wallClock.pid !== undefined) process.kill(-wallClock.pid, 'SIGKILL')
    } catch {
    }
  })
}


export type AnyState = Record<string, unknown> & { tasks: Record<string, unknown> }
export type Store = {
  getAppState: () => AnyState
  setAppState: (updater: (prev: AnyState) => AnyState) => void
}

export function makeStore(): Store {
  let state: AnyState = {
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    todos: {},
    agentNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
  }
  return {
    getAppState: () => state,
    setAppState: updater => {
      state = updater(state)
    },
  }
}

export function makeCtx(store: Store): Record<string, unknown> {
  return {
    abortController: new AbortController(),
    getAppState: store.getAppState,
    setAppState: store.setAppState,
    setAppStateForTasks: store.setAppState,
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
    options: {
      tools: [],
      commands: [],
      mcpClients: [],
      mcpResources: {},
      mainLoopModel: 'claude-opus-4-8',
      maxThinkingTokens: 0,
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
      debug: false,
      verbose: false,
    },
  }
}

export type RunResult = { success: boolean; error?: string; messages: unknown[] }

export async function settleWithin(
  promise: Promise<RunResult>,
  s: { api: FixtureApi },
  label: string,
  ms = 45_000,
): Promise<RunResult> {
  const parked = Symbol('parked')
  const timer = new Promise<typeof parked>(resolve => {
    const t = setTimeout(() => resolve(parked), ms)
    t.unref?.()
  })
  const raced = await Promise.race([promise, timer])
  if (raced !== parked) return raced
  return {
    success: false,
    error: `PARKED: ${label} runPromise unsettled after ${ms / 1000}s — the fixture saw ${s.api.messageRequests().length} request(s)`,
    messages: [],
  }
}

export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return true
    if (Date.now() - start > timeoutMs) return false
    await new Promise(r => setTimeout(r, 25))
  }
}

export type TaskView = {
  status: string
  isIdle: boolean
  notified: boolean
  error?: string
  endTime?: number
  messages?: Array<{ type: string; message: { content: unknown } }>
  pendingUserMessages: string[]
  inProgressToolUseIDs?: Set<string>
  abortController?: AbortController
  currentWorkAbortController?: AbortController
  unregisterCleanup?: () => void
  onIdleCallbacks?: Array<() => void>
  identity: { agentId: string; agentName: string; teamName: string; parentSessionId: string }
  toolUseId?: string
}
export const task = (store: Store, id: string): TaskView => store.getAppState().tasks[id] as TaskView

export type SdkEventView = {
  subtype: string
  task_id: string
  status?: string
  tool_use_id?: string
}
export const allDrained: SdkEventView[] = []
export function drainInto(): void {
  allDrained.push(...(drainSdkEvents() as unknown as SdkEventView[]))
}
export const bookendsFor = (taskId: string): SdkEventView[] =>
  allDrained.filter(e => e.subtype === 'task_notification' && e.task_id === taskId)

export async function idleNotificationsFor(
  team: string,
): Promise<Array<{ idleReason?: string; failureReason?: string }>> {
  const msgs = await readMailbox('team-lead', team)
  return msgs
    .map(m => isIdleNotification(m.text))
    .filter(Boolean) as Array<{ idleReason?: string; failureReason?: string }>
}

export type Spawned = {
  api: FixtureApi
  store: Store
  ctx: Record<string, unknown>
  taskId: string
  team: string
  lifecycle: AbortController
  runPromise: Promise<{ success: boolean; error?: string; messages: unknown[] }>
  settled: () => boolean
  rejection: () => unknown
  cleanupCalls: () => number
}

export async function launch(opts: {
  name: string
  team: string
  turns: ScriptedTurn[]
  prompt: string
  description?: string
  replacePrompt?: string
  role?: unknown
  agentDefinition?: unknown
  poisonCtx?: (ctx: Record<string, unknown>) => void
}): Promise<Spawned> {
  const api = await startFixtureApi(opts.turns)
  process.env.ANTHROPIC_BASE_URL = api.url
  const store = makeStore()
  const ctx = makeCtx(store)
  opts.poisonCtx?.(ctx)

  const spawned = await spawnInProcessTeammate(
    {
      name: opts.name,
      teamName: opts.team,
      prompt: opts.prompt,
      planModeRequired: false,
    },
    { setAppState: store.setAppState as never, toolUseId: `toolu_${opts.name}` },
  )
  if (!spawned.success || !spawned.taskId) {
    throw new Error(`spawn failed: ${spawned.error}`)
  }
  const taskId = spawned.taskId

  let cleanupCalls = 0
  store.setAppState(prev => {
    const t = prev.tasks[taskId] as TaskView
    const orig = t.unregisterCleanup
    return {
      ...prev,
      tasks: {
        ...prev.tasks,
        [taskId]: {
          ...t,
          unregisterCleanup: () => {
            cleanupCalls++
            orig?.()
          },
        },
      },
    }
  })

  let settled = false
  let rejection: unknown
  const runPromise = runInProcessTeammate({
    identity: task(store, taskId).identity as never,
    taskId,
    prompt: opts.prompt,
    description: opts.description,
    role: opts.role as never,
    agentDefinition: opts.agentDefinition as never,
    teammateContext: spawned.teammateContext as never,
    toolUseContext: ctx as never,
    abortController: spawned.abortController!,
    allowPermissionPrompts: false,
    ...(opts.replacePrompt
      ? { systemPrompt: opts.replacePrompt, systemPromptMode: 'replace' as const }
      : {}),
  })
  runPromise.then(
    () => {
      settled = true
    },
    err => {
      settled = true
      rejection = err
    },
  )

  return {
    api,
    store,
    ctx,
    taskId,
    team: opts.team,
    lifecycle: spawned.abortController!,
    runPromise,
    settled: () => settled,
    rejection: () => rejection,
    cleanupCalls: () => cleanupCalls,
  }
}
