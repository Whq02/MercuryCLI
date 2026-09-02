#!/usr/bin/env bun
// ============================================================================
//  scripts/ast-tools/prove-ast-parity.ts — the pin: an edit's match set is
//  exactly the search's match set for the same pattern and scope.
//
//    1. through the matcher module: for every language fixture and the
//       multi-file rename fixture, the rewrite plan's match locations equal
//       an independent search's (file · start · end · node type), the
//       per-file counts agree, and a literal-lane rewrite edits exactly the
//       matched spans;
//    2. through the tools: AstSearch in count mode and AstEdit's dry run
//       report the same total for the same pattern, path and glob — and a
//       lang pin narrows both identically.
// ============================================================================
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'
import { LANGUAGE_FIXTURES, writeLanguageFixtures, writeRenameFixture } from './lib/fixtures.ts'

const { engineDir } = armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { GRAMMAR_REGISTRY } = await import(join(REPO, 'src/services/structure/grammarRegistry.ts'))
const { resolveAstScope, searchAstPattern, planAstRewrite, isAstRefusal } = await import(join(REPO, 'src/utils/astPatterns.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-parity-'))
writeLanguageFixtures(root)
writeRenameFixture(join(root, 'rename'))
await enterRoot(root)

type Loc = string
const locate = (m: { rel: string; startIndex: number; endIndex: number; nodeType: string }): Loc => `${m.rel}@${m.startIndex}-${m.endIndex}:${m.nodeType}`

section('§1 — the matcher module: plan.search ≡ an independent search')
{
  const cases: Array<{ label: string; path: string; pattern: string; rewrite: string; lang?: string }> = [
    { label: 'rename calls', path: 'rename', pattern: 'normalizeRecord($$$ARGS)', rewrite: 'normaliseRecord($$$ARGS)' },
    { label: 'rename declarations', path: 'rename', pattern: 'function $NAME($$$P) { $$$B }', rewrite: 'function renamed_$NAME($$$P) { $$$B }' },
  ]
  for (const f of LANGUAGE_FIXTURES) {
    if (!f.rewrite) continue
    cases.push({ label: f.lang, path: f.lang, pattern: f.pattern, rewrite: f.rewrite.rewrite })
  }
  for (const c of cases) {
    const fixture = LANGUAGE_FIXTURES.find(f => f.lang === c.label)
    if (fixture) {
      const entry = GRAMMAR_REGISTRY.find((g: { name: string }) => g.name === fixture.lang) as { wasm: string }
      if (!existsSync(join(engineDir, entry.wasm))) {
        skip(c.label, `${entry.wasm} not in this checkout's engine dir`)
        continue
      }
    }
    const scope = resolveAstScope({ cwd: root, path: join(root, c.path), ...(c.lang ? { lang: c.lang } : {}) })
    if (isAstRefusal(scope)) {
      check(`${c.label}: scope resolves`, false, scope.refused)
      continue
    }
    const search = await searchAstPattern(scope, { pattern: c.pattern })
    const plan = await planAstRewrite(scope, { pattern: c.pattern, rewrite: c.rewrite })
    if (isAstRefusal(search) || isAstRefusal(plan)) {
      check(`${c.label}: both lanes answer`, false, isAstRefusal(search) ? search.refused : (plan as { refused: string }).refused)
      continue
    }
    const searchLocs = search.matches.map(locate).sort()
    const planLocs = plan.search.matches.map(locate).sort()
    check(`${c.label}: the plan's match set is the search's (${searchLocs.length} locations)`, searchLocs.length > 0 && JSON.stringify(searchLocs) === JSON.stringify(planLocs), `search ${searchLocs.join(' ')} · plan ${planLocs.join(' ')}`)
    const perFileSearch = new Map<string, number>()
    for (const m of search.matches) perFileSearch.set(m.rel, (perFileSearch.get(m.rel) ?? 0) + 1)
    const perFilePlan = new Map(plan.files.map(f => [f.rel, f.matchCount]))
    const totalsAgree = plan.matchCount + plan.unchangedMatches === search.matches.length
    const filesSubset = [...perFilePlan.keys()].every(rel => perFileSearch.has(rel))
    const exactWhenAllChange = plan.unchangedMatches > 0 || [...perFileSearch.entries()].every(([rel, n]) => perFilePlan.get(rel) === n)
    check(`${c.label}: per-file counts agree (${[...perFileSearch.values()].join('+')} = ${plan.matchCount} changed + ${plan.unchangedMatches} unchanged)`, totalsAgree && filesSubset && exactWhenAllChange, `${JSON.stringify([...perFileSearch])} vs ${JSON.stringify([...perFilePlan])}`)
    if (plan.inPlaceMatches === 0 && plan.unchangedMatches === 0) {
      const editSpans = plan.files.flatMap(f => f.edits.map(e => `${f.rel}@${e.start}-${e.end}`)).sort()
      const matchSpans = search.matches.map(m => `${m.rel}@${m.startIndex}-${m.endIndex}`).sort()
      const deletion = c.rewrite === ''
      check(`${c.label}: literal-lane edits cover exactly the matched spans`, deletion || JSON.stringify(editSpans) === JSON.stringify(matchSpans), `edits ${editSpans.join(' ')} · matches ${matchSpans.join(' ')}`)
    }
  }
}

section('§2 — the tools: AstSearch count ≡ AstEdit dry-run count')
{
  const prover = await makeContext([AstSearchTool, AstEditTool])
  const probes: Array<{ input: Record<string, unknown>; rewrite: string }> = [
    { input: { pattern: 'normalizeRecord($$$ARGS)', path: 'rename' }, rewrite: 'changed($$$ARGS)' },
    { input: { pattern: 'normalizeRecord($$$ARGS)', path: 'rename', glob: 'src/report.ts' }, rewrite: 'changed($$$ARGS)' },
    { input: { pattern: 'print($X)', path: '.' }, rewrite: 'changed($X)' },
    { input: { pattern: 'print($X)', path: '.', lang: 'python' }, rewrite: 'changed($X)' },
    { input: { pattern: 'function $NAME($$$P) { $$$B }', path: '.', glob: '**/*.ts' }, rewrite: 'function changed_$NAME($$$P) { $$$B }' },
  ]
  for (const { input, rewrite } of probes) {
    const counted = await drive(AstSearchTool, { ...input, mode: 'count' }, prover)
    const dry = await drive(AstEditTool, { ...input, rewrite }, prover)
    const searchTotal = Number(counted.data?.matchCount ?? -1)
    const editTotal = Number(dry.data?.matchCount ?? -2)
    check(`${JSON.stringify(input)}: search ${searchTotal} ≡ edit ${editTotal}`, !counted.isError && !dry.isError && searchTotal === editTotal, `${counted.text.split('\n').find(l => / matches? across /.test(l))} | ${dry.text.split('\n')[0]}`)
  }
}

finish('AST PARITY PIN')
