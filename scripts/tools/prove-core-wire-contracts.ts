import { proofHome } from '../lib/hermetic.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getToolManualAttachments } = await import('../../src/utils/attachments/toolManuals.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { isNullRenderingAttachment } = await import('../../src/components/messages/nullRenderingAttachments.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const names = ['Read', 'Edit', 'Eval', 'Test', 'AstSearch', 'LspRead']
const tools = getAllBaseTools()
const permission = getEmptyToolPermissionContext()
const options = { getToolPermissionContext: async () => permission, tools, agents: [], model: 'glm-5.3', conversationKey: proofHome }
const context: any = { options: { tools, engineModel: options.model, agentDefinitions: { activeAgents: [] } }, getAppState: () => ({ toolPermissionContext: permission, mcp: { clients: [] } }), messages: [] }
const corpus = JSON.parse(readFileSync(join(import.meta.dir, '../tool-economy/fixtures/definition-corpus.json'), 'utf8'))
const shape = (value: any): any => Array.isArray(value) ? value.map(shape) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, shape(item)])) : value
assert.deepEqual(await getToolManualAttachments(context), [])
for (const name of names) {
  const tool = tools.find(tool => tool.name === name)!
  assert.ok(tool, name)
  const full = await tool.prompt(options)
  const schema: any = await toolToAPISchema(tool, options)
  assert.ok(tool.wireDescription, `${name} still sends the full manual on every request`)
  assert.ok(Buffer.byteLength(schema.description) < Buffer.byteLength(full), name)
  assert.deepEqual(shape(schema.input_schema), shape(corpus.definitions.find((row: any) => row.name === name).input_schema), `${name} keeps every input and bound`)
  const picked = await ToolSearchTool.call({ query: `select:${name}`, max_results: 1 }, context)
  const manual: any = picked.newMessages?.find((message: any) => message.attachment?.content === `# Tool manual: ${name}\n\n${full}`)
  assert.ok(manual, `${name} keeps its full manual on explicit discovery`)
  assert.ok(isNullRenderingAttachment(manual))
  context.messages.push(manual)
  assert.equal((await getToolManualAttachments(context, [name])).length, 0)
  console.log(JSON.stringify({ name, manualBytes: Buffer.byteLength(full), contractBytes: Buffer.byteLength(schema.description), saved: Buffer.byteLength(full) - Buffer.byteLength(schema.description) }))
}
const crew = tools.find(tool => tool.name === 'Crewmate')!
const crewManual = await crew.prompt(options)
assert.ok(crewManual.includes('## When delegating is the wrong move'))
assert.ok(crewManual.includes('## Model selection') && crewManual.includes("'qwen'"))
assert.ok(!crewManual.includes('[object Promise]'))
const crewSchema: any = await toolToAPISchema(crew, options)
assert.deepEqual(shape(crewSchema.input_schema), shape(corpus.definitions.find((row: any) => row.name === 'Crewmate').input_schema))
assert.ok(Buffer.byteLength(crewSchema.input_schema.properties.model.description) < 600)
const restored = await getToolManualAttachments({ ...context, messages: [{ type: 'system', subtype: 'compact_boundary', compactMetadata: { preCompactDiscoveredTools: names } }] })
assert.equal(restored.length, names.length)
assert.equal((await getToolManualAttachments({ ...context, messages: restored.map(createAttachmentMessage) }, names)).length, 0)
console.log('PASS core schemas retain inputs, limits, discovery, manuals and compaction replay without screen rows')
