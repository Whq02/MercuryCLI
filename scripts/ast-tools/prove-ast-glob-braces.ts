import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { armEnvironment, check, drive, enterRoot, finish, makeContext, REPO } from './lib/harness.ts'

const env = armEnvironment()
const { AstSearchTool } = await import(join(REPO, 'src/tools/AstSearchTool/AstSearchTool.ts'))
const { AstEditTool } = await import(join(REPO, 'src/tools/AstEditTool/AstEditTool.ts'))
const { resolveAstScope, isAstRefusal } = await import(join(REPO, 'src/utils/astPatterns.ts'))
const root = mkdtempSync(join(tmpdir(), 'ast-braces-'))
try {
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'lib'))
  const originals = new Map([
    ['src/a.ts', 'normalizeRecord(1)\n'],
    ['src/b.tsx', 'normalizeRecord(2)\n'],
    ['lib/b.ts', 'normalizeRecord(3)\n'],
    ['src/literal.{ts', 'normalizeRecord(4)\n'],
  ])
  for (const [file, text] of originals) writeFileSync(join(root, file), text)
  await enterRoot(root)
  const prover = await makeContext([AstSearchTool, AstEditTool])
  const input = { pattern: 'normalizeRecord($$$A)', path: 'src', glob: '**/*.{ts,tsx}' }
  const search = await drive(AstSearchTool, input, prover)
  check('brace extensions search both TS and TSX files', !search.isError && search.data?.matchCount === 2 && search.data?.fileCount === 2 && search.text.includes('2 matches in 2 files.') && search.text.includes('Searched 2 of 2 files under src (glob **/*.{ts,tsx})'), search.text)
  const union = await drive(AstSearchTool, { ...input, path: '.', glob: '{src/a.ts,lib/b.ts}' }, prover)
  check('brace paths keep exactly the two alternatives', !union.isError && union.data?.matchCount === 2 && union.text.includes('src/a.ts:') && union.text.includes('lib/b.ts:') && !union.text.includes('src/b.tsx:'), union.text)
  const dry = await drive(AstEditTool, { ...input, rewrite: 'normaliseRecord($$$A)' }, prover)
  check('brace dry run and search have identical match and file counts', !dry.isError && dry.data?.state === 'dry-run' && dry.data?.matchCount === search.data?.matchCount && dry.data?.fileCount === search.data?.fileCount && dry.data?.matchCount === 2, dry.text)
  check('brace dry run writes nothing', [...originals].every(([file, text]) => readFileSync(join(root, file), 'utf8') === text))
  for (const glob of ['{a,b,c}/{d,e,f}/{g,h,i}/{j,k,l}/*.ts', `{${Array.from({ length: 65 }, (_, i) => `f${i}.ts`).join(',')}}`]) {
    const expected = `glob "${glob}" expands to more than 64 alternatives — use fewer {a,b} lists or a broader glob.`
    let readableCalls = 0
    const scope = resolveAstScope({ cwd: root, glob, readable: () => { readableCalls++; return true } })
    check('more than 64 alternatives refuse before reaching files', isAstRefusal(scope) && scope.refused === expected && readableCalls === 0)
    for (const tool of [AstSearchTool, AstEditTool]) {
      const result = await drive(tool, { pattern: input.pattern, glob, ...(tool.name === 'AstEdit' ? { rewrite: 'changed($$$A)' } : {}) }, prover)
      check(`${tool.name}: expansion overflow is exactly the shared scope refusal`, result.isError && result.text === `<tool_use_error>${expected}</tool_use_error>`, result.text)
    }
  }
  const empty = await drive(AstEditTool, { ...input, glob: '**/*.vue', rewrite: 'changed($$$A)' }, prover)
  check('empty edit scope reports Nothing searched and no-matches', !empty.isError && empty.data?.state === 'no-matches' && empty.text === 'Nothing searched: no files with a supported language under src matching **/*.vue — nothing to rewrite.', empty.text)
  const noMatches = await drive(AstEditTool, { ...input, pattern: 'absentName($$$A)', rewrite: 'changed($$$A)' }, prover)
  check('nonempty scope with no matches retains No matches', !noMatches.isError && noMatches.text.startsWith('No matches for "absentName($$$A)" — nothing to rewrite.'), noMatches.text)
  const unbalanced = await drive(AstSearchTool, { ...input, glob: '**/*.{ts' }, prover)
  check('unbalanced braces remain literal', !unbalanced.isError && unbalanced.data?.filesSearched === 0, unbalanced.text)
  for (const [glob, expected] of [
    ['{src/{a.ts,b.tsx},lib/b.ts}', ['lib/b.ts', 'src/a.ts', 'src/b.tsx']],
    ['**/*.{ts,{tsx,jsx}}', ['lib/b.ts', 'src/a.ts', 'src/b.tsx']],
    ['{ts}', []],
    ['**/*.{ts', []],
    [`{${Array.from({ length: 64 }, (_, i) => i === 0 ? 'src/a.ts' : `absent${i}.ts`).join(',')}}`, ['src/a.ts']],
  ] as Array<[string, string[]]>) {
    const scope = resolveAstScope({ cwd: root, glob })
    check(`scope alternatives ${glob.slice(0, 65)}`, !isAstRefusal(scope) && JSON.stringify(scope.files.map(f => f.rel)) === JSON.stringify(expected), isAstRefusal(scope) ? scope.refused : scope.files.map(f => f.rel).join(','))
  }
  const single = resolveAstScope({ cwd: root, path: 'src/a.ts', glob: '{a,b,c}/{d,e,f}/{g,h,i}/{j,k,l}/*.ts' })
  check('single-file path still ignores glob expansion', !isAstRefusal(single) && single.files.length === 1 && single.files[0]?.rel === 'a.ts')
  const applied = await drive(AstEditTool, { ...input, rewrite: 'normaliseRecord($$$A)', apply: true, plan: dry.data?.plan ?? 'ae-missing' }, prover)
  check('brace apply writes exactly the previewed TS and TSX files', !applied.isError && applied.data?.state === 'applied' && readFileSync(join(root, 'src/a.ts'), 'utf8') === 'normaliseRecord(1)\n' && readFileSync(join(root, 'src/b.tsx'), 'utf8') === 'normaliseRecord(2)\n' && readFileSync(join(root, 'lib/b.ts'), 'utf8') === originals.get('lib/b.ts'), applied.text)
} finally {
  process.chdir(REPO)
  for (const dir of [root, env.home, env.engineDir]) rmSync(dir, { recursive: true, force: true })
}
finish('AST BRACE GLOBS')
