#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const ROOT = resolve(import.meta.dir, '..', '..')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const law = await import('../../src/models/roads/lawfulPrefixChange.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

law.resetLawfulPrefixChanges()
law.declareLawfulPrefixChange('main', 'the operator changed a setting')
check("an owner's own declaration is consumed once by that owner", law.consumeLawfulPrefixChange('main') === 'the operator changed a setting' && law.consumeLawfulPrefixChange('main') === null, 'declareLawfulPrefixChange and consumeLawfulPrefixChange in src/models/roads/lawfulPrefixChange.ts must hand an owner its own declaration exactly once')
check("…and never by another owner", (law.declareLawfulPrefixChange('main', 'again'), law.consumeLawfulPrefixChange('agent-1') === null), 'consumeLawfulPrefixChange in src/models/roads/lawfulPrefixChange.ts must not hand one owner another owner\'s declaration')
law.resetLawfulPrefixChanges()
law.declareLawfulPrefixChangeForEveryOwner('the operator toggled sub-agents on')
check('a process-wide declaration reaches the main thread', law.consumeLawfulPrefixChange('main') === 'the operator toggled sub-agents on', 'declareLawfulPrefixChangeForEveryOwner in src/models/roads/lawfulPrefixChange.ts must reach the main thread')
check('…and every sub-agent, each once', law.consumeLawfulPrefixChange('agent-1') === 'the operator toggled sub-agents on' && law.consumeLawfulPrefixChange('agent-2') === 'the operator toggled sub-agents on' && law.consumeLawfulPrefixChange('agent-1') === null, 'declareLawfulPrefixChangeForEveryOwner in src/models/roads/lawfulPrefixChange.ts must reach every owner once each')
check('a peek reads the shared clause for an owner that has not consumed it, and nothing for one that has', law.pendingLawfulPrefixChange('agent-3') === 'the operator toggled sub-agents on' && law.pendingLawfulPrefixChange('agent-1') === null, 'pendingLawfulPrefixChange in src/models/roads/lawfulPrefixChange.ts must read the shared clause without consuming it, and only for an owner that has not consumed it')
law.declareLawfulPrefixChange('agent-3', 'its own tool set changed')
check("an owner's own clause outranks the shared one", law.consumeLawfulPrefixChange('agent-3') === 'its own tool set changed' && law.consumeLawfulPrefixChange('agent-3') === 'the operator toggled sub-agents on', 'consumeLawfulPrefixChange in src/models/roads/lawfulPrefixChange.ts must serve an owner\'s own clause before the shared one')
law.resetLawfulPrefixChanges()
check('a reset forgets the shared clause too', law.consumeLawfulPrefixChange('main') === null, 'resetLawfulPrefixChanges in src/models/roads/lawfulPrefixChange.ts must clear the shared clause as well as per-owner ones')

console.log(failures === 0 ? '\nprove-lawful-change-owners: all green' : `\nprove-lawful-change-owners: ${failures} FAILURE(S)`)

{
  const { toolToAPISchema } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
  const { clearToolSchemaCache, clearConversationToolSchemas, getToolSchemaCache } = await import('../../src/models/roads/toolSchemaCache.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
  const model = 'claude-fable-5-1'
  const fixture = (field: string) => ({
    name: 'mcp__fixture__read',
    inputJSONSchema: { type: 'object', properties: { [field]: { type: 'string' } } },
    prompt: async () => `Read with ${field}`,
  })
  const build = (tool: ReturnType<typeof fixture>, scope = 'main', bound = true) => toolToAPISchema(tool as never, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [tool] as never,
    agents: [],
    model,
    conversationKey: `${scope}|first|${model}`,
    bound,
  })
  clearToolSchemaCache()
  clearConversationToolSchemas()
  law.resetLawfulPrefixChanges()
  const original = fixture('before')
  const refreshed = fixture('after')
  const first = JSON.stringify(await build(original))
  const child = JSON.stringify(await build(original, 'child'))
  law.requestDeliberateToolChange('main', [refreshed] as never, 'the server was manually reconnected')
  check('a reconnect request declares no prefix change — nothing it does moves the wire', law.pendingLawfulPrefixChange('main') === null, 'requestDeliberateToolChange in src/models/roads/lawfulPrefixChange.ts must not declare a prefix change')
  check('a reconnect request re-renders the base definitions (the memo is cleared) so a refreshed description or input is seen', getToolSchemaCache().size === 0, 'requestDeliberateToolChange in src/models/roads/lawfulPrefixChange.ts must clear the base-definition memo (src/models/roads/toolSchemaCache.ts)')
  check('a BOUND tool keeps the definition it was sent with after the reconnect, in every conversation: the refreshed input rides a new row, never the prefix', JSON.stringify(await build(refreshed)) === first && JSON.stringify(await build(refreshed, 'child')) === child && law.pendingLawfulPrefixChange('main') === null, 'toolToAPISchema in src/engine/messages/apiSystemAndToolSchema.ts must keep the conversation copy of a bound tool after a reconnect (copies live in src/models/roads/toolSchemaCache.ts)')
  const live = JSON.stringify(await build(refreshed, 'main', false))
  check('an UNBOUND deferred tool (listed, never referenced) takes the refreshed definition at once: it is outside the bound prefix, so nothing drops and nothing is declared', live !== first && live.includes('after') && law.pendingLawfulPrefixChange('main') === null, live + ' — toolToAPISchema in src/engine/messages/apiSystemAndToolSchema.ts must take the refreshed definition for an unbound tool without declaring a prefix change')
  check('once adopted, the refreshed definition is the conversation copy a bound read returns too', JSON.stringify(await build(refreshed)) === live, 'toolToAPISchema in src/engine/messages/apiSystemAndToolSchema.ts must store the adopted definition as the conversation copy')
  clearConversationToolSchemas('main')
  check('a new conversation starts from the live definition', JSON.stringify(await build(refreshed)) === live && law.pendingLawfulPrefixChange('main') === null, 'clearConversationToolSchemas in src/models/roads/toolSchemaCache.ts must drop the conversation copy so toolToAPISchema in src/engine/messages/apiSystemAndToolSchema.ts rebuilds from the live definition')
  clearConversationToolSchemas()
  law.resetLawfulPrefixChanges()
}

console.log(failures === 0 ? 'deliberate tool changes: all green' : `deliberate tool changes: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
