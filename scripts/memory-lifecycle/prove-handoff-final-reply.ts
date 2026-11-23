import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'handoff-final-reply-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE
try {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()
  const { noteSessionEngine } = await import('../../src/sessions/mneme/lineageSession.ts')
  const { askForHandoff, assistantText, handoffNotice, _resetHandoffAskForTesting } = await import('../../src/sessions/mneme/handoffAsk.ts')
  const { ledgerEntryOf } = await import('../../src/sessions/mneme/ledger.ts')
  const { mnemeProjectKey } = await import('../../src/sessions/mneme/paths.ts')
  const { getSessionId } = await import('../../src/boot/process-state/processState.ts')
  const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
  noteSessionEngine('fixture')
  const commentary = createAssistantMessage({ content: [{ type: 'text', text: 'I will write the journal first.' }, { type: 'tool_use', id: 'journal', name: 'Journal', input: { text: 'journal note' } }] })
  const toolResult = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'journal', content: 'written' }] })
  const error = { ...createAssistantMessage({ content: 'API failed' }), isApiErrorMessage: true }
  const messages = [commentary, toolResult, error]
  const cacheSafeParams = { systemPrompt: [] as never, userContext: {}, systemContext: {}, toolUseContext: {} as never, forkContextMessages: [] }
  const note = await askForHandoff({ cacheSafeParams, run: async () => ({ messages, terminal: { reason: 'completed' as const } }) })
  assert.equal(note, null, 'an API error after Journal cannot promote earlier commentary to the note')
  assert.equal(ledgerEntryOf(mnemeProjectKey(), String(getSessionId()))?.handoff, null, 'a failed ask must leave the ledger handoff null; check what askForHandoff in src/sessions/mneme/handoffAsk.ts stores')
  assert.match(handoffNotice(note), /no note left/, 'handoffNotice in src/sessions/mneme/handoffAsk.ts must say no note left for a null note')
  assert.equal(assistantText([commentary, toolResult]), '', 'a tool call is not a final note')
  _resetHandoffAskForTesting()
  const stopped = await askForHandoff({ cacheSafeParams, run: async () => ({ messages: [createAssistantMessage({ content: 'partial note' })], terminal: { reason: 'max_turns' as const, turnCount: 4 } }) })
  assert.equal(stopped, null, 'an incomplete terminal cannot store even a text-only reply')
  _resetHandoffAskForTesting()
  const success = await askForHandoff({ cacheSafeParams, run: async () => ({ messages: [commentary, toolResult, createAssistantMessage({ content: 'The finished note.' })], terminal: { reason: 'completed' as const } }) })
  assert.equal(success?.stored, true, 'a completed ask with a final text reply must store the note; check askForHandoff in src/sessions/mneme/handoffAsk.ts')
  assert.equal(success?.text, 'The finished note.', 'the stored note must be the final assistant text only; check assistantText and askForHandoff in src/sessions/mneme/handoffAsk.ts')
  console.log('HANDOFF FINAL REPLY GREEN')
} finally {
  rmSync(home, { recursive: true, force: true })
}
