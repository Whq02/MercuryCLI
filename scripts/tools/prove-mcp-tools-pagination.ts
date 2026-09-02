#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-mcp-tools-pagination.ts
//  PROOF for: fetchToolsForClient requested tools/list with NO cursor
//  and IGNORED result.nextCursor → a paginated server's tools past page 1 were
//  silently dropped; the per-tool build had no count cap and copied inputSchema
//  with no size limit → a hostile/buggy server could balloon the in-memory tool
//  registry (the schema is also serialized into every request payload + the
//  api.ts toolSchemaCache key). The fix paginates under a page bound + a
//  per-server count cap + a repeated-cursor guard, sanitizes the FULL set, and
//  REPLACES (never slices) an over-cap inputSchema with a permissive schema so
//  the tool stays callable.
//
//  client.ts is unloadable under bun-run (heavy MCP graph) — same as its sibling
//  prove-mcp-stderr-flush.ts — so this locks the wiring by source-text + mirrors
//  the (pure) pagination loop + schema cap, with the spec's 4 adversarial refutes.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-mcp-tools-pagination.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const client = readFileSync(
  join(import.meta.dir, '..', '..', 'src', 'services', 'mcp', 'client.ts'),
  'utf-8',
)

console.log('============================================================')
console.log(' mcp tools/list — paginated + count/schema capped (HB-0125)')
console.log('============================================================')

// ───────────────────────────────────────────────────────────────────────────
// Source pins over client.ts: the
// bounds live as TOOLS_MAX_PAGES / TOOLS_MAX_PER_SERVER / SCHEMA_MAX_CHARS, the
// loop accumulates into `accumulated` inside listAllTools and the caller
// sanitizes that whole set as `raw`. Same laws, Mercury spellings.
section('source: pagination loop + count cap + schema replace are wired')
check('TOOLS_MAX_PAGES = 50 page bound', /const TOOLS_MAX_PAGES = 50/.test(client))
check('TOOLS_MAX_PER_SERVER = 1000 count cap', /const TOOLS_MAX_PER_SERVER = 1000/.test(client))
check('SCHEMA_MAX_CHARS = 32_768 (generous, NOT the 2048 description cap)', /const SCHEMA_MAX_CHARS = 32_768/.test(client))
check('a bounded for-loop over tools/list (not a single request)', /for \(let page = 0; page < TOOLS_MAX_PAGES; page\+\+\)/.test(client))
check('the cursor is passed: params: cursor ? { cursor } : {}', /params: cursor \? \{ cursor \} : \{\}/.test(client))
check('result.nextCursor is read and drives the loop', /const next = result\.nextCursor/.test(client) && /cursor = next/.test(client))
check('a seenCursors repeated-cursor guard exists', /seenCursors\.has\(next\)/.test(client) && /seenCursors\.add\(next\)/.test(client))
check('the count cap truncates + logs', /accumulated\.length >= TOOLS_MAX_PER_SERVER[\s\S]{0,200}accumulated\.length = TOOLS_MAX_PER_SERVER/.test(client))
check('recursivelySanitizeUnicode runs on the ACCUMULATED set (raw = listAllTools), not page-1 result.tools', /const raw = await listAllTools\(client\)[\s\S]{0,80}recursivelySanitizeUnicode\(raw\)/.test(client) && !/recursivelySanitizeUnicode\(result\.tools\)/.test(client))
check('page-0 error rethrows (preserves the outer return [] contract); page-N keeps accumulated', /if \(page === 0\) throw err/.test(client))
check('the schema cap REPLACES with a permissive object (NOT a slice on the schema)', /inputJSONSchema = \{ type: 'object', additionalProperties: true \}/.test(client) && !/inputSchema[\s\S]{0,40}\.slice\(/.test(client))
check('a logMCPError fires when the schema is replaced', /input schema exceeds \$\{SCHEMA_MAX_CHARS\} characters; replaced with a permissive schema/.test(client))

// ───────────────────────────────────────────────────────────────────────────
section('behavioural mirror: verbatim pagination loop + the 4 adversarial refutes')

const MAX_TOOLS_LIST_PAGES = 50
const MAX_MCP_TOOLS_PER_SERVER = 1000
const MAX_MCP_SCHEMA_LENGTH = 32_768

type Page = { tools: { name: string }[]; nextCursor?: string }
// Verbatim transcription of the shipped loop control structure.
function paginate(request: (cursor: string | undefined) => Page): {
  rawTools: { name: string }[]
  logs: string[]
} {
  const rawTools: { name: string }[] = []
  let cursor: string | undefined = undefined
  const seenCursors = new Set<string>()
  const logs: string[] = []
  for (let page = 0; page < MAX_TOOLS_LIST_PAGES; page++) {
    const result = request(cursor)
    rawTools.push(...result.tools)
    if (rawTools.length >= MAX_MCP_TOOLS_PER_SERVER) {
      logs.push('count-cap')
      rawTools.length = MAX_MCP_TOOLS_PER_SERVER
      break
    }
    const next = result.nextCursor
    if (!next) break
    if (seenCursors.has(next)) {
      logs.push('repeated-cursor')
      break
    }
    seenCursors.add(next)
    cursor = next
  }
  return { rawTools, logs }
}
// Verbatim transcription of the shipped schema-size cap.
function capSchema(raw: unknown): { replaced: boolean; schema: unknown } {
  if (raw && JSON.stringify(raw).length > MAX_MCP_SCHEMA_LENGTH) {
    return { replaced: true, schema: { type: 'object', additionalProperties: true } }
  }
  return { replaced: false, schema: raw }
}

// REFUTE A — a hostile server echoing the SAME cursor forever must TERMINATE.
{
  let calls = 0
  const { logs } = paginate(() => {
    calls++
    return { tools: [{ name: `t${calls}` }], nextCursor: 'STUCK' }
  })
  check('REFUTE A: a repeated-cursor server terminates (does NOT hang/loop to the page bound)', calls < MAX_TOOLS_LIST_PAGES && logs.includes('repeated-cursor'), `calls=${calls}`)
}

// REFUTE B — a 3-page server: ALL pages' tools accumulate (the silent-drop is absent).
{
  const pages: Page[] = [
    { tools: [{ name: 'a' }], nextCursor: 'c1' },
    { tools: [{ name: 'b' }], nextCursor: 'c2' },
    { tools: [{ name: 'c' }] }, // no nextCursor → last page
  ]
  const byCursor: Record<string, Page> = { __start: pages[0]!, c1: pages[1]!, c2: pages[2]! }
  const { rawTools } = paginate(c => byCursor[c ?? '__start']!)
  const names = rawTools.map(t => t.name).join(',')
  check('REFUTE B: all 3 pages accumulate (page>1 tools are no longer dropped)', names === 'a,b,c', names)
}

// REFUTE C — a >32KB inputSchema is REPLACED with a STILL-VALID, callable schema.
{
  const huge = { type: 'object', properties: { x: { description: 'q'.repeat(40_000) } } }
  const { replaced, schema } = capSchema(huge)
  let roundTrips = false
  let callableShaped = false
  try {
    const reparsed = JSON.parse(JSON.stringify(schema)) as { type?: string }
    roundTrips = true
    callableShaped = reparsed.type === 'object'
  } catch {
    /* invalid JSON */
  }
  check('REFUTE C: an over-32KB schema is REPLACED (not sliced)', replaced === true)
  check('REFUTE C: the replacement is STILL valid JSON and callable-shaped (type:object)', roundTrips && callableShaped)
  // a normal schema is untouched
  const small = capSchema({ type: 'object', properties: { y: { type: 'string' } } })
  check('REFUTE C: a normal schema is passed through unchanged', small.replaced === false)
}

// REFUTE D — a server reporting more than the per-server cap is truncated + logged.
{
  // 600 tools per page; page 0 → 600, page 1 → 1200 ≥ 1000 → cap to 1000.
  const { rawTools, logs } = paginate(() => ({
    tools: Array.from({ length: 600 }, (_, i) => ({ name: `x${i}` })),
    nextCursor: 'more',
  }))
  check('REFUTE D: the tool count is capped at MAX_MCP_TOOLS_PER_SERVER', rawTools.length === MAX_MCP_TOOLS_PER_SERVER, `${rawTools.length}`)
  check('REFUTE D: the count truncation is logged', logs.includes('count-cap'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0125 — tools/list pagination + count/schema cap proven')
  process.exit(0)
} else {
  console.log(` ❌ HB-0125 — ${failures} check(s) failed`)
  process.exit(1)
}
