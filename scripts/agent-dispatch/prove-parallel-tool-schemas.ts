#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
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


const { toolToAPISchema } = await import('../../src/engine/messages/apiSystemAndToolSchema.ts')
const { clearToolSchemaCache } = await import('../../src/models/roads/toolSchemaCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')

type FakeTool = {
  name: string
  promptCalls: number
  prompt: (o: unknown) => Promise<string>
  inputJSONSchema: Record<string, unknown>
}

let pendingNow = 0
let maxPending = 0
function fakeTool(i: number, count: number): FakeTool {
  const t: FakeTool = {
    name: `fake-parallel-${i}`,
    promptCalls: 0,
    prompt: async () => {
      t.promptCalls++
      pendingNow++
      maxPending = Math.max(maxPending, pendingNow)
      await new Promise(resolve => setTimeout(resolve, 5 * (count - i)))
      pendingNow--
      return `description of tool ${i}`
    },
    inputJSONSchema: { type: 'object', properties: { [`p${i}`]: { type: 'string' } } },
  }
  return t
}

const COUNT = 6
const roster = Array.from({ length: COUNT }, (_v, i) => fakeTool(i, COUNT))
const buildOnce = () =>
  Promise.all(
    roster.map(tool =>
      toolToAPISchema(tool as never, {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        tools: roster as never,
        agents: [],
        model: 'claude-sonnet-5',
      }),
    ),
  )

section('P2 · cold-cache builds OVERLAP (max pending > 1; sequential pins it at 1)')
clearToolSchemaCache()
const schemas = await buildOnce()
{
  console.log(`  · max simultaneously-pending prompt() builds: ${maxPending} (roster ${COUNT})`)
  check('overlap observed: max pending prompt() builds > 1', maxPending > 1, `maxPending=${maxPending} — toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts) must await tool.prompt() without a shared lock or sequential chain, so concurrent callers overlap`)
  check('every roster entry produced a schema', schemas.length === COUNT, `got ${schemas.length} of ${COUNT} — toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts) must return one schema per tool`)
}

section('P3 · roster order preserved under reversed completion order')
{
  const names = schemas.map(s => (s as { name?: string }).name)
  const expected = roster.map(t => t.name)
  check('schema order IS roster order', JSON.stringify(names) === JSON.stringify(expected), `${JSON.stringify(names)} — each toolToAPISchema call must resolve to its own tool's schema whatever order the prompts finish in (src/engine/messages/apiSystemAndToolSchema.ts)`)
}

section('P4 · one prompt() per tool cold; zero warm')
{
  check(
    'each tool prompted exactly once on the cold build (no stampede)',
    roster.every(t => t.promptCalls === 1),
    `${JSON.stringify(roster.map(t => t.promptCalls))} — the cold build must call tool.prompt() once per tool: check the cache lookup and set around it in toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts)`,
  )
  const before = roster.map(t => t.promptCalls)
  const warm = await buildOnce()
  check('a warm rebuild prompts zero times (the shared cache serves)', roster.every((t, i) => t.promptCalls === before[i]), `${JSON.stringify(roster.map(t => t.promptCalls))} — a second build must be served from getToolSchemaCache (src/models/roads/toolSchemaCache.ts) keyed in toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts)`)
  check('warm rebuild yields the same roster-ordered names', JSON.stringify(warm.map(s => (s as { name?: string }).name)) === JSON.stringify(roster.map(t => t.name)), `warm names: ${JSON.stringify(warm.map(s => (s as { name?: string }).name))} — the cached path of toolToAPISchema (src/engine/messages/apiSystemAndToolSchema.ts) must keep the tool name and roster order`)
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
