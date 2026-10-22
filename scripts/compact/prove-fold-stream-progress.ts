import '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import React from 'react'
import type { ServerResponse } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, waitFor, pinSourceRef } from '../lib/settingsPopupHarness.ts'
import { startOverflowFixture } from './overflowFixture.ts'

pinSourceRef()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['MERCURY_HOME', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SM_COMPACT', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_EXTRA_BODY']) delete process.env[key]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'
process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '5000'
let response: ServerResponse | undefined
let silent = false
const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const fixture = await startOverflowFixture({ stream(request, res) {
  if (request.dialect !== 'chat') return false
  response = res
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.flushHeaders()
  if (silent) res.write(chunk({ content: 'unfinished summary ' }))
  return true
} })
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { compactConversation, withFoldStatus, setFoldBoundsForTests } = await import('../../src/services/compact/compact.ts')
const { foldRowWords } = await import('../../src/services/compact/foldStatus.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { FileStateCache, READ_FILE_STATE_CACHE_SIZE } = await import('../../src/utils/fileStateCache.ts')
const { FoldStatusRow } = await import('../../src/components/FoldStatusRow.tsx')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
type Fold = import('../../src/services/compact/foldStatus.ts').FoldStatusV1
let fold: Fold | null = null
const listeners = new Set<() => void>()
const stamps: Fold[] = []
const state = { toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map(), tasks: {}, agentNameRegistry: new Map(), mcp: { clients: [], tools: [], commands: [], resources: {} }, effortValue: 'max' }
const controller = new AbortController()
const context: any = {
  abortController: controller, getAppState: () => state, setAppState: () => {}, messages: [],
  setSDKStatus(value: any) { if (value?.compacting) { fold = value.compacting; stamps.push(fold!); for (const listener of listeners) listener() } },
  readFileState: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
  options: { tools: [], commands: [], mcpClients: [], engineModel: 'compat/fixture-model', maxThinkingTokens: 0, thinkingConfig: { type: 'enabled', budgetTokens: 1024 }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } },
}
const messages = [createUserMessage({ content: 'Preserve the completed parser checks and continue with CLI verification.' })]
const cache = { systemPrompt: asSystemPrompt(['Synthetic fold progress proof.']), userContext: {}, systemContext: {}, toolUseContext: context, forkContextMessages: messages }
setFocusedSessionConnector({ sessionId: () => 'fold-fixture', live: () => ({}), subscribeLive: () => () => {}, status: () => ({}), tail: () => ({}), fold: () => fold, subscribeFold: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } } as never)
setFoldBoundsForTests({ stallMs: 30000, ingestMsPer1kTokens: 0 })
const mounted = await mountOffscreen(React.createElement(FoldStatusRow, { rows: [], conversationId: 'fold-fixture' }), 120, 12)
let result: any
let failure: unknown
let pending: Promise<void> | undefined
try {
  pending = withFoldStatus(context, scoped => compactConversation(messages, scoped, cache as never, false), { trigger: 'manual', sessionMemory: false, microcompaction: false }).then(value => { result = value }, error => { failure = error })
  assert.ok(await waitFor(() => response !== undefined && fold?.stage === 'summarising', 10000))
  assert.ok(await waitFor(() => mounted.screen().includes('waiting for the first token'), 3000), mounted.screen())
  assert.ok(await waitFor(() => /waiting for the first token.*[1-4]s/.test(mounted.screen()), 3000), 'the waiting row clock must advance before a token arrives')
  console.log('WAIT FRAME ' + mounted.lines().filter(Boolean).join('\n'))
  const thought = 'reasoning about the parser; '.repeat(16)
  response!.write(chunk({ reasoning_content: thought }))
  assert.ok(await waitFor(() => (fold?.summaryTokens ?? 0) >= Math.floor(thought.length / 4), 3000), 'reasoning-only deltas must move compact progress')
  const first = fold!.summaryTokens
  response!.write(chunk({ reasoning_content: thought }))
  assert.ok(await waitFor(() => (fold?.summaryTokens ?? 0) > first, 3000))
  assert.ok(await waitFor(() => mounted.screen().includes('tokens') && !mounted.screen().includes('waiting for the first token'), 3000), mounted.screen())
  console.log('THINK FRAME ' + mounted.lines().filter(Boolean).join('\n'))
  const summary = 'The parser accepts quoted commas and all 14 checks passed. Preserve the test command and continue with CLI verification.'
  response!.write(chunk({ content: summary }))
  assert.ok(await waitFor(() => (fold?.summaryTokens ?? 0) >= Math.floor((thought.length * 2 + summary.length) / 4), 3000))
  response!.end(chunk({}, 'stop') + 'data: [DONE]\n\n')
  await pending
  assert.equal(failure, undefined)
  assert.ok(JSON.stringify(result.summaryMessages).includes(summary))
  assert.equal(fixture.captured.length, 1)
  assert.equal(fold!.exit, 'landed')
  console.log('PASS waiting, reasoning-only growth, text growth and summary settlement travel through the actual compact runner and FoldStatusRow')

  silent = true
  response = undefined
  failure = undefined
  result = undefined
  process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1000'
  process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '1000'
  pending = withFoldStatus(context, scoped => compactConversation(messages, scoped, cache as never, false), { trigger: 'manual', sessionMemory: false, microcompaction: false }).then(value => { result = value }, error => { failure = error })
  await pending
  assert.equal(result, undefined)
  assert.match(String(failure), /stream.*(?:idle|stalled)|idle.*(?:budget|timeout)/i)
  assert.equal(fold!.exit, 'failed')
  assert.match(foldRowWords(fold!, Date.now()).line, /failed/)
  console.log('PASS silent stream ends with its route deadline: ' + String(failure))
  const frames = process.argv.indexOf('--frames')
  if (frames >= 0) writeFileSync(join(process.argv[frames + 1]!, 'fold-progress.txt'), stamps.map(stamp => foldRowWords(stamp, stamp.endedAtMs ?? Date.now()).line).join('\n') + '\n')
} finally {
  controller.abort()
  response?.destroy()
  await pending
  mounted.unmount()
  releaseFocusedSessionConnector()
  setFoldBoundsForTests(null)
  await fixture.close()
}
