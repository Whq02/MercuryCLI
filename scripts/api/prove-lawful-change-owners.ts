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
const print = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
check('the spawn-switch toggle declares for every owner', print.includes('declareLawfulPrefixChangeForEveryOwner(`the operator toggled ${SPAWN_SWITCH_LABEL[kind]}'))

console.log(failures === 0 ? '\nprove-lawful-change-owners: all green' : `\nprove-lawful-change-owners: ${failures} FAILURE(S)`)

{
  const { toolToAPISchema } = await import('../../src/utils/api.ts')
  const { clearToolSchemaCache, clearConversationToolSchemas } = await import('../../src/utils/toolSchemaCache.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const model = 'claude-fable-5-1'
  const fixture = (field: string) => ({
    name: 'mcp__fixture__read',
    inputJSONSchema: { type: 'object', properties: { [field]: { type: 'string' } } },
    prompt: async () => `Read with ${field}`,
  })
  const build = (tool: ReturnType<typeof fixture>, scope = 'main') => toolToAPISchema(tool as never, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [tool] as never,
    agents: [],
    model,
    conversationKey: `${scope}|first|${model}`,
  })
  clearToolSchemaCache()
  clearConversationToolSchemas()
  law.resetLawfulPrefixChanges()
  const original = fixture('before')
  const selected = fixture('after')
  const unsolicited = fixture('unsolicited')
  const first = JSON.stringify(await build(original))
  const child = JSON.stringify(await build(original, 'child'))
  law.requestDeliberateToolChange('main', [selected] as never, 'the server was manually reconnected')
  check('a reconnect request alone declares no prefix change', law.pendingLawfulPrefixChange('main') === null)
  check('an older in-flight tool does not consume the requested definition change', JSON.stringify(await build(original)) === first && law.pendingLawfulPrefixChange('main') === null)
  clearToolSchemaCache()
  check('an unsolicited same-name refresh is not mistaken for the selected tool', JSON.stringify(await build(unsolicited)) === first && law.pendingLawfulPrefixChange('main') === null)
  const changed = JSON.stringify(await build(selected))
  check('the requested definition replaces only its conversation copy', changed !== first && changed.includes('after') && JSON.stringify(await build(selected, 'child')) === child)
  check('an actual serialized change declares its specific reason once', law.consumeLawfulPrefixChange('main') === 'the server was manually reconnected' && law.consumeLawfulPrefixChange('main') === null && law.consumeLawfulPrefixChange('child') === null)
  check('later unsolicited refreshes keep the newly selected definition', JSON.stringify(await build(unsolicited)) === changed && law.pendingLawfulPrefixChange('main') === null)
  law.requestDeliberateToolChange('main', [selected] as never, 'an unchanged reconnect')
  check('an unchanged reconnect has no change declaration', JSON.stringify(await build(selected)) === changed && law.pendingLawfulPrefixChange('main') === null)
  const renamed = { ...selected, prompt: async () => 'An explicitly refreshed description' }
  law.requestDeliberateToolChange('main', [renamed] as never, 'the tool description was refreshed')
  await toolToAPISchema(selected as never, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [selected] as never,
    agents: [],
    model,
  })
  check('a selected refresh renders its description even if another caller repopulated the base cache', JSON.stringify(await build(renamed)).includes('An explicitly refreshed description') && law.consumeLawfulPrefixChange('main') === 'the tool description was refreshed')
  law.requestDeliberateToolChange('main', [unsolicited] as never, 'a cancelled refresh')
  clearConversationToolSchemas('main')
  await build(unsolicited)
  check('a new conversation does not inherit a pending refresh reason', law.pendingLawfulPrefixChange('main') === null)
  clearConversationToolSchemas()
  law.resetLawfulPrefixChanges()
}
const adapter = readFileSync(join(ROOT, 'src/services/mcp/useManageMCPConnections.ts'), 'utf8')
check('the interactive adapter requests refreshed definitions only after a successful manual reconnect', /event\.cause === 'reconnect-manual' && event\.connection\.type === 'connected' && event\.tools !== undefined\) \{\s*requestDeliberateToolChange/.test(adapter))
check('the SDK manual reconnect refreshes definitions after discovery', /case 'mcp_reconnect':[\s\S]*?applyReconnectedClient\(serverName, client, true\)/.test(print) && /if \(refreshDefinitions && client\.type === 'connected'\) \{\s*requestDeliberateToolChange/.test(print))

console.log(failures === 0 ? 'deliberate tool changes: all green' : `deliberate tool changes: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
