#!/usr/bin/env bun
// ============================================================================
//  scripts/ast-tools/prove-ast-search.ts — the AstSearch laws through the
//  REAL tool door over a disposable fixture tree:
//
//    1. every supported language: its fixture matches its pattern exactly
//       `expect` times, with the declared capture, in count mode AND in
//       matches mode (a grammar this checkout cannot load is a named SKIP);
//    2. $ and $$$ captures: one-node and sequence captures come back with
//       the captured source; a reused name must match identical code;
//    3. count mode tallies per file and in total;
//    4. glob scoping (a bare "*.ts" applies at any depth) and lang pinning;
//    5. the bound: limit + offset page with an exact "N more" remainder;
//    6. the unsupported-language refusal names the supported set (an
//       explicit lang, and a single file with no grammar);
//    7. a malformed pattern's error names the parse failure and a corrected
//       example;
//    8. zero matches name what was searched (files, languages, skipped);
//    9. a file that does not parse is reported, never matched over;
//   10. a read-deny rule hides a file (skipped and counted);
//   11. the descriptions: prompt == description, the grammar lines, two
//       examples, the language list.
// ============================================================================
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'
import { LANGUAGE_FIXTURES, writeLanguageFixtures, writeRenameFixture } from './lib/fixtures.ts'

const { engineDir, packPresent } = armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { GRAMMAR_REGISTRY } = await import(join(REPO, 'src/services/structure/grammarRegistry.ts'))
const { PATTERN_GRAMMAR_LINES, astLanguageNames } = await import(join(REPO, 'src/utils/astPatterns.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-search-'))
writeLanguageFixtures(root)
writeRenameFixture(join(root, 'rename'))
await enterRoot(root)
const prover = await makeContext([AstSearchTool, AstEditTool])
const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)

// ── 1. every supported language ──────────────────────────────────────────────
section('§1 — one fixture per supported language (count mode + matches mode)')
{
  const missing = GRAMMAR_REGISTRY.filter((g: { name: string }) => !LANGUAGE_FIXTURES.some(f => f.lang === g.name)).map((g: { name: string }) => g.name)
  check('every registry language has a fixture row', missing.length === 0, missing.join(','))
  const extra = LANGUAGE_FIXTURES.filter(f => !GRAMMAR_REGISTRY.some((g: { name: string }) => g.name === f.lang)).map(f => f.lang)
  check('no fixture names a language outside the registry', extra.length === 0, extra.join(','))
  for (const f of LANGUAGE_FIXTURES) {
    const entry = GRAMMAR_REGISTRY.find((g: { name: string }) => g.name === f.lang) as { wasm: string }
    if (!existsSync(join(engineDir, entry.wasm))) {
      skip(`${f.lang}: ${f.pattern}`, `${entry.wasm} not in this checkout's engine dir (grammar-pack cache ${packPresent ? 'incomplete' : 'absent'}: bun run scripts/vendor/fetch-grammars.ts)`)
      continue
    }
    const counted = await search({ pattern: f.pattern, path: f.lang, mode: 'count' })
    const total = Number(counted.data?.matchCount ?? -1)
    check(`${f.lang}: ${JSON.stringify(f.pattern)} counts ${f.expect}`, !counted.isError && total === f.expect, counted.isError ? counted.text.slice(0, 200) : `got ${total}: ${counted.text.split('\n')[0]}`)
    const listed = await search({ pattern: f.pattern, path: f.lang })
    const rows = listed.text.split('\n').filter(l => l.startsWith(`${f.file}:`))
    check(`${f.lang}: matches mode lists ${f.expect} located rows`, !listed.isError && rows.length === f.expect, listed.isError ? listed.text.slice(0, 200) : `${rows.length} rows`)
    if (f.capture) {
      const captureRows = listed.text.split('\n').filter(l => l.startsWith('  captures:') && l.includes(`${f.capture} = `))
      check(`${f.lang}: every match carries ${f.capture}`, captureRows.length === f.expect, `${captureRows.length} capture rows`)
    }
  }
}

// ── 2. captures ──────────────────────────────────────────────────────────────
section('§2 — $ and $$$ captures')
{
  const r = await search({ pattern: 'normalizeRecord($$$ARGS)', path: 'rename' })
  check('sequence capture carries the argument source', r.text.includes('$$$ARGS = r') && r.text.includes('$$$ARGS = record'), r.text.slice(0, 300))
  check('three call sites across three files', Number(r.data?.matchCount) === 2 && Number(r.data?.fileCount) === 2, `${r.data?.matchCount} matches in ${r.data?.fileCount} files`)
  const decl = await search({ pattern: 'function $NAME($$$PARAMS) { $$$BODY }', path: 'rename' })
  check('declaration pattern captures the name, the parameters and the body', decl.text.includes('$NAME = normalizeRecord') && decl.text.includes('$$$PARAMS = record: { label: string; value: number }') && decl.text.includes('$$$BODY = '), decl.text.slice(0, 400))
  check('three declarations found (one per file)', Number(decl.data?.matchCount) === 3, String(decl.data?.matchCount))
  const ifs = await search({ pattern: 'if ($COND) { $$$BODY }', path: 'rename' })
  check('if-statement pattern: one match with $COND captured', Number(ifs.data?.matchCount) === 1 && ifs.text.includes('$COND = record.value > 0'), ifs.text.slice(0, 300))
  mkdirSync(join(root, 'reuse'))
  writeFileSync(join(root, 'reuse', 'r.py'), 'a = x == x\nb = x == y\n')
  const reuse = await search({ pattern: '$A == $A', path: 'reuse' })
  check('a reused meta-variable must match identical code ($A == $A finds x == x only)', Number(reuse.data?.matchCount) === 1 && reuse.text.includes('x == x') && !reuse.text.includes('x == y'), reuse.text.slice(0, 200))
  const anon = await search({ pattern: 'normalizeRecord($_)', path: 'rename' })
  check('$_ matches one node without capturing', Number(anon.data?.matchCount) === 2 && !anon.text.includes('captures:'), anon.text.slice(0, 200))
}

// ── 3. count mode ────────────────────────────────────────────────────────────
section('§3 — count mode')
{
  const r = await search({ pattern: 'normalizeRecord($$$A)', path: 'rename', mode: 'count' })
  check('per-file tallies', r.text.includes('src/report.ts: 1') && r.text.includes('src/stats.ts: 1'), r.text.slice(0, 200))
  check('the total line', /^2 matches across 2 files/m.test(r.text), r.text.slice(0, 200))
}

// ── 4. glob scoping + lang pin ───────────────────────────────────────────────
section('§4 — glob scoping and the lang pin')
{
  const bare = await search({ pattern: 'print($X)', glob: '*.py' })
  check('a bare "*.py" glob applies at any depth', Number(bare.data?.matchCount) === 2 && bare.text.includes('python/app.py:'), bare.text.slice(0, 200))
  const deep = await search({ pattern: 'normalizeRecord($$$A)', path: 'rename', glob: 'src/**/*.ts' })
  check('a directory glob scopes', Number(deep.data?.matchCount) === 2, String(deep.data?.matchCount))
  const none = await search({ pattern: 'normalizeRecord($$$A)', path: 'rename', glob: 'src/report.ts' })
  check('a file glob narrows to that file', Number(none.data?.matchCount) === 1 && none.text.includes('src/report.ts:'), none.text.slice(0, 200))
  const pinned = await search({ pattern: 'print($X)', lang: 'python' })
  check('lang pin searches only that language across the whole tree', Number(pinned.data?.matchCount) === 2, String(pinned.data?.matchCount))
  const alias = await search({ pattern: 'print($X)', lang: 'py' })
  check('a friendly alias (py) resolves to the registry name', Number(alias.data?.matchCount) === 2, alias.isError ? alias.text.slice(0, 200) : String(alias.data?.matchCount))
}

// ── 5. the bound ─────────────────────────────────────────────────────────────
section('§5 — the bound: limit, offset, the exact remainder')
{
  mkdirSync(join(root, 'many'))
  const lines: string[] = []
  for (let i = 0; i < 70; i++) lines.push(`log(${i})`)
  writeFileSync(join(root, 'many', 'm.js'), `${lines.join('\n')}\n`)
  const first = await search({ pattern: 'log($X)', path: 'many' })
  check('default limit 50 shows 50 rows', Number(first.data?.shown) === 50 && first.text.includes('Showing 1-50 of 70 matches'), first.text.split('\n').find(l => l.startsWith('Showing')) ?? first.text.slice(0, 120))
  check('the remainder is exact and names the next offset', first.text.includes('20 more; pass offset: 50'), first.text.split('\n').find(l => l.startsWith('Showing')) ?? '')
  const page = await search({ pattern: 'log($X)', path: 'many', limit: 20, offset: 50 })
  check('offset 50 limit 20 shows the last 20 with no remainder', Number(page.data?.shown) === 20 && page.text.includes('$X = 69') && !page.text.includes('more; pass offset'), page.text.split('\n').slice(-6).join(' | '))
  const past = await search({ pattern: 'log($X)', path: 'many', offset: 500 })
  check('an offset past the end says so', past.text.includes('offset 500 is past the last match (70 in total)'), past.text.slice(0, 200))
  const clamped = await search({ pattern: 'log($X)', path: 'many', limit: 999 })
  check('limit clamps to 200 (all 70 shown here)', Number(clamped.data?.shown) === 70, String(clamped.data?.shown))
  const counted = await search({ pattern: 'log($X)', path: 'many', mode: 'count' })
  check('count mode is never windowed', Number(counted.data?.matchCount) === 70, String(counted.data?.matchCount))
}

// ── 6. unsupported language ──────────────────────────────────────────────────
section('§6 — the unsupported-language refusal names the set')
{
  const r = await search({ pattern: 'print($X)', lang: 'klingon' })
  check('unknown lang refuses with the supported set', r.isError && r.text.includes('Unknown language "klingon"') && r.text.includes('Supported languages: python, go, rust') && r.text.includes('json'), r.text.slice(0, 300))
  const md = await search({ pattern: 'print($X)', path: 'rename/README.md' })
  check('a single file with no grammar refuses by extension and names the set', md.isError && md.text.includes('.md') && md.text.includes('Supported languages:'), md.text.slice(0, 300))
}

// ── 7. malformed pattern ─────────────────────────────────────────────────────
section('§7 — the malformed-pattern error names the failure and a fix')
{
  const r = await search({ pattern: ')((broken', path: 'rename' })
  check('refuses as an error', r.isError, r.text.slice(0, 200))
  check('names what did not parse and where', r.text.includes('did not parse as typescript (1:1 syntax error)'), r.text.slice(0, 300))
  check('names a corrected shape', r.text.includes('"$FN($$$ARGS)"') && r.text.includes('Meta-variable names are UPPERCASE'), r.text.slice(0, 400))
  const empty = await search({ pattern: '   ', path: 'rename' })
  check('an empty pattern is refused with the fix', empty.isError && empty.text.includes('pattern is empty'), empty.text.slice(0, 200))
  const mixed = await search({ pattern: 'if ($COND) { $$$BODY }', path: '.' })
  check('a pattern that parses in some languages reports the others as not searched', !mixed.isError && mixed.text.includes('Not searched:') && mixed.text.includes('python file'), mixed.text.split('\n').find(l => l.startsWith('Not searched')) ?? mixed.text.slice(0, 200))
}

// ── 8. zero matches ──────────────────────────────────────────────────────────
section('§8 — zero matches name what was searched')
{
  const r = await search({ pattern: 'neverThere($X)', path: 'rename' })
  check('no-match text names the pattern', !r.isError && r.text.startsWith('No matches for "neverThere($X)"'), r.text.slice(0, 200))
  check('names the files and languages searched under the scope', r.text.includes('files under rename') && r.text.includes('typescript'), r.text.slice(0, 300))
  check('names the skipped extension census', r.text.includes('Skipped 1 file with no grammar for the extension: .md ×1'), r.text.slice(0, 300))
  const nothing = await search({ pattern: 'x', path: 'rename', glob: '**/*.md' })
  check('a scope with no supported files says nothing was searched', !nothing.isError && nothing.text.startsWith('Nothing searched:'), nothing.text.slice(0, 200))
}

// ── 9. parse honesty ─────────────────────────────────────────────────────────
section('§9 — a file that does not parse is reported, never matched over')
{
  mkdirSync(join(root, 'broken'))
  writeFileSync(join(root, 'broken', 'ok.py'), 'print(1)\n')
  writeFileSync(join(root, 'broken', 'bad.py'), 'def broken(:\n    print(\n')
  const r = await search({ pattern: 'print($X)', path: 'broken' })
  check('the good file matches', Number(r.data?.matchCount) === 1 && r.text.includes('ok.py:1:1'), r.text.slice(0, 200))
  check('the broken file is named with its parse error', r.text.includes('Did not parse, never matched: bad.py (does not parse as python:'), r.text.split('\n').find(l => l.startsWith('Did not parse')) ?? r.text.slice(0, 300))
}

// ── 10. read-deny rules ──────────────────────────────────────────────────────
section('§10 — a read-deny rule hides a file')
{
  const denied = await makeContext([AstSearchTool, AstEditTool], { deny: ['Read(rename/src/report.ts)'] })
  const r = await drive(AstSearchTool, { pattern: 'normalizeRecord($$$A)', path: 'rename' }, denied)
  check('the denied file is skipped and counted', !r.isError && Number(r.data?.matchCount) === 1 && r.text.includes('Skipped 1 file hidden by read-deny rules'), r.text.slice(0, 300))
  const out = await makeContext([AstSearchTool, AstEditTool], { deny: ['Read(rename/**)'] })
  const r2 = await drive(AstSearchTool, { pattern: 'normalizeRecord($$$A)', path: 'rename' }, out)
  check('a deny rule over the scope path refuses the search itself', r2.isError && /denied/i.test(r2.text), r2.text.slice(0, 200))
}

// ── 11. the descriptions ─────────────────────────────────────────────────────
section('§11 — the descriptions')
{
  const description = await AstSearchTool.description()
  const prompt = await AstSearchTool.prompt({ getToolPermissionContext: async () => ({}) })
  check('prompt equals description', prompt === description)
  check('carries the three grammar lines', PATTERN_GRAMMAR_LINES.every((l: string) => description.includes(l)))
  check('carries two examples', (description.match(/^- \{ "pattern"/gm) ?? []).length === 2)
  check('names every supported language', astLanguageNames().every((n: string) => description.includes(n)))
  check('names the bound', description.includes('default 50, max 200'))
  const editDescription = await AstEditTool.description()
  check('AstEdit: prompt equals description', (await AstEditTool.prompt({ getToolPermissionContext: async () => ({}) })) === editDescription)
  check('AstEdit: names the dry-run + plan law', editDescription.includes('Two calls, always') && editDescription.includes('plan "ae-…"'))
  check('AstEdit: names the refusals', editDescription.includes('nested inside another match') && editDescription.includes('unparsable'))
  check('AstEdit: carries two examples', (editDescription.match(/^- \{ "pattern"/gm) ?? []).length === 2)
}

// ── 12. the build truth of the language list ────────────────────────────────
section('§12 — the descriptions name only the grammars the build carries')
{
  // A clean clone's local build vendors the @vscode pack alone (16
  // grammars); the seven grammar-pack rows ride only when the pinned cache
  // was prepared. Probed in a FRESH process against the workspace package
  // dir (the engine memoises per process).
  const { execFileSync } = await import('node:child_process')
  const { GRAMMAR_REGISTRY: registry } = await import(join(REPO, 'src/services/structure/grammarRegistry.ts'))
  const packNames = (registry as Array<{ name: string; source?: string }>).filter(g => g.source === 'grammar-pack').map(g => g.name)
  const vscodeNames = (registry as Array<{ name: string; source?: string }>).filter(g => g.source !== 'grammar-pack').map(g => g.name)
  const probeRoot = mkdtempSync(join(tmpdir(), 'ast-clean-clone-'))
  writeFileSync(join(probeRoot, 'a.json'), '{"a": 1}\n')
  writeFileSync(join(probeRoot, 'a.py'), 'print(1)\n')
  const PROBE = `
const { getAstSearchDescription } = await import(${JSON.stringify(join(REPO, 'src/tools/AstSearchTool/prompt.ts'))})
const { getAstEditDescription } = await import(${JSON.stringify(join(REPO, 'src/tools/AstEditTool/prompt.ts'))})
const { astLanguageNames, resolveAstScope, searchAstPattern, renderSearchTrailer, isAstRefusal } = await import(${JSON.stringify(join(REPO, 'src/utils/astPatterns.ts'))})
const root = ${JSON.stringify(probeRoot)}
const scope = resolveAstScope({ cwd: root, path: root })
const search = isAstRefusal(scope) ? scope : await searchAstPattern(scope, { pattern: 'print($X)' })
const trailer = isAstRefusal(scope) || isAstRefusal(search) ? '' : renderSearchTrailer(scope, search).join('\\n')
const single = resolveAstScope({ cwd: root, path: root + '/a.json' })
const pinned = resolveAstScope({ cwd: root, path: root, lang: 'json' })
console.log(JSON.stringify({
  names: astLanguageNames(),
  search: getAstSearchDescription(),
  edit: getAstEditDescription(),
  matches: isAstRefusal(search) ? -1 : search.matches.length,
  trailer,
  single: isAstRefusal(single) ? single.refused : 'ok',
  pinned: isAstRefusal(pinned) ? pinned.refused : 'ok',
}))
`
  const out = execFileSync(`${process.env.HOME}/.bun/bin/bun`, ['-e', PROBE], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      MERCURY_TREESITTER_VENDOR_DIR: join(REPO, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
      MERCURY_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ast-clean-clone-home-')),
    },
  })
  const probe = JSON.parse(out.trim().split('\n').at(-1)!) as { names: string[]; search: string; edit: string; matches: number; trailer: string; single: string; pinned: string }
  check('a vscode-pack-only engine carries exactly the 16 vscode grammars', probe.names.length === vscodeNames.length && vscodeNames.every(n => probe.names.includes(n)), probe.names.join(','))
  // The advertised list is the "this build carries: a · b · c" segment of
  // each description — compared as exact tokens (a one-letter name like `c`
  // is a substring of `c-sharp` and of prose).
  const advertised = (text: string): string[] => (/this build carries: ([^;]+);/.exec(text)?.[1] ?? '').split(' · ').map(s => s.trim()).filter(Boolean)
  const searchList = advertised(probe.search)
  const editList = advertised(probe.edit)
  check('the descriptions advertise exactly the carried set (no grammar-pack language)', JSON.stringify(searchList) === JSON.stringify(probe.names) && JSON.stringify(editList) === JSON.stringify(probe.names) && packNames.every(n => !searchList.includes(n)), `${searchList.join(',')} | ${editList.join(',')}`)
  check('the descriptions still name every carried language', vscodeNames.every(n => searchList.includes(n) && editList.includes(n)))
  check('the python file still matches; the json file is skipped as uncarried and the remedy named', probe.matches === 1 && probe.trailer.includes('whose grammar this build does not carry (.json ×1)') && probe.trailer.includes('fetch-grammars'), probe.trailer)
  check('a single uncarried file refuses by name with the remedy', probe.single.includes('this build does not carry the json grammar') && probe.single.includes('fetch-grammars'), probe.single)
  check('a lang pin on an uncarried grammar refuses by name with the remedy', probe.pinned.includes('this build does not carry the json grammar'), probe.pinned)
  // And here, with the composed engine, the full set is carried and advertised.
  const here = astLanguageNames() as string[]
  const hereDescription = await AstSearchTool.description()
  const carriedHere = (registry as Array<{ wasm: string }>).filter(g => existsSync(join(engineDir, g.wasm))).length
  check(`the composed engine here carries ${here.length} of ${(registry as unknown[]).length} registry languages and advertises exactly those`, here.every(n => hereDescription.includes(n)) && here.length === carriedHere, here.join(','))
}

finish('AST SEARCH LAWS')
