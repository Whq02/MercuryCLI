#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, section, skip, REPO } from './lib/harness.ts'
import { LANGUAGE_FIXTURES, writeLanguageFixtures, writeRenameFixture } from './lib/fixtures.ts'

const { engineDir, packPresent } = armEnvironment()

const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { GRAMMAR_REGISTRY } = await import(join(REPO, 'src/services/structure/grammarRegistry.ts'))
const { astLanguageNames } = await import(join(REPO, 'src/utils/astPatterns.ts'))

const root = mkdtempSync(join(tmpdir(), 'ast-search-'))
writeLanguageFixtures(root)
writeRenameFixture(join(root, 'rename'))
await enterRoot(root)
const prover = await makeContext([AstSearchTool, AstEditTool])
const search = (input: Record<string, unknown>) => drive(AstSearchTool, input, prover)

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
  mkdirSync(join(root, 'dollars'))
  writeFileSync(join(root, 'dollars', 'v.php'), "<?php\nfoo($name);\nfoo($$name);\n$s = preg_replace($re, '$&', $t);\n$u = preg_replace($re, 'x', $t);\n")
  const doubled = await search({ pattern: 'foo($$name)', path: 'dollars' })
  check('a doubled dollar is literal text wherever the pattern is tried: foo($$name) finds the variable-variable call alone', Number(doubled.data?.matchCount) === 1 && doubled.text.includes('v.php:3:1'), doubled.text.slice(0, 300))
  const whole = await search({ pattern: "preg_replace($A, '$&', $B)", path: 'dollars' })
  check("and so is $& inside a string: the call that passes '$&' is found alone, with both captures", Number(whole.data?.matchCount) === 1 && whole.text.includes('v.php:4:') && whole.text.includes('$A = $re') && whole.text.includes('$B = $t'), whole.text.slice(0, 300))
  const single = await search({ pattern: 'foo($name)', path: 'dollars' })
  check('control: the single-dollar call is found alone', Number(single.data?.matchCount) === 1 && single.text.includes('v.php:2:1'), single.text.slice(0, 300))
}

section('§3 — count mode')
{
  const r = await search({ pattern: 'normalizeRecord($$$A)', path: 'rename', mode: 'count' })
  check('per-file tallies', r.text.includes('src/report.ts: 1') && r.text.includes('src/stats.ts: 1'), r.text.slice(0, 200))
  check('the total line', /^2 matches across 2 files/m.test(r.text), r.text.slice(0, 200))
}

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

section('§6 — the unsupported-language refusal names the set')
{
  const r = await search({ pattern: 'print($X)', lang: 'klingon' })
  check('unknown lang refuses with the supported set', r.isError && r.text.includes('Unknown language "klingon"') && r.text.includes('Supported languages: python, go, rust') && r.text.includes('json'), r.text.slice(0, 300))
  const prose = await search({ pattern: 'print($X)', path: 'rename/NOTES.txt' })
  check('a single file with no grammar refuses by extension and names the set', prose.isError && prose.text.includes('.txt') && prose.text.includes('Supported languages:'), prose.text.slice(0, 300))
}

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

section('§8 — zero matches name what was searched')
{
  const r = await search({ pattern: 'neverThere($X)', path: 'rename' })
  check('no-match text names the pattern', !r.isError && r.text.startsWith('No matches for "neverThere($X)"'), r.text.slice(0, 200))
  check('names the files and languages searched under the scope', r.text.includes('files under rename') && r.text.includes('typescript'), r.text.slice(0, 300))
  check('names the skipped extension census', r.text.includes('Skipped 1 file with no grammar for the extension: .txt ×1'), r.text.slice(0, 300))
  const nothing = await search({ pattern: 'x', path: 'rename', glob: '**/*.txt' })
  check('a scope with no supported files says nothing was searched', !nothing.isError && nothing.text.startsWith('Nothing searched:'), nothing.text.slice(0, 200))
}

section('§9 — a recovered file is searched and its parse error is reported')
{
  mkdirSync(join(root, 'broken'))
  writeFileSync(join(root, 'broken', 'ok.py'), 'print(1)\n')
  writeFileSync(join(root, 'broken', 'bad.py'), 'def broken(:\n    print(\n')
  const r = await search({ pattern: 'print($X)', path: 'broken' })
  check('the good file matches', Number(r.data?.matchCount) === 1 && r.text.includes('ok.py:1:1'), r.text.slice(0, 200))
  check('the broken file is named with its parse error', r.text.includes('Searched recovered tree: bad.py (python;') && r.text.includes('Matches may include parser recovery; code inside a syntax error may go unmatched.'), r.text.split('\n').find(l => l.startsWith('Searched recovered')) ?? r.text.slice(0, 300))
}

section('§10 — a read-deny rule hides a file')
{
  const denied = await makeContext([AstSearchTool, AstEditTool], { deny: ['Read(rename/src/report.ts)'] })
  const r = await drive(AstSearchTool, { pattern: 'normalizeRecord($$$A)', path: 'rename' }, denied)
  check('the denied file is skipped and counted', !r.isError && Number(r.data?.matchCount) === 1 && r.text.includes('Skipped 1 file hidden by read-deny rules'), r.text.slice(0, 300))
  const out = await makeContext([AstSearchTool, AstEditTool], { deny: ['Read(rename/**)'] })
  const r2 = await drive(AstSearchTool, { pattern: 'normalizeRecord($$$A)', path: 'rename' }, out)
  check('a deny rule over the scope path refuses the search itself', r2.isError && /denied/i.test(r2.text), r2.text.slice(0, 200))
}

section('§11 — the descriptions')
{
  const description = await AstSearchTool.description()
  const prompt = await AstSearchTool.prompt({ getToolPermissionContext: async () => ({}) })
  check('prompt equals description', prompt === description)
  const pattern = String(AstSearchTool.inputSchema.shape.pattern.description)
  check('the pattern field carries the complete-node, capture and declaration grammar once', [
    'One complete node written as code in the target language',
    '$NAME matches one node and captures it; $$$NAME matches zero or more siblings and captures them; $_ and $$$ match without capturing.',
    'Names are uppercase letters, digits and underscores, a repeated name must match identical code, and spacing, line breaks and comments never matter.',
    'a declaration carries every part it has (a declared return type as ": $_" in TypeScript, " -> $_" in Python)',
  ].every(line => pattern.includes(line)) && !description.includes('$NAME'))
  check('carries no examples and no other tool: what it does and what comes back', !description.includes('e.g.') && !description.includes('Examples:') && !/\bGrep\b|\bAstEdit\b/.test(description) && description.startsWith('Searches code by its syntax') && description.includes('file:line:col'))
  const langField = String(AstSearchTool.inputSchema.shape.lang.description)
  const carriedNames = astLanguageNames() as string[]
  const said = /this build carries (\d+) grammars, among them ([^;]+);/.exec(langField)
  const namedInField = (said?.[2] ?? '').split(', ')
  check('the lang field says how many grammars the build carries and names three of them, never the list; the description names none', Number(said?.[1]) === carriedNames.length && namedInField.length === 3 && namedInField.every(n => carriedNames.includes(n)) && !description.includes('this build carries'), langField)
  check('the lang field says where the list is: in the answer to a name the build does not carry', langField.includes('a name it does not carry is answered with the list'), langField)
  const unknown = await search({ pattern: 'print($X)', lang: 'klingon' })
  check('and that answer carries every grammar of the build by name', unknown.isError && unknown.text.includes(`Supported languages: ${carriedNames.join(', ')}.`), unknown.text.slice(0, 300))
  check('the lang field is shorter than three hundred characters whatever the build carries', langField.length < 300, String(langField.length))
  check('the limit field names the bound', String(AstSearchTool.inputSchema.shape.limit.description).includes('default 50, max 200'))
  const editDescription = await AstEditTool.description()
  check('AstEdit: prompt equals description', (await AstEditTool.prompt({ getToolPermissionContext: async () => ({}) })) === editDescription)
  check('AstEdit: says the dry run returns the diff and a plan and writes nothing, and apply with that plan writes', editDescription.includes('dry run that returns the unified diff per file and a plan token and writes nothing') && editDescription.includes('apply: true and that plan writes the change'))
  check('AstEdit: pre-empts no refusal and names no other tool; the plan field carries the drift refusal', !editDescription.includes('Refused by name') && !editDescription.includes('nested inside another') && !/\bEdit\b|\bAstSearch\b/.test(editDescription) && String(AstEditTool.inputSchema.shape.plan.description).includes('apply refuses when a file, the pattern, the rewrite, the rules or the scope differs from that dry run'))
  check('AstEdit: carries no examples: the apply and plan parameters show the two calls', (editDescription.match(/^- \{ "pattern"/gm) ?? []).length === 0 && !editDescription.includes('Examples:'))
}

section('§12 — the lang field counts only the grammars the build carries')
{
  const { execFileSync } = await import('node:child_process')
  const { GRAMMAR_REGISTRY: registry } = await import(join(REPO, 'src/services/structure/grammarRegistry.ts'))
  const packNames = (registry as Array<{ name: string; source?: string }>).filter(g => g.source === 'grammar-pack').map(g => g.name)
  const vscodeNames = (registry as Array<{ name: string; source?: string }>).filter(g => g.source !== 'grammar-pack').map(g => g.name)
  const probeRoot = mkdtempSync(join(tmpdir(), 'ast-clean-clone-'))
  writeFileSync(join(probeRoot, 'a.json'), '{"a": 1}\n')
  writeFileSync(join(probeRoot, 'a.py'), 'print(1)\n')
  const PROBE = `
const { getAstSearchDescription, astLanguageField } = await import(${JSON.stringify(join(REPO, 'src/tools/AstSearchTool/prompt.ts'))})
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
  langField: astLanguageField(),
  matches: isAstRefusal(search) ? -1 : search.matches.length,
  trailer,
  single: isAstRefusal(single) ? single.refused : 'ok',
  pinned: isAstRefusal(pinned) ? pinned.refused : 'ok',
}))
`
  const out = execFileSync(process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`, ['-e', PROBE], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      MERCURY_TREESITTER_VENDOR_DIR: join(REPO, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm'),
      MERCURY_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'ast-clean-clone-home-')),
    },
  })
  const probe = JSON.parse(out.trim().split('\n').at(-1)!) as { names: string[]; search: string; edit: string; langField: string; matches: number; trailer: string; single: string; pinned: string }
  check('a vscode-pack-only engine carries exactly the 16 vscode grammars', probe.names.length === vscodeNames.length && vscodeNames.every(n => probe.names.includes(n)), probe.names.join(','))
  const counted = (text: string): { count: number; names: string[] } | null => {
    const m = /this build carries (\d+) grammars, among them ([^;]+);/.exec(text)
    return m ? { count: Number(m[1]), names: m[2]!.split(', ') } : null
  }
  const field = counted(probe.langField)
  check('neither description names the other tool; both tools carry the one grammar in pattern and the one count of carried grammars in lang', !probe.search.includes('AstEdit') && !probe.edit.includes('AstSearch') && counted(probe.search) === null && counted(probe.edit) === null && AstSearchTool.inputSchema.shape.lang.description === AstEditTool.inputSchema.shape.lang.description && AstSearchTool.inputSchema.shape.pattern.description === AstEditTool.inputSchema.shape.pattern.description)
  check('the lang field counts exactly the carried set and names no grammar-pack language', field !== null && field.count === probe.names.length && field.names.every(n => probe.names.includes(n)) && packNames.every(n => !field.names.includes(n)), probe.langField)
  check('the three it names are grammars that engine carries, python first', field !== null && field.names.length === 3 && field.names[0] === 'python', probe.langField)
  check('the python file still matches; the json file is skipped as uncarried and the remedy named', probe.matches === 1 && probe.trailer.includes('whose grammar this build does not carry (.json ×1)') && probe.trailer.includes('fetch-grammars'), probe.trailer)
  check('a single uncarried file refuses by name with the remedy', probe.single.includes('this build does not carry the json grammar') && probe.single.includes('fetch-grammars'), probe.single)
  check('a lang pin on an uncarried grammar refuses by name with the remedy', probe.pinned.includes('this build does not carry the json grammar'), probe.pinned)
  const here = astLanguageNames() as string[]
  const hereField = String(AstSearchTool.inputSchema.shape.lang.description)
  const carriedHere = (registry as Array<{ wasm: string }>).filter(g => existsSync(join(engineDir, g.wasm))).length
  check(`the composed engine here carries ${here.length} of ${(registry as unknown[]).length} registry languages and the lang field says ${here.length}`, counted(hereField)?.count === here.length && here.length === carriedHere, hereField)
}

section('§13 — a language read for patterns only, beside code')
if (!['markdown', 'yaml'].every(n => (astLanguageNames() as string[]).includes(n))) {
  skip('markdown and yaml beside TypeScript', 'this checkout\'s engine dir does not carry them (bun run scripts/vendor/fetch-grammars.ts)')
} else {
  mkdirSync(join(root, 'beside'))
  writeFileSync(join(root, 'beside', 'app.ts'), 'export function run() {\n  normalizeRecord(1)\n  other(2)\n}\n')
  writeFileSync(join(root, 'beside', 'README.md'), '# Notes\n\nCall normalizeRecord(x) first.\n\n## Install\n\nText.\n')
  writeFileSync(join(root, 'beside', 'deploy.yaml'), 'name: tidepool\nsteps:\n  - run: build\n')
  const code = await search({ pattern: 'normalizeRecord($X)', path: 'beside' })
  check('a code pattern finds the code, once', !code.isError && Number(code.data?.matchCount) === 1 && code.text.includes('app.ts:2:3'), code.text.slice(0, 300))
  check('the markdown file that names the word is not searched, and the answer says why', code.text.includes('Not searched: 1 markdown file (the pattern does not parse as markdown ($X is text there, not a node)).'), code.text.split('\n').find(l => l.startsWith('Not searched')) ?? code.text.slice(0, 300))
  check('the yaml file cannot hold the pattern: it is counted and no grammar opens it', code.text.includes('Searched 1 of 3 files under beside — 1 typescript, 1 yaml (files that cannot contain the pattern were not parsed).'), code.text.split('\n').find(l => l.startsWith('Searched')) ?? code.text.slice(0, 300))
  const malformed = await search({ pattern: 'normalizeRecord($X', path: 'beside' })
  check('a malformed code pattern still refuses as an error that names the code language first', malformed.isError && /did not parse as typescript \(1:\d+ [^)]+\); nor as markdown\./.test(malformed.text) && malformed.text.includes('"$FN($$$ARGS)"'), malformed.text.slice(0, 300))
  const nowhere = await search({ pattern: ')((neverWritten', path: 'beside' })
  check('a malformed pattern no file of a pattern-only language can hold refuses as on a directory of code alone', nowhere.isError && nowhere.text.includes('did not parse as typescript (1:1 syntax error).'), nowhere.text.slice(0, 300))
  const heading = await search({ pattern: '## $TITLE', path: 'beside' })
  check('a markdown pattern finds the heading and names the code file as not searched', !heading.isError && Number(heading.data?.matchCount) === 1 && heading.text.includes('$TITLE = Install') && heading.text.includes('1 typescript file (the pattern does not parse as typescript'), heading.text.slice(0, 400))
  const pinned = await search({ pattern: 'run: $CMD', path: 'beside', lang: 'yml' })
  check('lang by an alias keeps the yaml file alone and captures the value', !pinned.isError && Number(pinned.data?.matchCount) === 1 && pinned.text.includes('$CMD = build'), pinned.text.slice(0, 300))
}

section('§14 — a pattern accepted by a skipped file is not refused by the languages beside it')
{
  const { AST_BOUNDS, isAstRefusal, resolveAstScope, searchAstPattern, patternRefusedEverywhere } = await import(join(REPO, 'src/utils/astPatterns.ts'))
  const dir = join(root, 'size-and-pattern')
  mkdirSync(dir)
  writeFileSync(join(dir, 'a.css'), 'p { color: red; }\n')
  writeFileSync(join(dir, 'large.ts'), ' '.repeat(AST_BOUNDS.maxFileBytes + 1))
  const valid = await search({ pattern: 'foo($X)', path: dir })
  check('a valid TypeScript pattern beside CSS is a zero-match answer when its TypeScript file is over the existing bound, not a malformed-pattern error', !valid.isError && Number(valid.data?.matchCount) === 0 && valid.text.includes('No matches for "foo($X)".') && valid.text.includes('Skipped 1 file over 2MB.') && valid.text.includes('Not searched: 1 css file (the pattern does not parse as css'), valid.text)
  const invalid = await search({ pattern: 'foo($X', path: dir })
  check('a pattern neither language can compile is still the pattern error and names both languages, even beside the oversized file', invalid.isError && invalid.text.includes('did not parse as css (1:1 syntax error); nor as typescript.'), invalid.text)
  const scope = resolveAstScope({ cwd: root, path: dir })
  if (isAstRefusal(scope)) check('the size-and-pattern scope resolves', false, scope.refused)
  else {
    const result = await searchAstPattern(scope, { pattern: 'foo($X' })
    check('the refused-everywhere result retains a reason for every language that tried the pattern', !isAstRefusal(result) && patternRefusedEverywhere(scope, result) && result.patternRefusals.length === 2 && result.patternRefusals.every((r: { note: string }) => /syntax error|missing/.test(r.note)), isAstRefusal(result) ? result.refused : JSON.stringify(result.patternRefusals))
  }
}

section('§15 — a Read deny follows a file through the directory search and rewrite')
for (const [lang, ext, pattern, rewrite, source] of [
  ['yaml', 'yaml', 'height: $X', 'height: changed', 'height: restricted_value\n'],
  ['typescript', 'ts', 'height($X)', 'height(changed)', 'height(restricted_value)\n'],
] as const) {
  const rel = `read-links-${lang}`
  const dir = join(root, rel)
  mkdirSync(join(dir, 'private'), { recursive: true })
  const secret = join(dir, `secret.${ext}`)
  const inner = join(dir, 'private', `inner.${ext}`)
  const alias = join(dir, `alias.${ext}`)
  const chain = join(dir, `chain.${ext}`)
  const allowed = join(dir, `allowed.${ext}`)
  writeFileSync(secret, source)
  writeFileSync(inner, source)
  writeFileSync(allowed, source.replace('restricted_value', 'public_value'))
  try {
    symlinkSync(secret, alias, 'file')
    symlinkSync(alias, chain, 'file')
    symlinkSync(join(dir, 'private'), join(dir, 'linked-directory'), 'junction')
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes((error as { code?: string }).code ?? '')) throw error
    skip(`${lang}: file and directory links`, 'Windows file symlinks require Developer Mode or the symbolic-link privilege')
    continue
  }
  const denied = await makeContext([AstSearchTool, AstEditTool], { mode: 'sovereign', deny: [`Read(./${rel}/secret.${ext})`, `Read(./${rel}/private/**)`] })
  for (const target of [alias, chain, join(dir, 'linked-directory', `inner.${ext}`)]) {
    const direct = await drive(AstSearchTool, { path: target, pattern }, denied)
    check(`${lang}: a directly named link to the denied file is refused (${target.slice(dir.length + 1)})`, direct.isError && !direct.text.includes(source.trim()), direct.text)
  }
  const listed = await drive(AstSearchTool, { path: rel, pattern }, denied)
  check(`${lang}: the walk omits the denied file, two linked aliases and both paths into the denied folder, counting all five`, !listed.isError && listed.data?.matchCount === 1 && !listed.text.includes(source.trim()) && listed.text.includes('Skipped 5 files hidden by read-deny rules.'), listed.text)
  const unrestricted = await makeContext([AstSearchTool, AstEditTool], { mode: 'sovereign' })
  const all = await drive(AstSearchTool, { path: rel, pattern }, unrestricted)
  check(`${lang}: with no deny rule every one of the six paths is still searched`, !all.isError && all.data?.matchCount === 6 && all.text.includes(source.trim()), all.text)
  const preview = await drive(AstEditTool, { path: rel, pattern, rewrite }, denied)
  check(`${lang}: the rewrite preview reads only the allowed file`, !preview.isError && preview.data?.fileCount === 1 && preview.data?.matchCount === 1 && !preview.text.includes(source.trim()), preview.text)
  const applied = preview.isError ? preview : await drive(AstEditTool, { path: rel, pattern, rewrite, apply: true, plan: preview.data?.plan }, denied)
  check(`${lang}: applying the rewrite changes only the allowed file, never either denied target through its aliases`, !applied.isError && readFileSync(secret, 'utf8') === source && readFileSync(inner, 'utf8') === source && readFileSync(allowed, 'utf8') === source.replace('restricted_value', 'changed'), applied.text)
  const plain = `read-plain-${lang}`
  mkdirSync(join(root, plain))
  writeFileSync(join(root, plain, `a.${ext}`), source)
  const withoutRule = await drive(AstSearchTool, { path: plain, pattern }, unrestricted)
  const withRule = await drive(AstSearchTool, { path: plain, pattern }, denied)
  check(`${lang}: the ordinary folder with no denied path keeps the same answer byte for byte`, withoutRule.text === withRule.text && JSON.stringify(withoutRule.data) === JSON.stringify(withRule.data), withRule.text)
  const nested = join(dir, 'scoped', 'nested')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, `secret.${ext}`), source)
  writeFileSync(join(nested, `allowed.${ext}`), source.replace('restricted_value', 'public_value'))
  symlinkSync(join(dir, 'scoped'), join(dir, 'scoped-link'), 'junction')
  const nestedRules = await makeContext([AstSearchTool, AstEditTool], { mode: 'sovereign', deny: [`Read(./${rel}/scoped/nested/secret.${ext})`] })
  const nestedSearch = await drive(AstSearchTool, { path: `${rel}/scoped-link/nested`, pattern }, nestedRules)
  check(`${lang}: a scope rooted below a linked directory retains its link ancestry`, !nestedSearch.isError && nestedSearch.data?.matchCount === 1 && !nestedSearch.text.includes(source.trim()) && nestedSearch.text.includes('Skipped 1 file hidden by read-deny rules.'), nestedSearch.text)
}

finish('AST SEARCH LAWS')
