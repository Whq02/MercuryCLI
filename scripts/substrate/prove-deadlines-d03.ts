#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'deadlines-d03-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { createStore } = await import('../../src/platform/primitives/store.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { onChangeAppState } = await import('../../src/screen/app-state/onChangeAppState.ts')
const { tellTheToolTable } = await import('../../src/tools/kit/toolTable.ts')
const { crewmateToolCall } = await import('../../src/tools/crewmate/call/call.ts')

tellTheToolTable({ getAllBaseTools: () => [], assembleToolPool: () => [] })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const OLD_POLL_MS = 500
const EVENT_DELAY_MS = 10

const agentDef = {
  agentType: 'mcp-worker',
  whenToUse: 'probe',
  getSystemPrompt: () => 'probe',
  source: 'userSettings' as const,
  requiredMcpServers: ['demo'],
}

function makeHarness(initialClient: Record<string, unknown>) {
  const initial = getDefaultAppState()
  const store = createStore(
    {
      ...initial,
      mcp: {
        ...initial.mcp,
        clients: [initialClient as never],
        tools: [],
      },
    },
    onChangeAppState,
  )
  const abortController = new AbortController()
  const context = {
    abortController,
    getAppState: () => store.getState(),
    setAppState: store.setState,
    options: {
      tools: [],
      agentDefinitions: {
        activeAgents: [agentDef],
        allAgents: [agentDef],
      },
    },
  } as never
  return { store, abortController, context }
}

const dummyInput = {
  description: 'probe',
  prompt: 'probe',
  crewmate_type: 'mcp-worker',
  review_receipt: 'probe',
} as never

const dummyCanUseTool = (async () => ({ behavior: 'allow' as const, updatedInput: {} })) as never
const dummyParent = { message: { id: 'm1', content: [] } } as never

console.log('============================================================')
console.log(' d03 poll-event proof: waitForRequiredMcpServers')
console.log('============================================================')

try {
  {
    const { store, context } = makeHarness({ name: 'demo', type: 'pending', config: { type: 'stdio', command: 'echo', scope: 'user' } })
    const t0 = performance.now()
    setTimeout(() => {
      store.setState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: [{ name: 'demo', type: 'failed', config: { type: 'stdio', command: 'echo', scope: 'user' }, error: 'boom' } as never],
        },
      }))
    }, EVENT_DELAY_MS)
    let message = ''
    try {
      await crewmateToolCall(dummyInput, context, dummyCanUseTool, dummyParent)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const elapsed = Math.round(performance.now() - t0)
    check(
      'pending required MCP server transitioning to failed wakes waiter before old 500ms poll period',
      elapsed < OLD_POLL_MS - 100 && message.includes("Crewmate type 'mcp-worker' requires MCP server(s) matching: demo"),
      `elapsed=${elapsed}ms message=${message}; waitForRequiredMcpServers in src/tools/crewmate/call/call.ts must wake on the mcp clients change event (subscribeMcpClientsChange) and throw the requires-MCP-server error once the server is failed`,
    )
  }

  {
    const { store, context } = makeHarness({ name: 'demo', type: 'pending', config: { type: 'stdio', command: 'echo', scope: 'user' } })
    const t0 = performance.now()
    setTimeout(() => {
      store.setState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          clients: [{ name: 'demo', type: 'connected', config: { type: 'stdio', command: 'echo', scope: 'user' } } as never],
          tools: [{ name: 'mcp__demo__ping' } as never],
        },
      }))
    }, EVENT_DELAY_MS)
    let message = ''
    try {
      await crewmateToolCall(dummyInput, context, dummyCanUseTool, dummyParent)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    const elapsed = Math.round(performance.now() - t0)
    check(
      'pending required MCP server transitioning to connected with tools wakes waiter before old 500ms poll period and passes MCP check',
      elapsed < OLD_POLL_MS - 100 && message.includes('review_receipt requires worktree_at'),
      `elapsed=${elapsed}ms message=${message}; waitForRequiredMcpServers in src/tools/crewmate/call/call.ts must wake on the mcp clients change event and pass the MCP check once the server is connected with tools`,
    )
  }

  {
    const { abortController, context } = makeHarness({ name: 'demo', type: 'pending', config: { type: 'stdio', command: 'echo', scope: 'user' } })
    const t0 = performance.now()
    setTimeout(() => abortController.abort(new Error('user pressed Esc')), 20)
    let errName = ''
    let errCode = ''
    try {
      await crewmateToolCall(dummyInput, context, dummyCanUseTool, dummyParent)
    } catch (error) {
      errName = error instanceof Error ? error.name : ''
      errCode = String((error as { code?: unknown } | null)?.code ?? '')
    }
    const elapsed = Math.round(performance.now() - t0)
    check(
      'abort (Esc) during the 30s pending MCP wait rejects at once with AbortError instead of waiting 30s',
      elapsed < OLD_POLL_MS - 100 && errName === 'AbortError' && errCode === 'ABORT_ERR',
      `elapsed=${elapsed}ms name=${errName} code=${errCode}; waitForRequiredMcpServers in src/tools/crewmate/call/call.ts must pass context.abortController.signal to its deadline wait so Esc rejects with AbortError`,
    )
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-deadlines-d03: green' : `\nprove-deadlines-d03: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
