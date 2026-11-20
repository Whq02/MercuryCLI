#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mock } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { z } from 'zod/v4'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'
const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ENTRYPOINTS = ['queryModelWithStreaming', 'queryModelWithoutStreaming', 'queryWithModel', 'queryUtility'] as const
type Entrypoint = (typeof ENTRYPOINTS)[number]
const UNROUTED = new Set<Entrypoint>(['queryModelWithStreaming', 'queryModelWithoutStreaming'])

const ALLOWED: Array<{ path: string; names: Entrypoint[]; verdict: string }> = [
  {
    path: 'src/services/providers/callModelRouter.ts',
    names: ['queryModelWithStreaming'],
    verdict: 'the router itself — its anthropic (home) arm IS the transport',
  },
  {
    path: 'src/services/providers/primaryBackend.ts',
    names: ['queryModelWithStreaming'],
    verdict: 'the backend table — the anthropic row names the transport as its stream face',
  },
  {
    path: 'src/utils/model/validateModel.ts',
    names: ['queryModelWithoutStreaming'],
    verdict: 'the route law adjudicates first: non-Anthropic ids validate on their own lanes above this call; the direct call is the anthropic arm',
  },
]

const TRANSPORT_ESTATE = ['src/services/providers/anthropic/']
const TRANSPORT_SPECIFIER = /\/providers\/anthropic(?:\/index\.js|\/[A-Za-z]+\.js)?(?:['"]|$)/

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      walk(full, out)
    } else if (/\.(?:ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
}

function stripComments(src: string): string {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/[^\n]*/gm, '')
}

function transportImports(code: string): Set<Entrypoint> {
  const names = new Set<Entrypoint>()
  const collect = (braces: string): void => {
    for (const piece of braces.split(',')) {
      const bare = piece.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? ''
      if ((ENTRYPOINTS as readonly string[]).includes(bare)) names.add(bare as Entrypoint)
    }
  }
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*'([^']+)'/g)) {
    if (TRANSPORT_SPECIFIER.test(m[2] ?? '')) collect(m[1] ?? '')
  }
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(\s*'([^']+)'\s*\)/g)) {
    if (TRANSPORT_SPECIFIER.test(m[2] ?? '')) collect(m[1] ?? '')
  }
  return names
}

section('§1 the direct-importer census — every transport entrypoint importer, adjudicated')
const files: string[] = []
walk(SRC, files)
type Row = { path: string; names: Entrypoint[]; verdict: string; ok: boolean }
const rows: Row[] = []
const seenAllowed = new Set<string>()
for (const file of files.sort()) {
  const rel = relative(ROOT, file)
  if (TRANSPORT_ESTATE.some(p => rel === p || rel.startsWith(p))) continue
  const names = [...transportImports(stripComments(readFileSync(file, 'utf8')))]
  if (names.length === 0) continue
  const unrouted = names.filter(n => UNROUTED.has(n))
  const routed = names.filter(n => !UNROUTED.has(n))
  if (unrouted.length === 0) {
    rows.push({ path: rel, names, verdict: 'routed helper — the transport function itself drains routedCallModel (§2)', ok: true })
    continue
  }
  const allowance = ALLOWED.find(a => a.path === rel)
  if (allowance !== undefined) seenAllowed.add(rel)
  const permitted = allowance !== undefined && unrouted.every(n => allowance.names.includes(n))
  rows.push({
    path: rel,
    names,
    verdict: permitted
      ? `named: ${allowance!.verdict}${routed.length > 0 ? ' (+ routed helper imports)' : ''}`
      : 'PRODUCT SITE IMPORTS THE TRANSPORT DIRECTLY — route through callModelRouter (routedCallModel / routedCallModelSettled)',
    ok: permitted,
  })
}
console.log('\n  site → entrypoints → verdict')
for (const row of rows) {
  console.log(`  ${row.ok ? '·' : '✗'} ${row.path}  [${row.names.join(', ')}]  ${row.verdict}`)
}
console.log('')
check('the census found the transport importers (a zero census would be a broken walker)', rows.length >= 6, String(rows.length))
for (const row of rows.filter(r => !r.ok)) {
  check(`unrouted entrypoint importer outside the adjudication table: ${row.path}`, false, row.names.join(', '))
}
check('every unrouted-entrypoint importer is a named row of the adjudication table', rows.every(r => r.ok))
for (const allowance of ALLOWED) {
  const row = rows.find(r => r.path === allowance.path)
  check(
    `table row still imports exactly what it is allowed: ${allowance.path} [${allowance.names.join(', ')}]`,
    row !== undefined && row.names.filter(n => UNROUTED.has(n)).sort().join(',') === [...allowance.names].sort().join(','),
    row === undefined ? 'no longer imports the transport — retire the row' : row.names.join(', '),
  )
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { utilityCallFor } = await import('../../src/utils/model/utilityModel.ts')
type CallModelParams = import('../../src/services/providers/callModelContract.ts').CallModelParams
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

const streamCalls: CallModelParams[] = []
const settledCalls: CallModelParams[] = []
let nextReplyText = 'ok'

function fakeAssistant(text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000001' as never,
    timestamp: '2026-01-01T00:00:00.000Z',
    requestId: 'req-fixture',
    message: {
      id: 'msg-fixture',
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as unknown as AssistantMessage
}

const realRouter = { ...(await import('../../src/services/providers/callModelRouter.ts')) }
mock.module('../../src/services/providers/callModelRouter.ts', () => ({
  ...realRouter,
  routedCallModel: async function* (params: CallModelParams) {
    streamCalls.push(params)
    yield fakeAssistant(nextReplyText)
  },
  routedCallModelSettled: async (params: CallModelParams) => {
    settledCalls.push(params)
    return fakeAssistant(nextReplyText)
  },
}))
const realCatalogueOnDemand = { ...(await import('../../src/services/providers/catalogueOnDemand.ts')) }
mock.module('../../src/services/providers/catalogueOnDemand.ts', () => ({
  ...realCatalogueOnDemand,
  readCatalogueIfPending: async () => undefined,
}))

const { queryUtility } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { nativeSearch } = await import('../../src/services/search/nativeSearch.ts')
const { nativeSearchFamilyOf, resolveSearchDoorPlan } = await import('../../src/services/search/searchDoor.ts')
const { runQuestionHook } = await import('../../src/utils/hooks/questionRunner.ts')
const { generateAgent } = await import('../../src/components/agents/generateAgent.ts')

const makeToolContext = (engineModel: string): never =>
  ({
    abortController: new AbortController(),
    agentId: 'agent-fixture',
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), effortValue: 'high' }),
    options: {
      engineModel,
      thinkingConfig: { type: 'disabled' },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
      appendSystemPrompt: undefined,
    },
  }) as never

section('§2 the routed helpers stay routed — queryWithModel / queryUtility')
{
  streamCalls.length = 0
  settledCalls.length = 0
  nextReplyText = 'utility-answer'
  const expected = utilityCallFor()
  const reply = await queryUtility({
    systemPrompt: asSystemPrompt(['Be brief.']),
    userPrompt: 'ping',
    signal: new AbortController().signal,
    options: {
      querySource: 'test_utility' as never,
      agents: [],
      isNonInteractiveSession: true,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })
  const call = streamCalls[0]
  check(
    'queryUtility rides queryWithModel through routedCallModel',
    streamCalls.length === 1 && reply.message.content[0]?.type === 'text' && reply.message.content[0].text === 'utility-answer',
    JSON.stringify({ calls: streamCalls.length, content: reply.message.content }),
  )
  check(
    "queryUtility's model and floor are the helper's (utilityCallFor), the floor pinned",
    call !== undefined &&
      call.options.model === expected.model &&
      call.options.effortValue === expected.effortValue &&
      call.options.effortPinned === true &&
      call.options.ridesSessionEffort === false &&
      call.thinkingConfig.type === expected.thinkingConfig.type,
    JSON.stringify({ got: call?.options, expected }),
  )
}

section('§3 the rewritten sites reach the wire through the router')
{
  streamCalls.length = 0
  settledCalls.length = 0
  nextReplyText = 'search summary'
  const searchOutcome = await nativeSearch('openai', { query: 'mercury router test' }, { context: makeToolContext('gpt-5.4') })
  const searchCall = streamCalls[0]
  check(
    'nativeSearch calls routedCallModel once with the main model and nativeWebSearch options',
    searchOutcome.ok &&
      streamCalls.length === 1 &&
      searchCall !== undefined &&
      searchCall.options.model === 'gpt-5.4' &&
      searchCall.options.querySource === 'web_search_tool' &&
      searchCall.options.nativeWebSearch?.maxUses === 8,
    JSON.stringify({ ok: searchOutcome.ok, calls: streamCalls.length, model: searchCall?.options.model, nativeWebSearch: searchCall?.options.nativeWebSearch }),
  )

  const anthropicPlan = resolveSearchDoorPlan({ mainModel: 'claude-sonnet-5', keylessAllowed: false })
  const openaiPlan = resolveSearchDoorPlan({ mainModel: 'gpt-5.4', keylessAllowed: false })
  const deepseekPlan = resolveSearchDoorPlan({ mainModel: 'deepseek-chat', keylessAllowed: false })
  check(
    "the search door opens the native door only for the main model's own family by the routing law",
    nativeSearchFamilyOf('claude-sonnet-5') === 'anthropic' &&
      nativeSearchFamilyOf('gpt-5.4') === 'openai' &&
      nativeSearchFamilyOf('deepseek-chat') === undefined &&
      nativeSearchFamilyOf('gemini-2.5-pro') === undefined &&
      anthropicPlan.doors[0]?.kind === 'native' &&
      anthropicPlan.doors[0].family === 'anthropic' &&
      openaiPlan.doors[0]?.kind === 'native' &&
      openaiPlan.doors[0].family === 'openai' &&
      !deepseekPlan.doors.some(door => door.kind === 'native'),
    JSON.stringify({ anthropic: anthropicPlan.doors, openai: openaiPlan.doors, deepseek: deepseekPlan.doors }),
  )

  settledCalls.length = 0
  nextReplyText = '{"allow":true}'
  const expectedHookDefault = utilityCallFor()
  const hookDefaultEnd = await runQuestionHook({
    text: 'Allow this?',
    name: 'test-hook',
    event: 'PreToolUse',
    payloadJson: '{}',
    answerSchema: z.object({ allow: z.boolean() }),
    timeoutMs: 5_000,
    toolUseContext: makeToolContext('claude-sonnet-5'),
  })
  const hookDefaultCall = settledCalls[0]
  check(
    'questionRunner settles through routedCallModelSettled once and defaults to utilityCallFor() with a pinned floor',
    hookDefaultEnd.kind === 'answered' &&
      settledCalls.length === 1 &&
      hookDefaultCall !== undefined &&
      hookDefaultCall.options.model === expectedHookDefault.model &&
      hookDefaultCall.options.effortValue === expectedHookDefault.effortValue &&
      hookDefaultCall.options.effortPinned === true &&
      hookDefaultCall.options.querySource === 'hook_prompt',
    JSON.stringify({ end: hookDefaultEnd, calls: settledCalls.length, got: hookDefaultCall?.options, expected: expectedHookDefault }),
  )

  settledCalls.length = 0
  nextReplyText = '{"allow":false}'
  const expectedHookNamed = utilityCallFor('gpt-5.4', { named: true })
  const hookNamedEnd = await runQuestionHook({
    text: 'Allow this?',
    name: 'test-hook-named',
    event: 'PreToolUse',
    payloadJson: '{}',
    answerSchema: z.object({ allow: z.boolean() }),
    model: 'gpt-5.4',
    timeoutMs: 5_000,
    toolUseContext: makeToolContext('claude-sonnet-5'),
  })
  const hookNamedCall = settledCalls[0]
  check(
    'questionRunner routes a named hook model via utilityCallFor(model, { named: true }) with a pinned floor',
    hookNamedEnd.kind === 'answered' &&
      settledCalls.length === 1 &&
      hookNamedCall !== undefined &&
      hookNamedCall.options.model === expectedHookNamed.model &&
      hookNamedCall.options.effortValue === expectedHookNamed.effortValue &&
      hookNamedCall.options.effortPinned === true,
    JSON.stringify({ end: hookNamedEnd, calls: settledCalls.length, got: hookNamedCall?.options, expected: expectedHookNamed }),
  )

  settledCalls.length = 0
  nextReplyText = JSON.stringify({ identifier: 'router-agent', whenToUse: 'when testing routing', systemPrompt: 'Test routing.' })
  const draft = await generateAgent('design a router tester', 'gpt-5.4', ['existing-agent'], new AbortController().signal)
  const agentCall = settledCalls[0]
  check(
    'generateAgent settles through routedCallModelSettled once with the requested model',
    settledCalls.length === 1 &&
      agentCall !== undefined &&
      agentCall.options.model === 'gpt-5.4' &&
      agentCall.options.querySource === 'agent_creation' &&
      draft.identifier === 'router-agent',
    JSON.stringify({ calls: settledCalls.length, model: agentCall?.options.model, draft }),
  )
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ TRANSPORT REACHED VIA ROUTER GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} TRANSPORT-VIA-ROUTER FAILURE(S)`)
process.exit(1)
