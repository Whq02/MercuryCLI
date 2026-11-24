#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'convergence-s28-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'convergence-s28-daemon-'))
for (const k of [
  'MERCURY_BARE',
  'MERCURY_EFFORT_LEVEL',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { turnDoorEvents } = await import('../../src/engine/turnDoor.ts')
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const qm = await import('../../src/daemon/runner/messageQueueManager.ts')
const plane = await import('../../src/engine/execution-plane/executionPlane.ts')
const coordinator = await import('../../src/engine/run/runCoordinator.ts')
const lifecycle = await import('../../src/engine/run-owner/ownerLifecycle.ts')
const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')

const MODEL = 'claude-opus-4-8'
let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — 100 turns exceeded 120s; a turn of queryEvents in src/engine/turnDoor.ts never finished, look at the last turn shape that ran')
  process.exit(1)
}, 120_000)
guard.unref?.()

console.log('============================================================')
console.log(' S28 — 100 mixed turns ⇒ zero accumulated live resources')
console.log('============================================================')

type TurnShape = 'text' | 'tool' | 'abort-stream' | 'abort-tools' | 'steer'

function makeTool(onCall?: () => void): unknown {
  return {
    name: 'EchoTool',
    async isEnabled() {
      return true
    },
    isConcurrencySafe() {
      return true
    },
    isReadOnly() {
      return true
    },
    inputSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) },
    async description() {
      return 'echo'
    },
    async prompt() {
      return 'echo'
    },
    userFacingName: () => 'EchoTool',
    async checkPermissions(input: unknown) {
      return { behavior: 'allow', updatedInput: input }
    },
    renderToolUseMessage: () => '',
    renderToolResultMessage: () => null,
    renderToolUseErrorMessage: () => null,
    renderToolUseProgressMessage: () => null,
    async validateInput() {
      return { result: true }
    },
    call: async () => {
      onCall?.()
      return { data: 'echo:ok' }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  }
}

let uuidN = 0
const nextUuid = (): string =>
  `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`

type TurnEvidence = { calls: number; toolRan: boolean; aborted: boolean; abortedDuringStream: boolean }
async function runTurn(n: number, shape: TurnShape): Promise<TurnEvidence> {
  const abortController = new AbortController()
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  let toolAborted = false
  let toolRan = false
  let abortedDuringStream = false
  const tool = makeTool(() => {
    toolRan = true
    if (shape === 'abort-tools' && !toolAborted) {
      toolAborted = true
      abortController.abort()
    }
  })
  const ctx: Record<string, unknown> = {
    abortController,
    options: {
      commands: [],
      tools: [tool],
      engineModel: MODEL,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never) => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(50),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }

  if (shape === 'steer') {
    qm.enqueue({ value: `steer-${n}`, mode: 'prompt', uuid: nextUuid() } as never)
  }

  let call = 0
  async function* callModel(): AsyncGenerator<unknown> {
    call++
    if (shape === 'abort-stream' && call === 1) {
      yield createAssistantMessage({ content: `partial-${n}` })
      abortController.abort()
      abortedDuringStream = true
      return
    }
    if (shape === 'text' || (shape !== 'tool' && shape !== 'steer' && call > 1)) {
      yield createAssistantMessage({ content: `reply-${n}-${call}` })
      return
    }
    if (call === 1) {
      yield createAssistantMessage({
        content: [{ type: 'tool_use', id: `tu-${n}`, name: 'EchoTool', input: { text: 'x' } }] as never,
      })
      return
    }
    yield createAssistantMessage({ content: `after-tools-${n}` })
  }

  const gen = turnDoorEvents({
    messages: [createUserMessage({ content: `turn-${n}` })] as never,
    systemPrompt: ['s28 rig'] as never,
    userContext: {},
    systemContext: {},
    canUseTool: (async () => ({ behavior: 'allow' })) as never,
    toolUseContext: ctx as never,
    querySource: 'sdk' as never,
    deps: {
      callModel: callModel as never,
      autocompact: (async (msgs: unknown[]) => ({
        compactionResult: undefined,
        consecutiveFailures: undefined,
        consecutiveRapidRefills: undefined,
        rapidRefillBreakerTripped: false,
      })) as never,
      microcompact: (async (msgs: unknown[]) => ({ messages: msgs })) as never,
      uuid: nextUuid,
    } as never,
  })
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return { calls: call, toolRan, aborted: abortController.signal.aborted, abortedDuringStream }
}

const shapeHolds = (shape: TurnShape, e: TurnEvidence): boolean => {
  switch (shape) {
    case 'text': return e.calls === 1 && !e.toolRan && !e.aborted
    case 'tool': return e.calls === 2 && e.toolRan && !e.aborted
    case 'abort-stream': return e.calls === 1 && !e.toolRan && e.aborted && e.abortedDuringStream
    case 'abort-tools': return e.calls === 1 && e.toolRan && e.aborted && !e.abortedDuringStream
    case 'steer': return e.calls >= 2 && e.toolRan && !e.aborted
  }
}

const SHAPES: TurnShape[] = ['text', 'tool', 'abort-stream', 'abort-tools', 'steer']
const owner = processMainOwner()
const shapeRuns = new Map<TurnShape, number>()

for (let n = 1; n <= 100; n++) {
  const shape = SHAPES[n % SHAPES.length]!
  const evidence = await runTurn(n, shape)
  if (shapeHolds(shape, evidence)) shapeRuns.set(shape, (shapeRuns.get(shape) ?? 0) + 1)
  else check(`turn ${n}: the ${shape} shape executed as named`, false, JSON.stringify(evidence) + '; the turn did not run the way its shape names (calls, tool run, abort); check queryEvents in src/engine/turnDoor.ts')
  if (n % 20 === 0) {
    const live = plane
      .listExecutions(owner)
      .filter(rec => !['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(rec.state))
    check(`turn ${n}: no live executions`, live.length === 0, live.map(l => `${l.id}:${l.state}`).join(',') + '; a turn left an execution record open, check that queryEvents in src/engine/turnDoor.ts settles its records in src/engine/execution-plane/executionPlane.ts')
    check(`turn ${n}: ONE coordinator owner`, coordinator._runOwnerCountForTesting() === 1, String(coordinator._runOwnerCountForTesting()) + '; turns should share one run owner, check src/engine/run/runCoordinator.ts')
  }
}

await new Promise(r => setTimeout(r, 400))

console.log(`  drove 100 turns (${checks} mid-drive checks so far)`)
for (const shape of SHAPES) {
  check(`every ${shape} turn executed as named (20 of 100)`, shapeRuns.get(shape) === 20, `ran=${shapeRuns.get(shape) ?? 0}; the turns of this shape that failed are listed above, check queryEvents in src/engine/turnDoor.ts`)
}

{
  const all = plane.listExecutions(owner)
  const live = all.filter(rec => !['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(rec.state))
  check('execution plane: zero live records after 100 turns', live.length === 0, live.map(l => `${l.id}:${l.state}`).join(',') + '; records left open accumulate across turns, check src/engine/execution-plane/executionPlane.ts and where queryEvents in src/engine/turnDoor.ts finishes them')

  check('run coordinator: exactly ONE owner accumulated', coordinator._runOwnerCountForTesting() === 1, String(coordinator._runOwnerCountForTesting()) + '; each turn should reuse the process main owner, check src/engine/run/runCoordinator.ts')

  const queued = qm.getCommandQueue()
  check('command queue: empty (every steer consumed exactly once)', queued.length === 0, String(queued.length) + '; a steer command was left in the queue, check src/daemon/runner/messageQueueManager.ts and where queryEvents in src/engine/turnDoor.ts consumes queued commands')

  const end = lifecycle.ownerLifecycleCounts()
  const oversized = Object.entries(end.stores).filter(([, n]) => n > 1)
  check('owner-scoped stores scale with owners (≤1 each), never with turns', oversized.length === 0 && end.adhoc <= 1, JSON.stringify(end) + '; a store grew per turn instead of per owner, check ownerLifecycleCounts in src/engine/run-owner/ownerLifecycle.ts and the store it names above')
}

console.log('')
if (failures > 0) {
  console.log(`❌ S28: ${failures}/${checks} failure(s)`)
  process.exit(1)
}
console.log(`✅ S28: 100 mixed turns settle to a clean cross-owner baseline (${checks} checks)`)
process.exit(0)
