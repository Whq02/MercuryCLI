#!/usr/bin/env bun
// ============================================================================
//  scripts/tool-economy/live-admission-drill.ts — the LIVE admission road on
//  a text-form route: a real model, the real assembled pool, one task that
//  needs a deferred tool. The transcript is printed as a sequence of what the
//  model called and what each result said, so the reader sees the road
//  itself: the name-only announcement → a ToolSearch call → the admission
//  record rendered as text → the admitted tool's real call and result.
//  Never pooled (live-* is outside the suite runner's glob); spends the
//  operator's quota on one bounded agentic run (the turn budget caps it).
//
//  Run: ~/.bun/bin/bun run scripts/tool-economy/live-admission-drill.ts --model openrouter/nvidia/nemotron-3.5-lightning:free
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const at = argv.indexOf('--model')
const model = at >= 0 ? argv[at + 1] : undefined
if (!model) {
  console.log('usage: live-admission-drill.ts --model <model id>')
  process.exit(2)
}
const brief =
  argv.includes('--brief') ? argv[argv.indexOf('--brief') + 1]! : 'Fetch https://example.com with the WebFetch tool and report the page title in one line. Do nothing else.'

delete process.env.NODE_ENV
delete process.env.MERCURY_SCRIPTED_STREAM
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// A scratch config home seeded with the operator's credential stores: the
// live route resolves the REAL credentials, every write lands in scratch (the
// live-E2E hermeticity law). Pinned before any product import.
const { pinHermeticCredentialedHome } = await import('./hermeticHome.ts')
const HOME = pinHermeticCredentialedHome('admission-drill-home-')
if (process.env.MERCURY_CONFIG_DIR !== HOME) throw new Error('the scratch config home did not pin')
// A scratch daemon/teams home keeps the drill's agent bookkeeping out of the
// operator's own.
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'admission-drill-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'admission-drill-teams-'))
process.env.MERCURY_CREW_DIR = mkdtempSync(join(tmpdir(), 'admission-drill-crew-'))

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { isDeferredTool, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
type Message = import('../../src/types/message.ts').Message

process.env.ANTHROPIC_MODEL = model
const permissionContext = getEmptyToolPermissionContext()
const pool = assembleToolPool(permissionContext, [])
const deferred = pool.filter(t => isDeferredTool(t)).map(t => t.name)
console.log(`model ${model} · wire form ${deferralWireFormFor(model).form} (${deferralWireFormFor(model).why}) · pool ${pool.length} (${deferred.length} deferrable, ToolSearch ${pool.some(t => t.name === TOOL_SEARCH_TOOL_NAME) ? 'pooled' : 'unpooled'})`)
console.log(`WebFetch is ${deferred.includes('WebFetch') ? 'DEFERRED (name-only until admitted)' : 'not deferred'}\n`)

const allowAll = (async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'admission drill' } })) as never

let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>) }
const abort = new AbortController()
const ctx = {
  abortController: abort,
  options: {
    commands: [],
    tools: pool,
    mainLoopModel: model,
    thinkingConfig: { type: 'disabled' },
    mcpClients: [],
    mcpResources: {},
    isNonInteractiveSession: true,
    debug: false,
    verbose: false,
    agentDefinitions: { activeAgents: [], allAgents: [] },
  },
  getAppState: () => appState,
  setAppState: (f: (prev: never) => never): void => {
    appState = f(appState as never) as unknown as Record<string, unknown>
  },
  messages: [],
  readFileState: createFileStateCacheWithSizeLimit(100),
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: () => {},
  updateAttributionState: () => {},
  agentId: undefined,
}

const definition = {
  agentType: 'admission-drill',
  whenToUse: 'the live admission drill',
  source: 'projectSettings',
  getSystemPrompt: () => 'You are a careful assistant. Use the tools you are given; a deferred tool must be loaded through ToolSearch before it can be called.',
} as never

const road: string[] = []
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the drill exceeded 300s; aborting')
  abort.abort()
}, 300_000)
guard.unref?.()

try {
  const stream = runAgent({
    agentDefinition: definition,
    promptMessages: [createUserMessage({ content: brief }) as Message],
    toolUseContext: ctx as never,
    canUseTool: allowAll,
    isAsync: false,
    canShowPermissionPrompts: false,
    querySource: 'agent:custom:admission-drill' as never,
    availableTools: pool as never,
    model,
  })
  for await (const message of stream) {
    const m = message as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
    if (m.type === 'assistant') {
      const blocks = Array.isArray(m.message?.content) ? (m.message!.content as Array<Record<string, unknown>>) : []
      for (const b of blocks) {
        if (b.type === 'tool_use') road.push(`model → ${String(b.name)} ${JSON.stringify(b.input).slice(0, 160)}`)
        else if (b.type === 'text' && String(b.text ?? '').trim()) road.push(`model says: ${String(b.text).trim().slice(0, 200)}${m.isApiErrorMessage ? '  [API ERROR]' : ''}`)
      }
    } else if (m.type === 'user') {
      const blocks = Array.isArray(m.message?.content) ? (m.message!.content as Array<Record<string, unknown>>) : []
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue
        const c = b.content
        const text =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? (c as Array<Record<string, unknown>>).map(p => (p.type === 'tool_reference' ? `[admission record: ${String(p.tool_name)}]` : p.type === 'text' ? String(p.text) : `[${String(p.type)}]`)).join(' ')
              : JSON.stringify(c)
        road.push(`result ${b.is_error ? '(error) ' : ''}→ ${text.replace(/\s+/g, ' ').slice(0, 240)}`)
      }
    }
  }
} catch (error) {
  road.push(`threw: ${error instanceof Error ? error.message : String(error)}`)
}
clearTimeout(guard)

console.log('THE ROAD:')
for (const step of road) console.log(`  ${step}`)
const searched = road.some(s => s.startsWith(`model → ${TOOL_SEARCH_TOOL_NAME}`))
const admitted = road.some(s => s.includes('[admission record: WebFetch]'))
const fetched = road.some(s => s.startsWith('model → WebFetch'))
console.log(`\nToolSearch called: ${searched} · WebFetch admitted: ${admitted} · WebFetch called after admission: ${fetched}`)
process.exit(searched && admitted && fetched ? 0 : 1)
