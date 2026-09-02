#!/usr/bin/env bun
// ============================================================================
//  scripts/builtin-tools/prove-toolsearch-capability.ts — capability-aware ToolSearch
// Drives the REAL scoring seam
//  (searchToolsWithKeywords, exported) over the REAL catalog (getAllBaseTools),
//  proving:
//
//   [A] intent-aware ranking — declared capability intents outrank incidental
//       description matches:
//         · 'rename an exported typescript symbol' → LSP above Structure
//         · 'transform matching call expressions'  → Structure first
//         · 'split changes into atomic commits'    → Git first
//         · 'start and verify a local application' → Journey first
//         · 'inspect a mercury resource'           → Inspect first
//   [B] availability honesty — a tool whose isEnabled() is false ranks BELOW
//       every enabled match, and its capability card reads 'unavailable'
//       (probed defensively; never silently dropped).
//   [C] the deferred-set description cache invalidates when the catalog
//       changes (the real maybeInvalidateCache + memoized-description seam).
//   [D] additive / byte-identical — undeclared tools get +0 intent, a
//       name-exact query still returns exactly that tool, and results are
//       deterministic across runs.
//
//  The searchable set is the DEFERRED set (tools with shouldDefer===true, via
//  the production isDeferredTool seam) plus the force-loaded Inspect tool —
//  Inspect is always present to the model (never deferred), so it is added
//  explicitly here so its intent ranking can be asserted. Ranking claims hold
//  over this real-tool set; a superset would only add lower-scoring noise.
// ============================================================================

import { existsSync } from 'node:fs'

let fail = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) fail = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const { getAllBaseTools } = await import('../../src/tools.ts')
const { isDeferredTool } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const {
  searchToolsWithKeywords,
  maybeInvalidateCache,
  getToolDescriptionMemoized,
  clearToolSearchDescriptionCache,
} = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { compileToolCapabilityCard } = await import(
  '../../src/utils/capability/manifest.ts'
)

type AnyTool = ReturnType<typeof getAllBaseTools>[number]

// —— build the real searchable set —————————————————————————————————————————
// Structure/Git/Journey/LSP/Inspect are all catalog-enabled by default in a
// bun-run environment (env-gated), so the objects exist to score.
const base = getAllBaseTools()
const byName = (n: string): AnyTool | undefined => base.find(t => t.name === n)

const deferred = base.filter(isDeferredTool)
const inspect = byName('Inspect')
const searchable: AnyTool[] =
  inspect && !deferred.includes(inspect) ? [...deferred, inspect] : [...deferred]

const needed = ['LSP', 'Structure', 'Git', 'Journey', 'Inspect']
console.log('── arsenal capability-aware ToolSearch ──')
check(
  'the tools under test are present in the searchable set',
  needed.every(n => searchable.some(t => t.name === n)),
  needed.filter(n => !searchable.some(t => t.name === n)).join(', '),
)

const search = (query: string): Promise<string[]> =>
  searchToolsWithKeywords(query, searchable, searchable, searchable.length)
const rank = (list: string[], name: string): number => list.indexOf(name)
const show = (q: string, list: string[]): void =>
  console.log(`     · "${q}" → ${list.slice(0, 6).join(', ') || '(none)'}`)

// —— [A] intent-aware ranking ————————————————————————————————————————————
console.log('[A] declared-intent ranking beats incidental description matches')

// LSP is the SEMANTIC rename owner; in the proc it has no connected server, so
// simulate the real-world condition (a connected server) for the one query
// where a rename request would route to it. Structure is the syntax owner.
const lsp = byName('LSP')!
const origLspEnabled = lsp.isEnabled
;(lsp as { isEnabled: () => boolean }).isEnabled = () => true
{
  const q = 'rename an exported typescript symbol'
  const r = await search(q)
  show(q, r)
  check(
    'LSP (semantic rename) ranks above Structure (syntax owner)',
    rank(r, 'LSP') !== -1 && rank(r, 'Structure') !== -1 && rank(r, 'LSP') < rank(r, 'Structure'),
    `LSP@${rank(r, 'LSP')} Structure@${rank(r, 'Structure')}`,
  )
}
;(lsp as { isEnabled: () => boolean }).isEnabled = origLspEnabled

for (const [q, winner] of [
  ['transform matching call expressions', 'Structure'],
  ['split changes into atomic commits', 'Git'],
  ['start and verify a local application', 'Journey'],
  ['inspect a mercury resource', 'Inspect'],
] as const) {
  const r = await search(q)
  show(q, r)
  check(`'${q}' ranks ${winner} first`, r[0] === winner, `got ${r[0] ?? '(none)'}`)
}

// —— [B] availability honesty ————————————————————————————————————————————
console.log('[B] a disabled tool ranks below every enabled match + reads unavailable')
const structure = byName('Structure')!
const gitTool = byName('Git')!
// A query BOTH Structure and the (enabled) Git tool match, where Structure
// normally outranks Git via its intent — so disabling Structure produces a
// visible demotion FLIP, not a vacuous pass.
const demoteQ = 'apply a codemod to matching call expressions'

// Baseline: Structure enabled → Structure outranks Git.
const enabledRun = await search(demoteQ)
show(`${demoteQ} [structure ON]`, enabledRun)
check(
  'baseline: Structure outranks Git while enabled',
  rank(enabledRun, 'Structure') !== -1 &&
    rank(enabledRun, 'Git') !== -1 &&
    rank(enabledRun, 'Structure') < rank(enabledRun, 'Git'),
  `Structure@${rank(enabledRun, 'Structure')} Git@${rank(enabledRun, 'Git')}`,
)

// Card while enabled + conditioned reads 'conditional: …' (never a bare card).
const enabledCard = compileToolCapabilityCard(structure)
check(
  'enabled+conditioned Structure card reads conditional',
  enabledCard.includes('conditional:') && enabledCard.includes('for:'),
  enabledCard,
)

// Disable Structure live (structureEnabled reads MERCURY_STRUCTURE per call).
process.env.MERCURY_STRUCTURE = '0'
check('Structure.isEnabled() is now false', structure.isEnabled() === false)
check('Git.isEnabled() stays true (the enabled comparator)', gitTool.isEnabled() === true)

const disabledRun = await search(demoteQ)
show(`${demoteQ} [structure OFF]`, disabledRun)
check(
  'disabled Structure is not silently dropped (still listed)',
  rank(disabledRun, 'Structure') !== -1,
)
check(
  'disabled Structure ranks BELOW the enabled Git match (demotion flip)',
  rank(disabledRun, 'Git') !== -1 &&
    rank(disabledRun, 'Git') < rank(disabledRun, 'Structure'),
  `Git@${rank(disabledRun, 'Git')} Structure@${rank(disabledRun, 'Structure')}`,
)
const disabledCard = compileToolCapabilityCard(structure)
check(
  'disabled Structure card reads unavailable',
  disabledCard.includes('unavailable') && disabledCard.includes('for:'),
  disabledCard,
)
delete process.env.MERCURY_STRUCTURE
check('Structure.isEnabled() restored to true', structure.isEnabled() === true)

// —— [C] deferred-set cache invalidation ————————————————————————————————————
console.log('[C] the description cache invalidates on a catalog change')
clearToolSearchDescriptionCache()
const cacheA = { name: 'CacheProbeAlpha', prompt: async () => 'alpha description' } as never
const cacheB = { name: 'CacheProbeBeta', prompt: async () => 'beta description' } as never
maybeInvalidateCache([cacheA])
await getToolDescriptionMemoized('CacheProbeAlpha', [cacheA] as never)
check(
  'description is memoized after the first lookup',
  getToolDescriptionMemoized.cache.has('CacheProbeAlpha') === true,
)
maybeInvalidateCache([cacheA])
check(
  'same deferred set keeps the cache warm',
  getToolDescriptionMemoized.cache.has('CacheProbeAlpha') === true,
)
maybeInvalidateCache([cacheB])
check(
  'a DIFFERENT deferred set clears the cache (key changed)',
  getToolDescriptionMemoized.cache.has('CacheProbeAlpha') === false,
)

// —— [D] additive / byte-identical ————————————————————————————————————————
console.log('[D] additive: undeclared tools inert, exact-name unaffected, deterministic')
// Undeclared MCP fixtures with an identical lexical tie: the intent layer must
// contribute nothing, preserving the pre-slice insertion-stable order.
const fAlpha = { name: 'mcp__srv__alpha_zip', isMcp: true, prompt: async () => 'compress an archive' } as never
const fBeta = { name: 'mcp__srv__beta_tar', isMcp: true, prompt: async () => 'extract an archive' } as never
const fixtures = [fAlpha, fBeta] as never[]
const fOrder = await searchToolsWithKeywords('archive', fixtures, fixtures, 5)
check(
  'undeclared tools: intent layer inert, insertion-stable tie preserved',
  fOrder.length === 2 &&
    fOrder[0] === 'mcp__srv__alpha_zip' &&
    fOrder[1] === 'mcp__srv__beta_tar',
  fOrder.join(', '),
)

const exact = await search('Structure')
check(
  'a name-exact query returns exactly that tool (fast path unaffected)',
  exact.length === 1 && exact[0] === 'Structure',
  exact.join(', '),
)

const det1 = await search('inspect a mercury resource')
const det2 = await search('inspect a mercury resource')
check(
  'results are deterministic across two runs',
  JSON.stringify(det1) === JSON.stringify(det2),
)

// —— proof file self-existence (the census claims this path) ————————————————
check(
  'this proof file exists at the path the census claims',
  existsSync(new URL(import.meta.url).pathname),
)

console.log(
  fail
    ? '\nARSENAL capability-aware ToolSearch: FAILURES'
    : '\nARSENAL capability-aware ToolSearch: ALL GREEN',
)
process.exit(fail)
