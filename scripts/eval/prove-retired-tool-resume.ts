import { deepStrictEqual } from 'node:assert'
import { check, cleanup, finish, setup } from './lib.js'
import { CODE_TOOL_SPELLINGS, CODE_TOOL_KEYS } from '../identity/forbidden-code-tool.js'

const checkWithHint = (label: string, cond: boolean, hint: string, detail = ''): void => check(label, cond, cond ? detail : detail ? `${detail} — ${hint}` : hint)

setup()
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')
const { getEmptyToolPermissionContext, findToolByName } = await import('../../src/tools/kit/tool.js')
const { clearToolRosterLatches, clearToolRosterRestore, conversationRosterKey, planToolPayload } = await import('../../src/models/roads/toolEconomy.js')
const { restoreBoundPrefixFromMessages } = await import('../../src/models/roads/anthropic/boundPrefixRecord.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/engine/messages/messages.js')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.js')
const { entryToRecord, recordToEntry } = await import('../../src/sessions/fabric/entryCodec.js')
const { findToolForRender } = await import('../../src/tools/mcp/absentToolShim.js')
const { getEngineModel } = await import('../../src/models/catalogue/engineModel.js')
const { storeArtifact, getArtifact } = await import('../../src/sessions/artifacts/store.js')
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
  checkWithHint('a missing saved definition uses the ordinary frozen-roster stub', restored !== undefined && typeof restored.call !== 'function' && !plan.restoredMissingTools.includes(name), 'fix planToolPayload and seedRosterLatchFromRestore in src/models/roads/toolEconomy.ts so a saved name with no live tool becomes a non-callable stub and is not listed in restoredMissingTools')
}
checkWithHint('the saved name and a nonsense name take identical restore roads', JSON.stringify(facts[0]) === JSON.stringify(facts[1]), 'the retired name must not get its own branch in planToolPayload (src/models/roads/toolEconomy.ts) or restoreBoundPrefixFromMessages (src/models/roads/anthropic/boundPrefixRecord.ts)', JSON.stringify(facts))
const use = { type: 'tool_use' as const, id: 'saved-cell', name: retired, input: { [CODE_TOOL_KEYS[0]]: [{ language: 'js', code: '1' }] } }
const result = { type: 'tool_result' as const, tool_use_id: use.id, content: '[cell saved] original bytes', is_error: false }
for (const entry of [createAssistantMessage({ content: [use] }), createUserMessage({ content: [result] })]) {
  const record = entryToRecord(entry as never, { sessionId: 'resume-proof' as never, nextOrdinal: () => 1 as never, observedAt: new Date(0).toISOString(), source: { channel: 'proof' } as never })
  const replay = recordToEntry(record)
  let equal = true
  try { deepStrictEqual((replay.message as any).content, entry.message.content) } catch { equal = false }
  checkWithHint('saved tool blocks round-trip byte-identically', equal, 'entryToRecord and recordToEntry in src/sessions/fabric/entryCodec.ts must return the tool_use and tool_result content unchanged')
}
const shim = findToolForRender(pool, retired)
checkWithHint('saved rows use the ordinary absent-tool shim', findToolByName(pool, retired) === undefined && shim.name === retired && shim !== pool.find(tool => tool.name === 'Eval'), 'findToolForRender in src/tools/mcp/absentToolShim.ts must return a shim named for the saved row, and the live tool pool must not resolve the retired name')
const artifact = await storeArtifact({ scope: retired.toLowerCase(), name: 'saved-output', content: 'durable output', kind: 'cell-output' })
const loaded = await getArtifact(retired.toLowerCase(), artifact.id)
checkWithHint('generic artifact scope still resolves saved output', loaded !== null && JSON.stringify(loaded).includes('durable output'), 'storeArtifact and getArtifact in src/sessions/artifacts/store.ts must keep resolving an arbitrary scope string', JSON.stringify(loaded))
clearToolRosterLatches()
clearToolRosterRestore()
cleanup()
finish('EVAL GENERIC RESUME')
