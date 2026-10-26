import { strict as assert } from 'node:assert'
import type { Tool, ToolUseContext } from '../../../src/Tool.ts'
import type { AssistantMessage, RefusedToolCall } from '../../../src/types/message.ts'

export async function assertRefusedCallResult(
  rows: AssistantMessage[],
  expected: { id: string | RegExp; name: string; raw: string; code?: RefusedToolCall['code']; input?: Record<string, unknown> },
): Promise<true> {
  const calls = rows.flatMap(row => row.message.content.filter(block => block.type === 'tool_use').map(block => ({ row, block })))
  assert.equal(calls.length, 1, 'one refused call settles as one tool_use')
  const { row, block } = calls[0]!
  if (typeof expected.id === 'string') assert.equal(block.id, expected.id)
  else assert.match(block.id, expected.id)
  assert.equal(block.name, expected.name)
  assert.deepEqual(block.input, expected.input ?? {})
  assert.equal(rows.at(-1)?.message.stop_reason, 'tool_use')
  assert.equal(rows.some(message => message.isApiErrorMessage), false)
  const refusals = rows.flatMap(message => message.refusedToolCalls ?? [])
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0]?.id, block.id)
  assert.equal(refusals[0]?.name, expected.name)
  assert.equal(refusals[0]?.code, expected.code ?? 'invalid-json')
  assert.equal(refusals[0]?.argumentsRaw, expected.raw)
  assert.equal(row.refusedToolCalls?.[0], refusals[0])
  assert.equal(rows.some(message => message.message.content.some(content => content.type === 'text' && content.text.includes('the provider emitted a malformed tool call'))), false)

  const { runToolUse } = await import('../../../src/services/tools/toolExecution.ts')
  const { getDefaultAppState } = await import('../../../src/state/AppStateStore.ts')
  const { z } = await import('zod/v4')
  let executed = 0
  const tool = {
    name: expected.name,
    inputSchema: z.object({}).passthrough(),
    call: async () => { executed++; throw new Error('refused call reached the tool') },
  } as unknown as Tool
  let state = getDefaultAppState()
  const context = {
    abortController: new AbortController(),
    options: { tools: [tool], engineModel: row.message.model },
    messages: rows,
    getAppState: () => state,
    setAppState: (updater: Parameters<ToolUseContext['setAppState']>[0]) => { state = updater(state) },
    setResponseLength: () => {},
  } as unknown as ToolUseContext
  const results = []
  for await (const update of runToolUse(block, row, async () => { throw new Error('refused call reached permissions') }, context)) {
    if (update.message.type === 'user' && Array.isArray(update.message.message.content)) {
      results.push(...update.message.message.content.filter(content => content.type === 'tool_result'))
    }
  }
  assert.equal(executed, 0)
  assert.equal(results.length, 1)
  assert.equal(results[0]?.tool_use_id, block.id)
  assert.equal(results[0]?.is_error, true)
  assert.ok(JSON.stringify(results[0]?.content).includes('The call did not run'))
  assert.ok(JSON.stringify(results[0]?.content).includes(refusals[0]!.reason.split('\n')[0]!))
  return true
}
