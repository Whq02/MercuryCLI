import '../lib/hermetic.ts'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'fake'
process.env.NODE_ENV = 'test'
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.ts')
const { ComputerTool } = await import('../../src/tools/computer/ComputerTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { toolToAPISchema } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
const { mapToolsToZai } = await import('../../src/models/roads/zai/zaiCodec.ts')

const tools = [...new Map([...getAllBaseTools(), ComputerTool].map(tool => [tool.name, tool])).values()]
const schemas = await Promise.all(tools.map(tool => toolToAPISchema(tool, {
  getToolPermissionContext: async () => getEmptyToolPermissionContext(), tools, agents: [], model: 'compat/fixture',
})))
const wire = mapToolsToZai(schemas as never)
const references: string[] = []
function visit(value: unknown, path: string): void {
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' || key === '$defs') references.push(`${path}.${key}`)
    visit(child, `${path}.${key}`)
  }
}
for (const tool of wire) visit(tool.function.parameters, tool.function.name)
assert.deepEqual(references, [], 'every advertised tool schema must be self-contained on the chat-completions wire; inline the $ref or $defs found at ' + references.join(', ') + ' in mapToolsToZai in src/models/roads/zai/zaiCodec.ts or in toolToAPISchema in src/engine/messages/apiSystemAndToolSchema.ts')
const computer = wire.find(tool => tool.function.name === ComputerTool.name)!.function.parameters as any
assert.equal(computer.properties.steps.items.type, 'object', 'the Computer tool steps items must be an object schema; check the steps schema in src/tools/computer/call/schema.ts and how mapToolsToZai in src/models/roads/zai/zaiCodec.ts flattens it')
assert.deepEqual(Object.keys(computer.properties.steps.items.properties).sort(), Object.keys(computer.properties).filter(key => key !== 'steps').sort(), 'each Computer step must carry every top-level field except steps; check the steps schema in src/tools/computer/call/schema.ts and mapToolsToZai in src/models/roads/zai/zaiCodec.ts')
assert.match(computer.properties.steps.description, /Non-nested sequence/, 'the Computer steps description must say Non-nested sequence; restore it in the steps schema in src/tools/computer/call/schema.ts')
assert.deepEqual(computer.properties.steps.items.properties.action.enum, computer.properties.action.enum.filter((action: string) => action !== 'sequence'), 'the step action enum must equal the Computer action enum without sequence; check the steps schema in src/tools/computer/call/schema.ts')
assert.equal(ComputerTool.inputSchema.safeParse({ action: 'sequence', steps: [{ action: 'click', x: 1, y: 2 }] }).success, true, 'ComputerTool.inputSchema must accept a sequence of click steps; check inputSchema in src/tools/computer/call/schema.ts')
assert.equal(computer.properties.steps.items.properties.steps, undefined, 'a Computer step must not offer its own steps field; remove it from the wire schema in src/tools/computer/call/schema.ts or mapToolsToZai in src/models/roads/zai/zaiCodec.ts')
const { toolContext } = await import('../computer/computerToolKit.ts')
const nested = await ComputerTool.validateInput!({ action: 'sequence', steps: [{ action: 'sequence', steps: [{ action: 'click', x: 1, y: 2 }] }] }, toolContext())
assert.equal(nested.result, false, 'validateInput must reject a nested sequence; check the sequence step validation in src/tools/computer/call/schema.ts')
assert.match((nested as { message: string }).message, /no nested sequence/, 'the nested sequence refusal must say no nested sequence; check the sequence step validation in src/tools/computer/call/schema.ts')
console.log(`PASS ${wire.length} compat tool schemas contain no $ref or $defs; Computer steps retain every field without nesting`)
