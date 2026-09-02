#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-dispatch/prove-parallel-tool-schemas.ts — the OpenAI, Z.AI
//  and compat lanes build tool schemas with the Anthropic lane's
//  order-preserving parallel pattern.
//
//  The three buildApiShapedTools used to await toolToAPISchema tool-by-tool
//  — a cold cache serialized every prompt build. The laws:
//
//   P1  (source pins, all three lanes + the reference lane) the schema
//       build is ONE Promise.all over the roster; the sequential
//       await-inside-for shape is gone from all three.
//   P2  (the pattern over the REAL converter, cold cache) concurrent
//       misses actually OVERLAP — the max number of simultaneously-pending
//       prompt() builds exceeds 1 (the sequential shape holds it at
//       exactly 1, whatever the box load — an operation-shaped instrument,
//       not a wall clock);
//   P3  results land in ROSTER order even when completion order is fully
//       reversed (later tools resolve first);
//   P4  each tool's prompt() ran EXACTLY once (unique cache keys — no
//       stampede within one roster build), and a warm rebuild runs zero.
//
//  Run: ~/.bun/bin/bun run scripts/agent-dispatch/prove-parallel-tool-schemas.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

section('P1 · source pins — one Promise.all per lane, no sequential await loop')
{
  const LANES = [
    'src/services/providers/openai/openaiCallModel.ts',
    'src/services/providers/zai/zaiCallModel.ts',
    'src/services/providers/openaicompat/compatChatCallModel.ts',
  ]
  for (const lane of LANES) {
    const text = src(lane)
    const fn = text.slice(text.indexOf('async function buildApiShapedTools'))
    const body = fn.slice(0, fn.indexOf('\n}') + 2)
    check(
      `${lane.split('/').at(-1)}: Promise.all over the roster`,
      /const schemas = await Promise\.all\(\s*tools\.map\(tool =>\s*toolToAPISchema\(/.test(body),
    )
    check(
      `${lane.split('/').at(-1)}: the sequential await-per-tool shape is gone`,
      !/for \(const tool of tools\) \{\s*const schema = await toolToAPISchema/.test(body),
    )
  }
  check(
    'the reference lane still builds the same way (streamCore Promise.all)',
    /await Promise\.all\(\s*filteredTools\.map\(tool =>\s*toolToAPISchema\(/.test(
      src('src/services/providers/anthropic/streamCore.ts'),
    ),
  )
}

const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

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
    // Reverse-staggered delays: the LAST roster entry resolves FIRST, so
    // any order drift in the pattern would surface in P3.
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
  check('overlap observed: max pending prompt() builds > 1', maxPending > 1, `maxPending=${maxPending}`)
  check('every roster entry produced a schema', schemas.length === COUNT)
}

section('P3 · roster order preserved under reversed completion order')
{
  const names = schemas.map(s => (s as { name?: string }).name)
  const expected = roster.map(t => t.name)
  check('schema order IS roster order', JSON.stringify(names) === JSON.stringify(expected), JSON.stringify(names))
}

section('P4 · one prompt() per tool cold; zero warm')
{
  check(
    'each tool prompted exactly once on the cold build (no stampede)',
    roster.every(t => t.promptCalls === 1),
    JSON.stringify(roster.map(t => t.promptCalls)),
  )
  const before = roster.map(t => t.promptCalls)
  const warm = await buildOnce()
  check('a warm rebuild prompts zero times (the shared cache serves)', roster.every((t, i) => t.promptCalls === before[i]), JSON.stringify(roster.map(t => t.promptCalls)))
  check('warm rebuild yields the same roster-ordered names', JSON.stringify(warm.map(s => (s as { name?: string }).name)) === JSON.stringify(roster.map(t => t.name)))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
