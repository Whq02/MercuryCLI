#!/usr/bin/env bun
// ============================================================================
//  scripts/tool-economy/live-prefix-usage.ts — the LIVE prefix instrument:
//  one real, output-capped request on a named route through the product's
//  own lane and credentials, reading the provider's OWN input-token count
//  (the billed figure, not an estimate). Run on the base tree and on the tip
//  for the BEFORE→AFTER receipt row. Never pooled (the suite runner globs
//  measure-*.ts and prove-*.ts only): it spends the operator's quota — one
//  request per invocation, never retried against a wall.
//
//  The pool is the real assembled pool plus the two fixture MCP servers
//  (./fixtureMcpEstate.ts), the conversation one short user turn, the
//  system prompt a fixed sentence. The route's credential resolves through
//  the config home exactly as a session's would.
//
//  Run: ~/.bun/bin/bun run scripts/tool-economy/live-prefix-usage.ts --route openai --model gpt-5.6-sol
// ============================================================================
import { join } from 'node:path'
import { buildFixtureMcpTools } from './fixtureMcpEstate.ts'

const argv = process.argv.slice(2)
const arg = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 ? argv[at + 1] : undefined
}
const route = arg('route')
const model = arg('model')
if (!route || !model) {
  console.log('usage: live-prefix-usage.ts --route <route> --model <model id>')
  process.exit(2)
}

delete process.env.NODE_ENV
delete process.env.MERCURY_SCRIPTED_STREAM
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// A scratch config home seeded with the operator's credential stores: the
// route resolves the REAL credentials exactly as a session's would, and every
// write lands in scratch (the live-E2E hermeticity law). Pinned before any
// product import.
const { pinHermeticCredentialedHome } = await import('./hermeticHome.ts')
const HOME = pinHermeticCredentialedHome('prefix-usage-home-')
if (process.env.MERCURY_CONFIG_DIR !== HOME) throw new Error('the scratch config home did not pin')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { MCPTool } = await import('../../src/tools/MCPTool/MCPTool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { isDeferredTool, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
type Message = import('../../src/types/message.ts').Message
type Tool = import('../../src/Tool.ts').Tool

if (declaredRouteOf(model) !== route) {
  console.log(`refusing: ${model} declares route ${declaredRouteOf(model) ?? 'none'}, not ${route}`)
  process.exit(2)
}

process.env.ANTHROPIC_MODEL = model
const permissionContext = getEmptyToolPermissionContext()
const mcpTools = buildFixtureMcpTools<Tool>(MCPTool)
const pool = assembleToolPool(permissionContext, mcpTools)
const deferrable = pool.filter(t => isDeferredTool(t)).length
const toolSearchPooled = pool.some(t => t.name === TOOL_SEARCH_TOOL_NAME)

const messages: Message[] = [createUserMessage({ content: 'Reply with exactly the word OK.' }) as Message]
const startedAt = Date.now()
let usage: Record<string, number> | undefined
let text = ''
const errors: string[] = []
// The lanes write the final usage back onto the LAST settled assistant
// message by direct mutation once the stream ends — read it after the loop.
let last: { message?: { usage?: Record<string, number> } } | undefined
try {
  const stream = routedCallModel({
    messages,
    systemPrompt: ['You are a fixture assistant. Reply with one word.'] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: pool,
    signal: new AbortController().signal,
    options: {
      getToolPermissionContext: async () => permissionContext,
      model,
      isNonInteractiveSession: true,
      querySource: 'repl_main_thread' as never,
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools,
      hasPendingMcpServers: false,
      maxOutputTokensOverride: 16,
    } as never,
  })
  for await (const message of stream) {
    const m = message as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown; usage?: Record<string, number> } }
    if (m.type !== 'assistant') continue
    if (m.isApiErrorMessage) {
      errors.push(JSON.stringify(m.message?.content).slice(0, 400))
      continue
    }
    const blocks = Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type?: string; text?: string }>) : []
    text += blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('')
    last = m
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error))
}
usage = last?.message?.usage
const wallMs = Date.now() - startedAt

const input = usage?.input_tokens ?? 0
const cached = usage?.cache_read_input_tokens ?? 0
const created = usage?.cache_creation_input_tokens ?? 0
const row = {
  tree: join(import.meta.dir, '..', '..'),
  route,
  model,
  poolSize: pool.length,
  deferrable,
  toolSearchPooled,
  promptTokens: input + cached + created,
  uncachedInputTokens: input,
  cacheReadTokens: cached,
  cacheCreationTokens: created,
  outputTokens: usage?.output_tokens ?? 0,
  reply: text.trim().slice(0, 40),
  wallMs,
  errors,
}
console.log(JSON.stringify(row, null, 2))
if (errors.length > 0) {
  console.log('\nthe wire refused or failed — recorded typed above, not retried')
  process.exit(1)
}
console.log(`\n${route} ${model}: prompt tokens ${row.promptTokens} (uncached ${input} · cached ${cached} · cache-write ${created}) · pool ${pool.length} (${deferrable} deferrable, ToolSearch ${toolSearchPooled ? 'pooled' : 'unpooled'}) · ${wallMs} ms`)
process.exit(0)
