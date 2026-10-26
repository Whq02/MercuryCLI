#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'restart-keeps-thinking-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'restart-keeps-thinking-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
for (const ambient of ['MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_EFFORT_LEVEL', 'MERCURY_WIRE_DUMP', 'MERCURY_HOME', 'MERCURY_PROJECT_INTEL']) delete process.env[ambient]
process.env.MERCURY_TOOL_SEARCH = '1'
process.env.MERCURY_THINKING_BINDING = 'error'
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0-beta.43' }

import { bindingDropsFor, startFixtureApi, type CapturedRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the restart proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const MODEL = 'claude-opus-4-8'
const COMPUTER = 'Computer'
const PAINTER = 'Painter'
const DISPATCH = 'Dispatch'
const turns: ScriptedTurn[] = [
  { kind: 'tool_use', name: 'ToolSearch', id: 'toolu_search', input: { query: `select:${COMPUTER}` }, thinking: 'Find the screen tool.', model: MODEL },
  { kind: 'tool_use', name: COMPUTER, id: 'toolu_front', input: { action: 'frontmost', label: 'where am I' }, thinking: 'Ask the screen.', model: MODEL },
  { kind: 'text', text: 'The front window is Terminal.', thinking: 'Answer with the window.', model: MODEL },
  { kind: 'text', text: 'Hello again.', thinking: 'A greeting after the restart.', model: MODEL },
  { kind: 'tool_use', name: COMPUTER, id: 'toolu_after', input: { action: 'screenshot', label: 'look', display: 'main' }, thinking: 'Use the new display field.', model: MODEL },
  { kind: 'text', text: 'Done.', thinking: 'Report the screenshot.', model: MODEL },
]
const fixture = await startFixtureApi(turns, { bindingCheck: true })
process.env.ANTHROPIC_BASE_URL = fixture.url

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { buildTool } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const economy = await import('../../src/services/providers/toolEconomy.ts')
const { clearToolSchemaCache, clearConversationToolSchemas } = await import('../../src/utils/toolSchemaCache.ts')
const { restoreBoundPrefixFromMessages, resetBoundPrefixEmitted } = await import('../../src/services/providers/anthropic/boundPrefixRecord.ts')
const { resetPrefixLedger } = await import('../../src/services/providers/anthropic/prefixLedger.ts')
const { resetThinkingDropStates } = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
const { clearSystemPromptSectionState } = await import('../../src/bootstrap/state.ts')
const { getToolSchemaDeltaAttachment, TOOL_SCHEMA_DELTA_HEAD } = await import('../../src/utils/attachments/toolSchemaDelta.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

function fixtureTool(name: string, opts: { defer?: boolean; params: string[]; result: string; hint?: string }): Tool {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of opts.params) shape[p] = p === 'display' ? z.string().optional() : z.string()
  return buildTool({
    name,
    ...(opts.defer ? { shouldDefer: true } : {}),
    ...(opts.hint ? { searchHint: opts.hint } : {}),
    inputSchema: z.object(shape),
    description: async () => `${name}: a fixture tool`,
    prompt: async () => `${name}: a fixture tool taking ${opts.params.join(', ')}`,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async (input: Record<string, unknown>) => ({ data: `${opts.result}${typeof input.display === 'string' ? ` on ${input.display}` : ''}` }),
    mapToolResultToToolResultBlockParam: (output: string, toolUseID: string) => ({ tool_use_id: toolUseID, type: 'tool_result' as const, content: output }),
  } as never) as unknown as Tool
}
const buildA: Tool[] = [
  fixtureTool('Read', { params: ['file_path'], result: 'the file' }),
  fixtureTool(DISPATCH, { params: ['target'], result: 'dispatched' }),
  ToolSearchTool as never,
  fixtureTool(COMPUTER, { defer: true, params: ['action', 'label'], result: 'frontmost: Terminal', hint: 'computer use: see the screen, drive the mouse and keyboard' }),
  fixtureTool(PAINTER, { defer: true, params: ['prompt'], result: 'painted', hint: 'paints a picture from a prompt' }),
]
const buildB: Tool[] = [
  fixtureTool('Read', { params: ['file_path'], result: 'the file' }),
  ToolSearchTool as never,
  fixtureTool(COMPUTER, { defer: true, params: ['action', 'label', 'display'], result: 'frontmost: Terminal', hint: 'computer use: see the screen, drive the mouse and keyboard' }),
  fixtureTool('PainterV2', { defer: true, params: ['prompt', 'style'], result: 'painted', hint: 'paints a picture from a prompt in a style' }),
  fixtureTool('Brush', { defer: true, params: ['stroke'], result: 'brushed', hint: 'a single brush stroke' }),
]

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

function makeCtx(tools: Tool[]): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools,
      engineModel: MODEL,
      thinkingConfig: { type: 'enabled', budgetTokens: 2048 },
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
    contentReplacementState: createContentReplacementState(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

type AnyMsg = Record<string, unknown> & { type?: string }
type Drive = { yields: AnyMsg[]; threw: string | undefined; wire: CapturedRequest[] }
async function drive(ctx: Record<string, unknown>, messages: Message[]): Promise<Drive> {
  const before = fixture.messageRequests().length
  ctx.abortController = new AbortController()
  ctx.messages = messages
  const yields: AnyMsg[] = []
  let threw: string | undefined
  try {
    const gen = query({
      messages: messages as never,
      systemPrompt: ['fixture system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: allowAll as never,
      toolUseContext: ctx as never,
      querySource: 'sdk' as never,
      deps: productionDeps(),
    })
    let r = await gen.next()
    while (!r.done) {
      yields.push(r.value as AnyMsg)
      r = await gen.next()
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, threw, wire: fixture.messageRequests().slice(before) }
}
const transcriptAfter = (seed: Message[], run: Drive): Message[] => [
  ...seed,
  ...(run.yields.filter(y => y.type === 'user' || y.type === 'assistant' || y.type === 'attachment' || y.type === 'system') as unknown as Message[]),
]
const toolsOf = (request: CapturedRequest | undefined): Array<Record<string, unknown>> => ((request?.body as { tools?: Array<Record<string, unknown>> } | null)?.tools ?? [])
const withoutCacheControl = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutCacheControl)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'cache_control').map(([key, inner]) => [key, withoutCacheControl(inner)]))
}
const toolNamed = (request: CapturedRequest | undefined, name: string): Record<string, unknown> | undefined => toolsOf(request).find(tool => tool.name === name)
const thinkingBlocksOn = (request: CapturedRequest | undefined): number => {
  const messages = (request?.body as { messages?: Array<{ content?: unknown }> } | null)?.messages ?? []
  let count = 0
  for (const message of messages) if (Array.isArray(message.content)) count += message.content.filter(block => (block as { type?: string }).type === 'thinking').length
  return count
}
const toolResultsOf = (run: Drive): Array<{ id: string; text: string; isError: boolean }> => {
  const out: Array<{ id: string; text: string; isError: boolean }> = []
  for (const y of run.yields) {
    if (y.type !== 'user') continue
    const content = (y.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result') continue
      const inner = block.content
      const text = typeof inner === 'string' ? inner : Array.isArray(inner) ? (inner as Array<Record<string, unknown>>).map(p => String(p.text ?? (p.type === 'tool_reference' ? `[ref ${String(p.tool_name)}]` : ''))).join('') : ''
      out.push({ id: String(block.tool_use_id), text, isError: block.is_error === true })
    }
  }
  return out
}

try {
  section('§1 the session on the earlier build: a tool round with signed thinking, a deferred tool loaded through ToolSearch')
  const ctxA = makeCtx(buildA)
  let history: Message[] = [createUserMessage({ content: 'Which window is in front? Use Computer.' }) as Message]
  const a = await drive(ctxA, history)
  check('three requests, no throw, no API refusal', a.threw === undefined && a.wire.length === 3 && fixture.refusals.length === 0, a.threw ?? `${a.wire.length} requests; refusals ${j(fixture.refusals)}`)
  check('every request carried the binding field in the error behavior (the fixture judges every replayed block)', a.wire.every(request => (request.body as { thinking?: { block_binding?: { prefix_mismatch_behavior?: string } } }).thinking?.block_binding?.prefix_mismatch_behavior === 'error'), j((a.wire[0]?.body as { thinking?: unknown })?.thinking))
  check('the Computer call ran through the loaded definition', toolResultsOf(a).some(result => result.text.includes('frontmost: Terminal') && !result.isError), j(toolResultsOf(a)))
  check('the last request replayed the signed thinking of the earlier rounds', thinkingBlocksOn(a.wire[2]) === 2, `${thinkingBlocksOn(a.wire[2])} thinking blocks`)
  history = transcriptAfter(history, a)
  const record = history.find(m => m.type === 'attachment' && (m as { attachment?: { type?: string } }).attachment?.type === 'bound_prefix')
  check('the transcript carries the first exchange record with every definition', record !== undefined && ((record as { attachment: { roster: Array<{ definition?: string }> } }).attachment.roster.every(mark => typeof mark.definition === 'string')), j(record))
  const lastBefore = a.wire[2]

  section('§2 /restart onto a NEW build: Computer takes a new field, Dispatch is gone, Painter was renamed, Brush is new — the resumed request must re-send what the thinking is bound to')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0-beta.44' }
  economy.clearToolRosterLatches()
  economy.clearToolRosterRestore()
  clearToolSchemaCache()
  clearConversationToolSchemas()
  resetBoundPrefixEmitted()
  resetPrefixLedger()
  resetThinkingDropStates()
  clearSystemPromptSectionState()
  const restoredKey = restoreBoundPrefixFromMessages(history)
  check('the resume loader restored the first exchange record', typeof restoredKey === 'string', String(restoredKey))
  const ctxB = makeCtx(buildB)
  const delta = await getToolSchemaDeltaAttachment(ctxB as never, history)
  check('before the first resumed request, the schema delta names Computer (bound: referenced) with its live input, and no unreferenced deferred tool', delta.length === 1 && delta[0]!.type === 'tool_schema_delta' && j(delta[0]!.tools.map(t => t.name)) === j([COMPUTER]) && delta[0]!.body.startsWith(TOOL_SCHEMA_DELTA_HEAD) && delta[0]!.body.includes('"display"'), j(delta))
  history.push(createUserMessage({ content: 'Say hello.' }) as Message)
  const b = await drive(ctxB, history)
  const resumed = b.wire[0]
  check('one request, no throw, and the API refused nothing: every replayed thinking block kept its binding', b.threw === undefined && b.wire.length === 1 && fixture.refusals.length === 0, b.threw ?? `${b.wire.length} requests; refusals ${j(fixture.refusals)}`)
  check('the resumed request replays every signed thinking block of the earlier build', thinkingBlocksOn(resumed) === 3, `${thinkingBlocksOn(resumed)} thinking blocks`)
  check("the fixture's own binding check drops nothing on the resumed request", resumed !== undefined && bindingDropsFor(resumed.body).length === 0, j(resumed ? bindingDropsFor(resumed.body) : null))
  const recordedNames = toolsOf(lastBefore).map(tool => tool.name)
  check('the recorded roster opens the tools array in the recorded order', j(toolsOf(resumed).slice(0, recordedNames.length).map(tool => tool.name)) === j(recordedNames), j(toolsOf(resumed).map(tool => tool.name)))
  check('Computer (referenced, bound) goes out with the definition the thinking was minted over, not the new build\'s', j(withoutCacheControl(toolNamed(resumed, COMPUTER))) === j(withoutCacheControl(toolNamed(lastBefore, COMPUTER))) && !j(toolNamed(resumed, COMPUTER)).includes('display'), j(toolNamed(resumed, COMPUTER)))
  check('Dispatch (bound, retired by the new build) still rides from the record', j(withoutCacheControl(toolNamed(resumed, DISPATCH))) === j(withoutCacheControl(toolNamed(lastBefore, DISPATCH))), j(toolNamed(resumed, DISPATCH)))
  check('the system prompt replays byte for byte', j(withoutCacheControl((resumed?.body as { system?: unknown }).system)) === j(withoutCacheControl((lastBefore?.body as { system?: unknown }).system)))
  check('the new deferred tools join at the end, deferred', j(toolsOf(resumed).slice(recordedNames.length).map(tool => `${tool.name}${tool.defer_loading === true ? '+' : ''}`)) === j(['PainterV2+', 'Brush+']), j(toolsOf(resumed).map(tool => tool.name)))
  check('no dropped-thinking receipt was written', !b.yields.some(y => j(y).includes('Preserved thinking')), j(b.yields.filter(y => j(y).includes('Preserved thinking'))))
  history = transcriptAfter(history, b)

  section('§3 the model calls Computer with the new build\'s input: the harness runs the live tool, and the wire still holds')
  history.push(createUserMessage({ content: 'Take a screenshot of the main display with Computer.' }) as Message)
  const c = await drive(ctxB, history)
  check('two requests, no throw, no refusal', c.threw === undefined && c.wire.length === 2 && fixture.refusals.length === 0, c.threw ?? `${c.wire.length} requests; refusals ${j(fixture.refusals)}`)
  check('the call with the new field ran through the live tool', toolResultsOf(c).some(result => result.text === 'frontmost: Terminal on main' && !result.isError), j(toolResultsOf(c)))
  check('every request of the turn replayed the full thinking chain and dropped nothing', c.wire.every(request => bindingDropsFor(request.body).length === 0) && thinkingBlocksOn(c.wire[1]) === 5, j(c.wire.map(request => [thinkingBlocksOn(request), bindingDropsFor(request.body).length])))
  check('Computer still rides its recorded definition on every request of the new build', c.wire.every(request => j(withoutCacheControl(toolNamed(request, COMPUTER))) === j(withoutCacheControl(toolNamed(lastBefore, COMPUTER)))))
} finally {
  await fixture.close()
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log('RESTART KEEPS THINKING RED')
  process.exit(1)
}
console.log('RESTART KEEPS THINKING GREEN')
process.exit(0)
