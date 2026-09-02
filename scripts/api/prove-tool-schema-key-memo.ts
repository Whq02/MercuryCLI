#!/usr/bin/env bun
// ============================================================================
//  scripts/api/prove-tool-schema-key-memo.ts — the tool-schema cache KEY is
//  serialized once per schema object, and identity is the invalidation.
//
//  The shared tool-schema cache already memoized the expensive prompt +
//  schema build, but the cache KEY re-ran jsonStringify over every explicit
//  inputJSONSchema on EVERY call — per MCP tool per request. The key's
//  serialization is now memoized by the schema OBJECT's identity. Laws:
//
//   K1  (counted operations) across N toolToAPISchema calls for the same
//       tool, the schema object is walked ONCE — instrumented by a counting
//       property getter on the schema itself, no builtin patching;
//   K2  (identity = invalidation) a REPLACED schema object on the same tool
//       name is walked afresh and lands a DIFFERENT cache row — the two
//       builds carry their own input_schema bytes (no stale-key collision);
//   K3  the memo shares across tool objects carrying the SAME schema
//       object, and never confuses two tools of the same name with
//       different schemas.
//
//  Run: ~/.bun/bin/bun run scripts/api/prove-tool-schema-key-memo.ts
// ============================================================================
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
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

/** A schema whose serialization is observable: JSON.stringify reads the
 *  `properties` getter once per walk. */
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

const buildOnce = (tool: Record<string, unknown>) =>
  toolToAPISchema(tool as never, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [tool] as never,
    agents: [],
    model: 'claude-sonnet-5',
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
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
