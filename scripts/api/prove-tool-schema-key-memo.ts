#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache, clearConversationToolSchemas } = await import('../../src/utils/toolSchemaCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

function countingSchema(marker: string): { schema: Record<string, unknown>; walks: () => number } {
  let walks = 0
  const schema = {
    type: 'object',
    get properties() {
      walks++
      return { [marker]: { type: 'string' } }
    },
  }
  return { schema: schema as Record<string, unknown>, walks: () => walks }
}

function fakeTool(name: string, schema: Record<string, unknown>): Record<string, unknown> {
  return {
    name,
    prompt: async () => `description of ${name}`,
    inputJSONSchema: schema,
  }
}

const buildOnce = (tool: Record<string, unknown>, conversationKey?: string) =>
  toolToAPISchema(tool as never, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [tool] as never,
    agents: [],
    model: 'claude-sonnet-5',
    conversationKey,
  })

section('K1 · counted operations — one serialization per schema object across N calls')
{
  clearToolSchemaCache()
  const { schema, walks } = countingSchema('k1')
  const tool = fakeTool('memo-k1', schema)
  const N = 25
  for (let i = 0; i < N; i++) await buildOnce(tool)
  console.log(`  · schema walks across ${N} calls: ${walks()}`)
  check(
    `across ${N} calls the schema serialized ONCE (the previous shape walked it ${N}x for keys alone)`,
    walks() === 1,
    `walks=${walks()}`,
  )
}

section('K2 · identity is the invalidation — a replaced schema object lands its own row')
{
  clearToolSchemaCache()
  const a = countingSchema('shape-a')
  const b = countingSchema('shape-b')
  const builtA = await buildOnce(fakeTool('memo-k2', a.schema))
  const builtB = await buildOnce(fakeTool('memo-k2', b.schema))
  const propsA = JSON.stringify((builtA as { input_schema?: { properties?: unknown } }).input_schema?.properties)
  const propsB = JSON.stringify((builtB as { input_schema?: { properties?: unknown } }).input_schema?.properties)
  check('the replaced schema was walked afresh (both objects serialized)', a.walks() >= 1 && b.walks() >= 1, `a=${a.walks()} b=${b.walks()}`)
  check('same tool name, different schema objects ⇒ different schema bytes in the build', propsA !== propsB && propsA.includes('shape-a') && propsB.includes('shape-b'), `a=${propsA} b=${propsB}`)
}

section('K3 · the memo keys on the schema object, not the tool object')
{
  clearToolSchemaCache()
  const { schema, walks } = countingSchema('k3')
  await buildOnce(fakeTool('memo-k3-first', schema))
  await buildOnce(fakeTool('memo-k3-second', schema))
  check('two tool objects sharing ONE schema object serialized it once total', walks() === 1, `walks=${walks()}`)
}

console.log('\n' + '='.repeat(60))

section('K4 · serialized definitions survive refresh and isolate conversations')
{
  clearToolSchemaCache()
  clearConversationToolSchemas()
  const original = fakeTool('memo-frozen', { type: 'object', properties: { before: { type: 'string' }, cache_control: { type: 'string' } } })
  const changed = fakeTool('memo-frozen', { type: 'object', properties: { after: { type: 'number' } } })
  changed.prompt = async () => 'a changed description'
  const key = 'memo|first|claude-sonnet-5'
  const first = await buildOnce(original, key)
  const expected = JSON.stringify(first)
  ;(first as { input_schema: { properties: Record<string, unknown> } }).input_schema.properties.before = { type: 'boolean' }
  clearToolSchemaCache()
  const refreshed = await buildOnce(changed, key)
  check('a same-name replacement and credential-cache clear keep the first serialized definition', JSON.stringify(refreshed) === expected)
  check('mutating a returned schema cannot mutate the saved definition', JSON.stringify(refreshed).includes('"before":{"type":"string"}'))
  check('a real schema property named cache_control remains in the saved definition', JSON.stringify(refreshed).includes('"cache_control":{"type":"string"}'))
  const annotated = await toolToAPISchema(changed as never, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [changed] as never,
    agents: [],
    model: 'claude-sonnet-5',
    conversationKey: key,
    cacheControl: { type: 'ephemeral', ttl: '1h' },
  })
  const { cache_control, ...definition } = annotated as Record<string, unknown>
  check('only the request cache annotation overlays the saved definition', JSON.stringify(definition) === expected && JSON.stringify(cache_control) === '{"type":"ephemeral","ttl":"1h"}')
  const next = await buildOnce(changed, 'memo|next|claude-sonnet-5')
  check('a new conversation renders the new schema and description', JSON.stringify(next).includes('a changed description') && JSON.stringify(next).includes('"after"'))
  const other = await buildOnce(original, 'other|first|claude-sonnet-5')
  clearConversationToolSchemas('memo')
  const reset = await buildOnce(changed, key)
  const untouched = await buildOnce(changed, 'other|first|claude-sonnet-5')
  check('an explicit reset updates only its selected conversation group', JSON.stringify(reset) === JSON.stringify(next) && JSON.stringify(untouched) === JSON.stringify(other))
}

section('K5 · concurrent first renders publish one definition')
{
  clearToolSchemaCache()
  clearConversationToolSchemas()
  let release: () => void = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  const slow = fakeTool('memo-race', { type: 'object', properties: { slow: { type: 'string' } } })
  slow.prompt = async () => { await pending; return 'slow description' }
  const fast = fakeTool('memo-race', { type: 'object', properties: { fast: { type: 'number' } } })
  fast.prompt = async () => 'fast description'
  const key = 'race|first|claude-sonnet-5'
  const first = buildOnce(slow, key)
  const settled = await buildOnce(fast, key)
  release()
  check('overlapping renders return the first completed definition byte for byte', JSON.stringify(await first) === JSON.stringify(settled))
  check('later calls return that same definition', JSON.stringify(await buildOnce(slow, key)) === JSON.stringify(settled))
}
clearConversationToolSchemas()

console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
