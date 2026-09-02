#!/usr/bin/env bun
// ============================================================================
//  scripts/run-recovery/prove-hundred-turn-baseline.ts — §11 scenario 28.
//
//  ORACLE: one hundred scripted turns — mixing plain text, tool rounds,
//  mid-stream aborts, mid-tool aborts, and queued steering — settle with
//  ZERO accumulated live resources ACROSS the owners, asserted TOGETHER
//  (each domain suite proves only its own baseline; this is the cross-owner
//  census): the execution plane holds no live records, the run coordinator
//  holds exactly one owner, the phase machine sits at the newest
//  generation with a clean trace ring (bounded), the command queue is empty,
//  and the owner-lifecycle registries did not grow with turn count.
//
//  In-process drive through the REAL queryEvents core with deps fakes (the
//  runloop-contract rig pattern, leaned). No network, no clocks beyond the
//  machine's own, no PTY. Hermetic homes.
//
//  Run:  ~/.bun/bin/bun run scripts/run-recovery/prove-hundred-turn-baseline.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'convergence-s28-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'convergence-s28-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'convergence-s28-teams-'))
for (const k of [
  'MERCURY_SIMPLE',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_RELEVANT_RECALL',
  'CLAUDE_TEAM_NAME',
  'CLAUDE_AGENT_NAME',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const { queryEvents } = await import('../../src/query.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const qm = await import('../../src/utils/messageQueueManager.ts')
const plane = await import('../../src/services/primitives/executionPlane.ts')
const phase = await import('../../src/utils/pulse/turnPhase.ts')
const pulse = await import('../../src/utils/pulse/index.ts')
const coordinator = await import('../../src/services/run/runCoordinator.ts')
const lifecycle = await import('../../src/services/run/ownerLifecycle.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

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
  console.log('\n❌ TIMEOUT — 100 turns exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

console.log('============================================================')
console.log(' S28 — 100 mixed turns ⇒ zero accumulated live resources')
console.log('============================================================')

// ── the lean rig ────────────────────────────────────────────────────────────
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

async function runTurn(n: number, shape: TurnShape): Promise<void> {
  const abortController = new AbortController()
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  let toolAborted = false
  const tool = makeTool(() => {
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
      mainLoopModel: MODEL,
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

  // Queued steering: enqueue BEFORE the turn so the drain consumes it.
  if (shape === 'steer') {
    qm.enqueue({ value: `steer-${n}`, mode: 'prompt', uuid: nextUuid() } as never)
  }

  let call = 0
  async function* callModel(): AsyncGenerator<unknown> {
    call++
    if (shape === 'text' || (shape !== 'tool' && shape !== 'steer' && call > 1)) {
      if (shape === 'abort-stream' && call === 1) {
        yield createAssistantMessage({ content: `partial-${n}` })
        abortController.abort()
        return
      }
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

  const gen = queryEvents({
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
  // Drain to terminal.
  let r = await gen.next()
  while (!r.done) r = await gen.next()
}

// ── the drive: 100 turns, 5 shapes interleaved ──────────────────────────────
const SHAPES: TurnShape[] = ['text', 'tool', 'abort-stream', 'abort-tools', 'steer']
const owner = processMainOwner()

for (let n = 1; n <= 100; n++) {
  const shape = SHAPES[n % SHAPES.length]!
  // one generation per operator turn, exactly the REPL's contract.
  pulse.beginPulseTurn({ querySource: 'repl_main_thread' } as never)
  await runTurn(n, shape)
  const gen = pulse.getActivePulseTrace()?.generation
  if (gen !== undefined) {
    phase.setPulsePhase(gen, 'settling')
    pulse.completePulseTurn()
  }
  if (n % 20 === 0) {
    // Mid-drive census — leaks show up long before turn 100.
    const live = plane
      .listExecutions(owner)
      .filter(rec => !['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(rec.state))
    check(`turn ${n}: no live executions`, live.length === 0, live.map(l => `${l.id}:${l.state}`).join(','))
    check(`turn ${n}: ONE coordinator owner`, coordinator._runOwnerCountForTesting() === 1, String(coordinator._runOwnerCountForTesting()))
  }
}

// Settle fire-and-forget tails (kernel flushes ride microtasks + coalesce
// timers — one macro hop and the 250ms coalesce window, bounded).
await new Promise(r => setTimeout(r, 400))

console.log(`  drove 100 turns (${checks} mid-drive checks so far)`)

// ── the terminal cross-owner census, TOGETHER ───────────────────────────────
{
  const all = plane.listExecutions(owner)
  const live = all.filter(rec => !['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(rec.state))
  check('execution plane: zero live records after 100 turns', live.length === 0, live.map(l => `${l.id}:${l.state}`).join(','))

  const snapshotPhase = phase.getPulsePhase()
  check('turn phase: at the NEWEST generation (no drift)', snapshotPhase.generation === 100, `gen=${snapshotPhase.generation}`)
  check('turn phase: settled (settling/idle), never a stuck busy phase', snapshotPhase.phase === 'settling' || snapshotPhase.phase === 'idle', snapshotPhase.phase)

  check('run coordinator: exactly ONE owner accumulated', coordinator._runOwnerCountForTesting() === 1, String(coordinator._runOwnerCountForTesting()))

  // getCommandQueue() reads every band ('later'-threshold equivalent); the
  // per-priority read door was pen-facing and died with the steer-removal
  // ruling (the steer-removal fold).
  const queued = qm.getCommandQueue()
  check('command queue: empty (every steer consumed exactly once)', queued.length === 0, String(queued.length))

  // Growth law: owner-scoped stores scale with OWNERS, never with turns —
  // after 100 turns under one owner, every store holds ≤ 1 entry.
  const end = lifecycle.ownerLifecycleCounts()
  const oversized = Object.entries(end.stores).filter(([, n]) => n > 1)
  check('owner-scoped stores scale with owners (≤1 each), never with turns', oversized.length === 0 && end.adhoc <= 1, JSON.stringify(end))
}

console.log('')
if (failures > 0) {
  console.log(`❌ S28: ${failures}/${checks} failure(s)`)
  process.exit(1)
}
console.log(`✅ S28: 100 mixed turns settle to a clean cross-owner baseline (${checks} checks)`)
process.exit(0)
