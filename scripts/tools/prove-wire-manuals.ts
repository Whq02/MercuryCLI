import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ceiling = 4096
const names = ['Workflow', 'Debug', 'Browser', 'Crewmate']
const capture = process.argv.indexOf('--capture')
if (capture >= 0) {
  const requests = JSON.parse(readFileSync(process.argv[capture + 1]!, 'utf8'))
  const tools = requests.find((request: any) => Array.isArray(request.body?.tools)).body.tools
  for (const name of names) {
    const description = tools.find((tool: any) => tool.name === name)?.description
    assert.equal(typeof description, 'string', name)
    const bytes = Buffer.byteLength(description)
    console.log(`${name} wire description: ${bytes} bytes (ceiling ${ceiling})`)
    assert.ok(bytes <= ceiling, `${name} carries a manual in its wire description`)
  }
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'wire-manuals-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
try {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { WorkflowTool } = await import('../../src/tools/WorkflowTool/WorkflowTool.tsx')
  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.ts')
  const { BrowserTool } = await import('../../src/tools/BrowserTool/BrowserTool.ts')
  const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { toolToAPISchema } = await import('../../src/utils/api.ts')
  const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
  const { getToolManualAttachments } = await import('../../src/utils/attachments/toolManuals.ts')
  const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
  const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
  const { isNullRenderingAttachment } = await import('../../src/components/messages/nullRenderingAttachments.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
  const tools: import('../../src/Tool.js').Tool[] = [WorkflowTool, DebugTool, BrowserTool, AgentTool, ToolSearchTool]
  const permission = getEmptyToolPermissionContext()
  const options = { getToolPermissionContext: async () => permission, tools, agents: [], model: 'claude-fable-5-1', conversationKey: 'wire-manual-proof' }
  const context: any = { options: { tools, engineModel: options.model, agentDefinitions: { activeAgents: [] } }, getAppState: () => ({ toolPermissionContext: permission, mcp: { clients: [] } }), messages: [] }
  assert.equal((await getToolManualAttachments(context)).length, 0, 'unused tools send no manual')
  const before = await Promise.all(tools.map(tool => toolToAPISchema(tool, options)))
  const picked = await ToolSearchTool.call({ query: 'select:' + names.join(','), max_results: 5 }, context)
  assert.deepEqual(picked.data.matches, names)
  assert.equal(picked.newMessages?.length, 4, 'ToolSearch loads every complete manual')
  for (const tool of tools.slice(0, 4)) {
    const full = await tool.prompt(options)
    const schema = before.find(row => row.name === tool.name) as any
    const bytes = Buffer.byteLength(schema.description)
    console.log(JSON.stringify({ tool: tool.name, manualBytes: Buffer.byteLength(full), wireBytes: bytes, ceiling }))
    assert.ok(bytes <= ceiling && bytes < Buffer.byteLength(full), tool.name)
    assert.equal(schema.description, tool.wireDescription!(full))
    const delivered: any = picked.newMessages!.find((message: any) => message.attachment.content.startsWith(`# Tool manual: ${tool.name}\n`))
    assert.equal(delivered.attachment.content, `# Tool manual: ${tool.name}\n\n${full}`, 'not one manual sentence is lost')
    assert.ok(isNullRenderingAttachment(delivered), 'manuals never paint a screen row')
    assert.ok(JSON.stringify(normalizeAttachmentForAPI(delivered.attachment)).includes(tool.name))
    if (['Browser', 'Debug'].includes(tool.name)) {
      const operations = schema.input_schema.properties.op.enum as string[]
      for (const operation of operations) assert.ok(schema.description.includes(operation), `${tool.name} must keep ${operation} in the short contract`)
    }
  }
  context.messages = JSON.parse(JSON.stringify(picked.newMessages))
  const repeated = await ToolSearchTool.call({ query: 'select:' + names.join(','), max_results: 5 }, context)
  assert.equal(repeated.newMessages, undefined, 'resume and a second load never resend a visible manual')
  clearToolSchemaCache()
  assert.deepEqual(await Promise.all(tools.map(tool => toolToAPISchema(tool, options))), before, 'loading manuals never rewrites the bound tool schemas')
  assert.equal((await getToolManualAttachments({ ...context, messages: [] })).length, 0, 'another thread does not inherit discovery')
  const direct = createAssistantMessage({ content: [{ type: 'tool_use', name: 'Debug', id: 'direct-debug', input: { op: 'status' } }] })
  const onUse = await getToolManualAttachments({ ...context, messages: [direct] })
  assert.equal(onUse.length, 1, 'the non-deferred road delivers the manual on first use')
  assert.equal((await getToolManualAttachments({ ...context, messages: [direct, ...onUse.map(createAttachmentMessage)] })).length, 0)
  const loaded = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'search', content: [{ type: 'tool_reference', tool_name: 'Browser' }] } as any] })
  assert.equal((await getToolManualAttachments({ ...context, messages: [loaded] })).length, 1, 'discovery records deliver notes before the next call')
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'manual-fold', compactMetadata: { preCompactDiscoveredTools: names } }
  assert.equal((await getToolManualAttachments({ ...context, messages: [...context.messages, boundary] })).length, 4, 'compaction restores manuals for tools carried across the boundary')
  console.log('PASS short wire contracts retain full manuals on discovery and use without moving the prefix')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
