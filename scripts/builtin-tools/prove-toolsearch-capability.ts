#!/usr/bin/env bun

process.env.MERCURY_DESKTOP_DRIVER = 'none'
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

console.log('[A] declared-intent ranking beats incidental description matches')

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

console.log('[B] a disabled tool ranks below every enabled match + reads unavailable')
const structure = byName('Structure')!
const gitTool = byName('Git')!
const demoteQ = 'apply a codemod to matching call expressions'

const enabledRun = await search(demoteQ)
show(`${demoteQ} [structure ON]`, enabledRun)
check(
  'baseline: Structure outranks Git while enabled',
  rank(enabledRun, 'Structure') !== -1 &&
    rank(enabledRun, 'Git') !== -1 &&
    rank(enabledRun, 'Structure') < rank(enabledRun, 'Git'),
  `Structure@${rank(enabledRun, 'Structure')} Git@${rank(enabledRun, 'Git')}`,
)

const enabledCard = compileToolCapabilityCard(structure)
check(
  'enabled+conditioned Structure card reads conditional',
  enabledCard.includes('conditional:') && enabledCard.includes('for:'),
  enabledCard,
)

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

console.log('[D] additive: undeclared tools inert, exact-name unaffected, deterministic')
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
