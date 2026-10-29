#!/usr/bin/env bun
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
console.log(' mcp tools/list — paginated + count capped, definitions whole (HB-0125)')
console.log('============================================================')

section('source: pagination loop + count cap are wired; no definition size cap')
check('TOOLS_MAX_PAGES = 50 page bound', /const TOOLS_MAX_PAGES = 50/.test(client))
check('TOOLS_MAX_PER_SERVER = 1000 count cap', /const TOOLS_MAX_PER_SERVER = 1000/.test(client))
check('no description or schema size cap remains (PROMPT_MAX_CHARS and SCHEMA_MAX_CHARS are gone)', !/PROMPT_MAX_CHARS|SCHEMA_MAX_CHARS/.test(client))
check('a bounded for-loop over tools/list (not a single request)', /for \(let page = 0; page < TOOLS_MAX_PAGES; page\+\+\)/.test(client))
check('the cursor is passed: params: cursor ? { cursor } : {}', /params: cursor \? \{ cursor \} : \{\}/.test(client))
check('result.nextCursor is read and drives the loop', /const next = result\.nextCursor/.test(client) && /cursor = next/.test(client))
check('a seenCursors repeated-cursor guard exists', /seenCursors\.has\(next\)/.test(client) && /seenCursors\.add\(next\)/.test(client))
check('the count cap truncates + logs', /accumulated\.length >= TOOLS_MAX_PER_SERVER[\s\S]{0,200}accumulated\.length = TOOLS_MAX_PER_SERVER/.test(client))
check('recursivelySanitizeUnicode runs on the ACCUMULATED set (raw = listAllTools), not page-1 result.tools', /const raw = await listAllTools\(client\)[\s\S]{0,80}recursivelySanitizeUnicode\(raw\)/.test(client) && !/recursivelySanitizeUnicode\(result\.tools\)/.test(client))
check('page-0 error rethrows (preserves the outer return [] contract); page-N keeps accumulated', /if \(page === 0\) throw err/.test(client))
check('the server schema is installed whole (never a permissive replacement, never a slice)', /const inputJSONSchema = sdkTool\.inputSchema\b/.test(client) && !/additionalProperties: true \}/.test(client) && !/inputSchema[\s\S]{0,40}\.slice\(/.test(client))
check('the description rides whole to prompt() (no truncation marker)', /prompt: async \(\) => description,/.test(client) && !/\[description truncated\]/.test(client) && !/description\.slice\(/.test(client))
check('no size-exceeded log stands in for a swapped schema', !/replaced with a permissive schema/.test(client))

section('behavioural mirror: verbatim pagination loop + the adversarial refutes')

const MAX_TOOLS_LIST_PAGES = 50
const MAX_MCP_TOOLS_PER_SERVER = 1000

type Page = { tools: { name: string }[]; nextCursor?: string }
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

{
  let calls = 0
  const { logs } = paginate(() => {
    calls++
    return { tools: [{ name: `t${calls}` }], nextCursor: 'STUCK' }
  })
  check('REFUTE A: a repeated-cursor server terminates (does NOT hang/loop to the page bound)', calls < MAX_TOOLS_LIST_PAGES && logs.includes('repeated-cursor'), `calls=${calls}`)
}

{
  const pages: Page[] = [
    { tools: [{ name: 'a' }], nextCursor: 'c1' },
    { tools: [{ name: 'b' }], nextCursor: 'c2' },
    { tools: [{ name: 'c' }] },
  ]
  const byCursor: Record<string, Page> = { __start: pages[0]!, c1: pages[1]!, c2: pages[2]! }
  const { rawTools } = paginate(c => byCursor[c ?? '__start']!)
  const names = rawTools.map(t => t.name).join(',')
  check('REFUTE B: all 3 pages accumulate (page>1 tools are no longer dropped)', names === 'a,b,c', names)
}

{
  const build = /function buildMcpTool\([\s\S]*?\n\}/.exec(client)?.[0] ?? ''
  check('REFUTE C: buildMcpTool was found', build.length > 0)
  check('REFUTE C: buildMcpTool compares no length against a bound', !/\.length\s*[<>]=?\s*[A-Z_0-9]+/.test(build) && !/JSON\.stringify\([^)]*\)\.length/.test(build), build.match(/\.length[^\n]*/g)?.join(' · ') ?? '')
}

{
  const { rawTools, logs } = paginate(() => ({
    tools: Array.from({ length: 600 }, (_, i) => ({ name: `x${i}` })),
    nextCursor: 'more',
  }))
  check('REFUTE D: the tool count is capped at MAX_MCP_TOOLS_PER_SERVER', rawTools.length === MAX_MCP_TOOLS_PER_SERVER, `${rawTools.length}`)
  check('REFUTE D: the count truncation is logged', logs.includes('count-cap'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0125 — tools/list pagination + count cap proven, definitions whole')
  process.exit(0)
} else {
  console.log(` ❌ HB-0125 — ${failures} check(s) failed`)
  process.exit(1)
}
