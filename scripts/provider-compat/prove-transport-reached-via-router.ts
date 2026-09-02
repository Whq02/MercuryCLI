#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-transport-reached-via-router.ts — the
//  Anthropic transport is reached only through the router.
//
//  Mercury speaks to every provider family through ONE seam —
//  src/services/providers/callModelRouter.ts: routedCallModel (the streaming
//  drop-in for the Anthropic transport's queryModelWithStreaming) and
//  routedCallModelSettled (the one-shot drop-in for queryModelWithoutStreaming).
//  A product call site that imports a transport entrypoint directly sends a
//  non-Anthropic session's request down the Anthropic door (the
//  compaction + WebSearch defect). This pin is the direct-importer census as
//  a ratchet:
//
//    §1 the census over src (comment-stripped code; the transport's own
//       estate excluded): every file whose static or dynamic import of a
//       transport module (services/providers/anthropic/index.js · services/providers/anthropic/*)
//       names one of the four entrypoints, with its verdict from the
//       adjudication table. An importer of an UNROUTED entrypoint
//       (queryModelWithStreaming · queryModelWithoutStreaming) outside the
//       table FAILS; a table row that no longer imports FAILS too
//       (re-adjudicate — a stale allowance is never carried).
//    §2 the routed helpers stay routed: queryWithModel drains routedCallModel
//       and querySmallFast rides queryWithModel on sessionSmallFastModel —
//       the fact that makes THEIR importers fine.
//    §3 the four rewritten sites import the router and never the transport:
//       compact.ts + the search owner's native leg (services/search/
//       nativeSearch.ts — WebSearchTool re-homed onto it; the tool itself
//       hires no model) (routedCallModel), execPromptHook.ts +
//       generateAgent.ts (routedCallModelSettled); the prompt hook's default
//       tier is the session family's (sessionSmallFastModel), never the
//       Anthropic pin.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-transport-reached-via-router.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ENTRYPOINTS = ['queryModelWithStreaming', 'queryModelWithoutStreaming', 'queryWithModel', 'querySmallFast'] as const
type Entrypoint = (typeof ENTRYPOINTS)[number]
const UNROUTED = new Set<Entrypoint>(['queryModelWithStreaming', 'queryModelWithoutStreaming'])

/** The adjudication table: the files that may import an UNROUTED
 *  entrypoint directly, the names each may import, and why. */
const ALLOWED: Array<{ path: string; names: Entrypoint[]; verdict: string }> = [
  {
    path: 'src/services/providers/callModelRouter.ts',
    names: ['queryModelWithStreaming'],
    verdict: 'the router itself — its anthropic (home) arm IS the transport',
  },
  {
    path: 'src/services/providers/primaryBackend.ts',
    names: ['queryModelWithStreaming'],
    verdict: 'the backend table — the anthropic row names the transport as its stream face',
  },
  {
    path: 'src/query/scriptedStream.ts',
    names: ['queryModelWithStreaming'],
    verdict: 'type-only import — the scripted stream double borrows the yield contract',
  },
  {
    path: 'src/utils/model/validateModel.ts',
    names: ['queryModelWithoutStreaming'],
    verdict: 'the route law adjudicates first: non-Anthropic ids validate on their own lanes above this call; the direct call is the anthropic arm',
  },
]

/** The transport's own estate — not census subjects. */
const TRANSPORT_ESTATE = ['src/services/providers/anthropic/']
const TRANSPORT_SPECIFIER = /\/providers\/anthropic(?:\/index\.js|\/[A-Za-z]+\.js)?(?:['"]|$)/

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      walk(full, out)
    } else if (/\.(?:ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
}

/** Code only: comments that OWN their line are removed — a block comment
 *  opening a line (doc comments, banners) and a line comment owning a line.
 *  Nothing inside a string is touched: a glob's `/*` or a URL's `//` never
 *  opens a line, so it can never swallow the code after it (an import
 *  statement always opens its line). */
function stripComments(src: string): string {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/[^\n]*/gm, '')
}

/** The entrypoint names a file imports from a transport module — static
 *  `import { … } from '…'` (type imports included) and dynamic
 *  `const { … } = await import('…')`. */
function transportImports(code: string): Set<Entrypoint> {
  const names = new Set<Entrypoint>()
  const collect = (braces: string): void => {
    for (const piece of braces.split(',')) {
      const bare = piece.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? ''
      if ((ENTRYPOINTS as readonly string[]).includes(bare)) names.add(bare as Entrypoint)
    }
  }
  // The brace class excludes `{` too: a `[^}]*` run would open at an earlier
  // brace (a template literal's `${…}`) and swallow the `const {` before a
  // dynamic import, hiding that importer from the census.
  for (const m of code.matchAll(/import\s+(?:type\s+)?\{([^{}]*)\}\s*from\s*'([^']+)'/g)) {
    if (TRANSPORT_SPECIFIER.test(m[2] ?? '')) collect(m[1] ?? '')
  }
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*await\s+import\(\s*'([^']+)'\s*\)/g)) {
    if (TRANSPORT_SPECIFIER.test(m[2] ?? '')) collect(m[1] ?? '')
  }
  return names
}

// ---------------------------------------------------------------------------
section('§1 the direct-importer census — every transport entrypoint importer, adjudicated')
const files: string[] = []
walk(SRC, files)
type Row = { path: string; names: Entrypoint[]; verdict: string; ok: boolean }
const rows: Row[] = []
const seenAllowed = new Set<string>()
for (const file of files.sort()) {
  const rel = relative(ROOT, file)
  if (TRANSPORT_ESTATE.some(p => rel === p || rel.startsWith(p))) continue
  const names = [...transportImports(stripComments(readFileSync(file, 'utf8')))]
  if (names.length === 0) continue
  const unrouted = names.filter(n => UNROUTED.has(n))
  const routed = names.filter(n => !UNROUTED.has(n))
  if (unrouted.length === 0) {
    rows.push({ path: rel, names, verdict: 'routed helper — the transport function itself drains routedCallModel (§2)', ok: true })
    continue
  }
  const allowance = ALLOWED.find(a => a.path === rel)
  if (allowance !== undefined) seenAllowed.add(rel)
  const permitted = allowance !== undefined && unrouted.every(n => allowance.names.includes(n))
  rows.push({
    path: rel,
    names,
    verdict: permitted
      ? `named: ${allowance!.verdict}${routed.length > 0 ? ' (+ routed helper imports)' : ''}`
      : 'PRODUCT SITE IMPORTS THE TRANSPORT DIRECTLY — route through callModelRouter (routedCallModel / routedCallModelSettled)',
    ok: permitted,
  })
}
console.log('\n  site → entrypoints → verdict')
for (const row of rows) {
  console.log(`  ${row.ok ? '·' : '✗'} ${row.path}  [${row.names.join(', ')}]  ${row.verdict}`)
}
console.log('')
check('the census found the transport importers (a zero census would be a broken walker)', rows.length >= 6, String(rows.length))
for (const row of rows.filter(r => !r.ok)) {
  check(`unrouted entrypoint importer outside the adjudication table: ${row.path}`, false, row.names.join(', '))
}
check('every unrouted-entrypoint importer is a named row of the adjudication table', rows.every(r => r.ok))
for (const allowance of ALLOWED) {
  const row = rows.find(r => r.path === allowance.path)
  check(
    `table row still imports exactly what it is allowed: ${allowance.path} [${allowance.names.join(', ')}]`,
    row !== undefined && row.names.filter(n => UNROUTED.has(n)).sort().join(',') === [...allowance.names].sort().join(','),
    row === undefined ? 'no longer imports the transport — retire the row' : row.names.join(', '),
  )
}

// ---------------------------------------------------------------------------
section('§2 the routed helpers stay routed — queryWithModel / querySmallFast')
{
  const core = stripComments(readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8'))
  const withModelStart = core.indexOf('export async function queryWithModel(')
  const withModelEnd = core.indexOf('export const MAX_NON_STREAMING_TOKENS')
  const withModel = withModelStart >= 0 && withModelEnd > withModelStart ? core.slice(withModelStart, withModelEnd) : ''
  check('queryWithModel late-imports the router', withModel.includes("import(") && withModel.includes('providers/callModelRouter.js'))
  check('queryWithModel drains routedCallModel (never queryModel directly)', withModel.includes('routedCallModel({') && !/\bqueryModel\(/.test(withModel))
  check('queryWithModel settles through the router-owned fold', withModel.includes('settleAssistantTurn('))
  const smallStart = core.indexOf('export async function querySmallFast(')
  const smallFast = smallStart >= 0 ? core.slice(smallStart, withModelStart) : ''
  check('querySmallFast rides queryWithModel', smallFast.includes('return queryWithModel({'))
  check("querySmallFast's tier is the session family's (sessionSmallFastModel)", smallFast.includes('model: sessionSmallFastModel()'))
}

// ---------------------------------------------------------------------------
section('§3 the rewritten sites import the router, never the transport')
{
  const read = (rel: string): string => stripComments(readFileSync(join(ROOT, rel), 'utf8'))
  const compact = read('src/services/compact/compact.ts')
  check('compact.ts imports routedCallModel from the router', compact.includes("import { routedCallModel } from '../providers/callModelRouter.js'"))
  check('compact.ts calls routedCallModel exactly once (the summariser\'s direct call)', (compact.match(/routedCallModel\(\{/g) ?? []).length === 1)
  check('compact.ts names no transport entrypoint', !/\bqueryModelWith(?:out)?Streaming\b/.test(compact))

  // The search leg re-homed onto the search owner (services/search): the
  // native door's nested query is the one routed call; the tool itself
  // hires no model and names no transport.
  const nativeSearch = read('src/services/search/nativeSearch.ts')
  check('nativeSearch.ts imports routedCallModel from the router', nativeSearch.includes("import { routedCallModel } from '../providers/callModelRouter.js'"))
  check('nativeSearch.ts calls routedCallModel exactly once (the native search leg)', (nativeSearch.match(/routedCallModel\(\{/g) ?? []).length === 1)
  check('nativeSearch.ts names no transport entrypoint', !/\bqueryModelWith(?:out)?Streaming\b/.test(nativeSearch))
  check('nativeSearch.ts never reads the Anthropic small-fast pin directly (the gate rides the session family\'s tier)', !/\bgetSmallFastModel\b/.test(nativeSearch) && nativeSearch.includes('sessionSmallFastModel()'))
  const searchDoor = read('src/services/search/searchDoor.ts')
  check('the search door opens the native door only for the main model\'s OWN family by the routing law', searchDoor.includes('declaredRouteOf(mainModel)') && searchDoor.includes('isNativeSearchFamily(route)'))
  const webSearch = read('src/tools/WebSearchTool/WebSearchTool.ts')
  check('WebSearchTool.ts hires no model and names no transport (the door owns the leg)', !/\brouted?CallModel\b|\bqueryModelWith(?:out)?Streaming\b|\bgetSmallFastModel\b/.test(webSearch) && webSearch.includes('performWebSearch('))
  const providerSearch = read('src/tools/WebSearchTool/ProviderSearchTool.ts')
  check('ProviderSearchTool.ts reaches the wire only through the search owner (no transport, no direct router call)', !/\brouted?CallModel\b|\bqueryModelWith(?:out)?Streaming\b|\bgetSmallFastModel\b/.test(providerSearch) && providerSearch.includes('nativeSearch('))

  const hook = read('src/utils/hooks/execPromptHook.ts')
  check('execPromptHook.ts imports routedCallModelSettled from the router', hook.includes("import { routedCallModelSettled } from '../../services/providers/callModelRouter.js'"))
  check('execPromptHook.ts settles through routedCallModelSettled', (hook.match(/routedCallModelSettled\(\{/g) ?? []).length === 1)
  check("execPromptHook.ts defaults the hook's tier to the session family's (sessionSmallFastModel)", hook.includes('hook.model ?? sessionSmallFastModel()'))
  check('execPromptHook.ts never reads the Anthropic small-fast pin directly', !/\bgetSmallFastModel\b/.test(hook))
  check('execPromptHook.ts names no transport entrypoint', !/\bqueryModelWith(?:out)?Streaming\b/.test(hook))

  const agent = read('src/components/agents/generateAgent.ts')
  check('generateAgent.ts imports routedCallModelSettled from the router', agent.includes("import { routedCallModelSettled } from '../../services/providers/callModelRouter.js'"))
  check('generateAgent.ts settles through routedCallModelSettled', (agent.match(/routedCallModelSettled\(\{/g) ?? []).length === 1)
  check('generateAgent.ts names no transport entrypoint', !/\bqueryModelWith(?:out)?Streaming\b/.test(agent))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
if (failures === 0) {
  console.log(' ✅ TRANSPORT REACHED VIA ROUTER GREEN')
  process.exit(0)
}
console.log(` ❌ ${failures} TRANSPORT-VIA-ROUTER FAILURE(S)`)
process.exit(1)
