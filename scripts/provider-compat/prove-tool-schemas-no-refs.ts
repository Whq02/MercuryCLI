import '../lib/hermetic.ts'
import assert from 'node:assert/strict'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'fake'
process.env.NODE_ENV = 'test'
const { getAllBaseTools } = await import('../../src/tools.ts')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { mapToolsToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')

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
assert.deepEqual(references, [], 'every advertised tool schema must be self-contained on the chat-completions wire')
const computer = wire.find(tool => tool.function.name === ComputerTool.name)!.function.parameters as any
assert.equal(computer.properties.steps.items.type, 'object')
assert.deepEqual(Object.keys(computer.properties.steps.items.properties).sort(), Object.keys(computer.properties).filter(key => key !== 'steps').sort())
assert.match(computer.properties.steps.description, /no nesting/)
assert.equal(ComputerTool.inputSchema.safeParse({ action: 'sequence', steps: [{ action: 'click', x: 1, y: 2 }] }).success, true)
assert.equal(computer.properties.steps.items.properties.steps, undefined)
const { toolContext } = await import('../computer/computerToolKit.ts')
const nested = await ComputerTool.validateInput!({ action: 'sequence', steps: [{ action: 'sequence', steps: [{ action: 'click', x: 1, y: 2 }] }] }, toolContext())
assert.equal(nested.result, false)
assert.match((nested as { message: string }).message, /no nested sequence/)
console.log(`PASS ${wire.length} compat tool schemas contain no $ref or $defs; Computer steps retain every field without nesting`)
