#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
delete process.env.NODE_ENV
for (const key of [
  'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_EFFORT_LEVEL',
  'MERCURY_PROMPT_CACHING', 'MERCURY_CACHE_TTL', 'MERCURY_DAEMON_PERMISSION_MODE',
  'MERCURY_PROMPT_SUGGESTION_SPECULATION',
]) delete process.env[key]

const home = mkdtempSync(join(tmpdir(), 'prompt-suggestion-cache-skip-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-not-a-real-key'
process.env.MERCURY_CACHE_CLOCK = '0'

let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const api = await startFixtureApi([
  { kind: 'text', text: 'run the tests' },
  { kind: 'text', text: 'normal fork reply' },
])
process.env.ANTHROPIC_BASE_URL = api.url

try {
  const { enableConfigs } = await import('../../src/platform/settings/config.ts')
  enableConfigs()
  const { executePromptSuggestion } = await import('../../src/screen/prompt-suggestion/promptSuggestion.ts')
  const { runForkedAgent } = await import('../../src/crew/agents/forkedAgent.ts')
  const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
  const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/platform/files/fileStateCache.ts')
  const { query: startTurn } = await import('../../src/engine/turnDoor.ts')

  const MODEL = 'claude-sonnet-4-6'
  const posture = asSystemPrompt(['You are a fixture-driven session posture.'])
  let uuidSeq = 0
  const nextUuid = (): string => `00000000-0000-4000-a000-${String(++uuidSeq).padStart(12, '0')}`

  function assistantRow(text: string): unknown {
    const id = `msg_${nextUuid().slice(-6)}`
    return {
      type: 'assistant',
      uuid: nextUuid(),
      requestId: `req_${id}`,
      timestamp: new Date().toISOString(),
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0 },
      },
    }
  }

  const conversation: unknown[] = [
    createUserMessage({ content: 'fix the build' }),
    assistantRow('Fixed the build.'),
    createUserMessage({ content: 'update the changelog' }),
    assistantRow('Updated the changelog.'),
  ]

  let capturedSuggestion: string | undefined
  const appState: Record<string, unknown> = {
    promptSuggestionEnabled: true,
    pendingWorkerRequest: undefined,
    elicitation: { queue: [] },
    toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' as const },
    sessionHooks: new Map(),
    tasks: {},
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
    promptSuggestion: { text: null, promptId: null, shownAt: 0, acceptedAt: 0, generationRequestId: null },
  }

  const toolUseContext = {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
      const next = updater(appState)
      Object.assign(appState, next)
      const ps = next.promptSuggestion as { text?: string | null } | undefined
      if (typeof ps?.text === 'string') capturedSuggestion = ps.text
    },
    messages: conversation,
    agentType: undefined,
    agentId: undefined,
    startTurn,
    readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
    options: {
      tools: [],
      mcpClients: [],
      engineModel: MODEL,
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'disabled' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }

  await executePromptSuggestion({
    messages: conversation as never,
    systemPrompt: posture,
    userContext: {},
    systemContext: {},
    toolUseContext: toolUseContext as never,
    querySource: 'main_thread',
  })

  type WireMessage = { role: string; content: unknown }
  const hasCacheControl = (message: WireMessage | undefined): boolean => {
    if (!message || !Array.isArray(message.content)) return false
    return message.content.some(block => block !== null && typeof block === 'object' && 'cache_control' in block)
  }

  const suggestionReq = api.requests.find(r => r.path.startsWith('/v1/messages'))
  const suggestionMsgs = ((suggestionReq?.body as { messages?: WireMessage[] } | undefined)?.messages ?? [])
  const suggestionTail = suggestionMsgs[suggestionMsgs.length - 1]
  const priorUser = [...suggestionMsgs.slice(0, -1)].reverse().find(m => m.role === 'user')

  check('prompt suggestion sent one /v1/messages request and captured the suggestion', suggestionReq !== undefined && capturedSuggestion === 'run the tests', { count: api.requests.length, capturedSuggestion, hint: 'executePromptSuggestion in src/screen/prompt-suggestion/promptSuggestion.ts should send one request and store its text in appState.promptSuggestion' })
  check('suggestion request tail (the suggestion prompt) carries no cache_control marker', suggestionTail !== undefined && !hasCacheControl(suggestionTail), { tail: suggestionTail, hint: 'promptSuggestion.ts passes skipCacheWrite: true to the fork; the marker placement is in src/models/roads/anthropic/cacheAndUsage.ts (skipCacheWrite param)' })
  check('suggestion request preserves the parent user cache_control breakpoint', priorUser !== undefined && hasCacheControl(priorUser), { priorUser, hint: 'with skipCacheWrite the cache_control marker should sit on the last user message before the tail (src/models/roads/anthropic/cacheAndUsage.ts)' })

  const beforeOther = api.requests.length
  await runForkedAgent({
    promptMessages: [createUserMessage({ content: 'ordinary fork prompt' })],
    cacheSafeParams: {
      systemPrompt: posture,
      userContext: {},
      systemContext: {},
      toolUseContext: toolUseContext as never,
      forkContextMessages: conversation as never,
    },
    canUseTool: async () => ({ behavior: 'deny', message: 'no tools', decisionReason: { type: 'other', reason: 'no tools' } }),
    querySource: 'agent_summary',
    forkLabel: 'agent_summary',
    skipTranscript: true,
  })
  const otherReq = api.requests.slice(beforeOther).find(r => r.path.startsWith('/v1/messages'))
  const otherMsgs = ((otherReq?.body as { messages?: WireMessage[] } | undefined)?.messages ?? [])
  const otherTail = otherMsgs[otherMsgs.length - 1]
  check('another fork without skipCacheWrite keeps cache_control on its tail message unchanged', otherTail !== undefined && hasCacheControl(otherTail), { otherTail, hint: 'a fork that does not pass skipCacheWrite must keep the marker on its tail; see runForkedAgent in src/crew/agents/forkedAgent.ts and cacheAndUsage.ts' })
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\nFAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nPASS: prompt suggestion skips cache write while other forks stay unchanged')
