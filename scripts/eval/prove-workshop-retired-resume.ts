import { deepStrictEqual } from 'node:assert'
import { check, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS, CODE_TOOL_KEYS } from '../identity/forbidden-code-tool.js'

setup()
const { getAllBaseTools } = await import('../../src/tools.js')
const { getEmptyToolPermissionContext, findToolByName } = await import('../../src/Tool.js')
const { clearToolRosterLatches, clearToolRosterRestore, conversationRosterKey, planToolPayload } = await import('../../src/services/providers/toolEconomy.js')
const { restoreBoundPrefixFromMessages } = await import('../../src/services/providers/anthropic/boundPrefixRecord.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.js')
const { entryToRecord, recordToEntry } = await import('../../src/fabric/entryCodec.js')
const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.js')
const { getEngineModel } = await import('../../src/utils/model/model.js')
const { storeArtifact, getArtifact } = await import('../../src/utils/artifacts/store.js')
const model = getEngineModel()
const pool = getAllBaseTools()
const retired = CODE_TOOL_SPELLINGS[0]
const first = createUserMessage({ content: 'resume cell transcript' })
const facts: unknown[] = []
for (const name of [retired, 'NoSuchCellRuntime']) {
  clearToolRosterLatches()
  clearToolRosterRestore()
  const definition = JSON.stringify({ name, description: 'saved code definition', input_schema: { type: 'object' } })
  const key = conversationRosterKey('resume-proof', [first], model)
  const saved = createAttachmentMessage({ type: 'bound_prefix', boundKey: key, rosterEnabled: true, roster: [{ name, deferred: false, definition }], sections: [], systemContext: {} })
  restoreBoundPrefixFromMessages([first, saved], { rosterOnly: true })
  const plan = await planToolPayload({ model, tools: pool, messages: [first, saved], latchKey: 'resume-proof', getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [] })
  const restored = plan.roster.find(tool => tool.name === name)
  facts.push({ present: restored !== undefined, executable: typeof restored?.call === 'function', missing: plan.restoredMissingTools.map(value => value === name ? '<name>' : value) })
  check('a missing saved definition uses the ordinary frozen-roster stub', restored !== undefined && typeof restored.call !== 'function' && !plan.restoredMissingTools.includes(name))
}
check('the saved name and a nonsense name take identical restore roads', JSON.stringify(facts[0]) === JSON.stringify(facts[1]), JSON.stringify(facts))
const use = { type: 'tool_use' as const, id: 'saved-cell', name: retired, input: { [CODE_TOOL_KEYS[0]]: [{ language: 'js', code: '1' }] } }
const result = { type: 'tool_result' as const, tool_use_id: use.id, content: '[cell saved] original bytes', is_error: false }
for (const entry of [createAssistantMessage({ content: [use] }), createUserMessage({ content: [result] })]) {
  const record = entryToRecord(entry as never, { sessionId: 'resume-proof' as never, nextOrdinal: () => 1 as never, observedAt: new Date(0).toISOString(), source: { channel: 'proof' } as never })
  const replay = recordToEntry(record)
  let equal = true
  try { deepStrictEqual((replay.message as any).content, entry.message.content) } catch { equal = false }
  check('saved tool blocks round-trip byte-identically', equal)
}
const shim = findToolForRender(pool, retired)
check('saved rows use the ordinary absent-tool shim', findToolByName(pool, retired) === undefined && shim.name === retired && shim !== pool.find(tool => tool.name === 'Eval'))
const artifact = await storeArtifact({ scope: retired.toLowerCase(), name: 'saved-output', content: 'durable output', kind: 'cell-output' })
const loaded = await getArtifact(retired.toLowerCase(), artifact.id)
check('generic artifact scope still resolves saved output', loaded !== null && JSON.stringify(loaded).includes('durable output'), JSON.stringify(loaded))
clearToolRosterLatches()
clearToolRosterRestore()
cleanup()
finish('EVAL GENERIC RESUME')
