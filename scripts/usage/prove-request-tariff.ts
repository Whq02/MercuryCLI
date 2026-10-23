#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'request-tariff-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
globalThis.fetch = (() => { throw new Error('network forbidden') }) as typeof fetch
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { resetCostState, getTotalCost } = await import('../../src/cost-tracker.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { rollupSessionUsage } = await import('../../src/utils/sessionStorage/usageRollup.ts')
const realNow = Date.now
const sid = '55555555-5555-4555-8555-555555555555'
const start = Date.parse('2026-10-23T05:59:59Z')
const finish = Date.parse('2026-10-23T06:00:01Z')
let now = start
try {
  Date.now = () => now
  resetCostState()
  const profile = {
    ...deepseekLaneProfile,
    resolveCredential: () => ({ apiKey: 'fixture-only' }),
    requestUrl: () => 'http://127.0.0.1:1/chat/completions',
    streamTransport: () => ({ events: (async function* () {
      now = finish
      yield { type: 'text-delta', text: 'fixture response' } as const
      yield { type: 'usage', usage: { inputTokens: 2_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000 } } as const
      yield { type: 'finish', reason: 'stop', rawReason: 'stop', toolCalls: [] } as const
    })() }),
  }
  const messages = []
  for await (const item of compatChatCallModel(profile, {
    messages: [createUserMessage({ content: 'fixture' })], systemPrompt: ['fixture'], tools: [], signal: new AbortController().signal,
    thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: 'deepseek-flash', isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [] } as never,
  })) if (item.type === 'assistant' && !item.isApiErrorMessage) messages.push(item)
  assert.ok(messages.length > 0)
  const last = messages.at(-1)!
  assert.equal((last.message.usage as unknown as Record<string, unknown>).request_started_at_ms, start)
  assert.ok(Math.abs(getTotalCost() - 0.753) < 1e-9, `live cost ${getTotalCost()}`)
  const directory = join(home, 'projects', 'fixture')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, `${sid}.jsonl`)
  for (const message of messages) appendFileSync(path, encodeTranscriptLine(path, { ...message, sessionId: sid, cwd: 'fixture', version: '1.0.0', parentUuid: null, isSidechain: false }).line)
  const restored = await rollupSessionUsage(path, sid)
  assert.ok(Math.abs(restored.totalCostUSD - 0.753) < 1e-9, `restored cost ${restored.totalCostUSD}`)
  console.log('PASS request starts off-peak, finishes at peak, live and restored costs stay off-peak')
} finally { Date.now = realNow; rmSync(home, { recursive: true, force: true }) }
