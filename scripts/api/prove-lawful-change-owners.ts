#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const ROOT = resolve(import.meta.dir, '..', '..')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const law = await import('../../src/services/providers/lawfulPrefixChange.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

law.resetLawfulPrefixChanges()
law.declareLawfulPrefixChange('main', 'the operator changed a setting')
check("an owner's own declaration is consumed once by that owner", law.consumeLawfulPrefixChange('main') === 'the operator changed a setting' && law.consumeLawfulPrefixChange('main') === null)
check("…and never by another owner", (law.declareLawfulPrefixChange('main', 'again'), law.consumeLawfulPrefixChange('agent-1') === null))
law.resetLawfulPrefixChanges()
law.declareLawfulPrefixChangeForEveryOwner('the operator toggled sub-agents on')
check('a process-wide declaration reaches the main thread', law.consumeLawfulPrefixChange('main') === 'the operator toggled sub-agents on')
check('…and every sub-agent, each once', law.consumeLawfulPrefixChange('agent-1') === 'the operator toggled sub-agents on' && law.consumeLawfulPrefixChange('agent-2') === 'the operator toggled sub-agents on' && law.consumeLawfulPrefixChange('agent-1') === null)
check('a peek reads the shared clause for an owner that has not consumed it, and nothing for one that has', law.pendingLawfulPrefixChange('agent-3') === 'the operator toggled sub-agents on' && law.pendingLawfulPrefixChange('agent-1') === null)
law.declareLawfulPrefixChange('agent-3', 'its own tool set changed')
check("an owner's own clause outranks the shared one", law.consumeLawfulPrefixChange('agent-3') === 'its own tool set changed' && law.consumeLawfulPrefixChange('agent-3') === 'the operator toggled sub-agents on')
law.resetLawfulPrefixChanges()
check('a reset forgets the shared clause too', law.consumeLawfulPrefixChange('main') === null)
const print = readFileSync(join(ROOT, 'src/cli/run.ts'), 'utf8')
check('the spawn-switch toggle declares for every owner', print.includes('declareLawfulPrefixChangeForEveryOwner(`you turned ${SPAWN_SWITCH_LABEL[kind]}'))

console.log(failures === 0 ? '\nprove-lawful-change-owners: all green' : `\nprove-lawful-change-owners: ${failures} FAILURE(S)`)

{
  const { toolToAPISchema } = await import('../../src/utils/api.ts')
  const { clearToolSchemaCache, clearConversationToolSchemas, getToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
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
  check('a reconnect request declares no prefix change — nothing it does moves the wire', law.pendingLawfulPrefixChange('main') === null)
  check('a reconnect request re-renders the base definitions (the memo is cleared) so a refreshed description or input is seen', getToolSchemaCache().size === 0)
  check('a BOUND tool keeps the definition it was sent with after the reconnect, in every conversation: the refreshed input rides a new row, never the prefix', JSON.stringify(await build(refreshed)) === first && JSON.stringify(await build(refreshed, 'child')) === child && law.pendingLawfulPrefixChange('main') === null)
  const live = JSON.stringify(await build(refreshed, 'main', false))
  check('an UNBOUND deferred tool (listed, never referenced) takes the refreshed definition at once: it is outside the bound prefix, so nothing drops and nothing is declared', live !== first && live.includes('after') && law.pendingLawfulPrefixChange('main') === null, live)
  check('once adopted, the refreshed definition is the conversation copy a bound read returns too', JSON.stringify(await build(refreshed)) === live)
  clearConversationToolSchemas('main')
  check('a new conversation starts from the live definition', JSON.stringify(await build(refreshed)) === live && law.pendingLawfulPrefixChange('main') === null)
  clearConversationToolSchemas()
  law.resetLawfulPrefixChanges()
}
const adapter = readFileSync(join(ROOT, 'src/services/mcp/useManageMCPConnections.ts'), 'utf8')
check('the interactive adapter requests refreshed definitions after a successful manual reconnect', /event\.cause === 'reconnect-manual' && event\.connection\.type === 'connected' && event\.tools !== undefined\) \{\s*requestDeliberateToolChange/.test(adapter))
check('…and after a tools/list_changed refetch, so the refreshed definitions are seen without a restart', /gateRefetchedTools\(client\.name, refetched as Tool\[\]\)\s*\n\s*requestDeliberateToolChange\(/.test(adapter))

console.log(failures === 0 ? 'deliberate tool changes: all green' : `deliberate tool changes: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
