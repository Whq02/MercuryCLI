import { deepStrictEqual } from 'node:assert'
import { check, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS, CODE_TOOL_KEYS } from '../identity/forbidden-code-tool.js'

setup()
const { getAllBaseTools } = await import('../../src/tools.js')
const { getEmptyToolPermissionContext, findToolByName } = await import('../../src/Tool.js')
const { clearToolRosterLatches, clearToolRosterRestore, conversationRosterKey, planToolPayload } = await import('../../src/services/providers/toolEconomy.js')
const { restoreBoundPrefixFromMessages } = await import('../../src/services/providers/anthropic/boundPrefixRecord.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/services/messages.js')
const { createAttachmentMessage } = await import('../../src/services/attachments/orchestrator.js')
const { entryToRecord, recordToEntry } = await import('../../src/fabric/entryCodec.js')
const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.js')
const { getEngineModel } = await import('../../src/services/model/model.js')
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
  check('a missing saved definition uses the ordinary frozen-roster stub', restored !== undefined && typeof restored.call !== 'function' && !plan.restoredMissingTools.includes(name), `${JSON.stringify(facts[facts.length - 1])}; a saved tool name with no live definition must restore as a non-executable stub and not be listed as missing: see planToolPayload in src/services/providers/toolEconomy.ts`)
}
check('the saved name and a nonsense name take identical restore roads', JSON.stringify(facts[0]) === JSON.stringify(facts[1]), `${JSON.stringify(facts)}; the retired spelling must not get a restore road of its own: see planToolPayload in src/services/providers/toolEconomy.ts`)
const use = { type: 'tool_use' as const, id: 'saved-cell', name: retired, input: { [CODE_TOOL_KEYS[0]]: [{ language: 'js', code: '1' }] } }
const result = { type: 'tool_result' as const, tool_use_id: use.id, content: '[cell saved] original bytes', is_error: false }
for (const entry of [createAssistantMessage({ content: [use] }), createUserMessage({ content: [result] })]) {
  const record = entryToRecord(entry as never, { sessionId: 'resume-proof' as never, nextOrdinal: () => 1 as never, observedAt: new Date(0).toISOString(), source: { channel: 'proof' } as never })
  const replay = recordToEntry(record)
  let equal = true
  try { deepStrictEqual((replay.message as any).content, entry.message.content) } catch { equal = false }
  check('saved tool blocks round-trip byte-identically', equal, 'a saved tool_use or tool_result block must replay with identical content: see entryToRecord and recordToEntry in src/fabric/entryCodec.ts')
}
const shim = findToolForRender(pool, retired)
check('saved rows use the ordinary absent-tool shim', findToolByName(pool, retired) === undefined && shim.name === retired && shim !== pool.find(tool => tool.name === 'Eval'), `shim name ${shim.name}; a saved row naming a tool that is not in the pool must render through the absent-tool shim and never as Eval: see findToolForRender in src/tools/MCPTool/absentToolShim.ts`)
const artifact = await storeArtifact({ scope: retired.toLowerCase(), name: 'saved-output', content: 'durable output', kind: 'cell-output' })
const loaded = await getArtifact(retired.toLowerCase(), artifact.id)
check('generic artifact scope still resolves saved output', loaded !== null && JSON.stringify(loaded).includes('durable output'), `${JSON.stringify(loaded)}; an artifact stored under any scope name must be readable back by that scope and id: see storeArtifact and getArtifact in src/utils/artifacts/store.ts`)
clearToolRosterLatches()
clearToolRosterRestore()
cleanup()
finish('EVAL GENERIC RESUME')
