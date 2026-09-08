#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const {
  GENERATED_ASSETS_MAP,
  checkChained,
  describeOwedAssets,
  generatedAssetsOwed,
  parseGeneratedAssetsMap,
  repoPathsIn,
} = await import('../../src/utils/hooks/generatedAssets.ts')
const { generatedAssetsRefusal, chainedSegmentsBeforeCommit, commitRepositoryRoot, commitPathsOf } = await import('../../src/utils/hooks/commitGate.ts')

section('§1 the tracked map is real')
const mapText = readFileSync(join(ROOT, GENERATED_ASSETS_MAP), 'utf8')
const map = parseGeneratedAssetsMap(mapText)
check('the map parses with no errors', map.errors.length === 0, map.errors.join('; '))
check('the map has rows', map.rows.length >= 10, String(map.rows.length))
const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean),
)
const untrackedAssets: string[] = []
const deadScripts: string[] = []
const deadSources: string[] = []
for (const row of map.rows) {
  for (const asset of row.assets) {
    const hit = /[*?{]/.test(asset) ? [...tracked].some(t => new Bun.Glob(asset).match(t)) : tracked.has(asset)
    if (!hit) untrackedAssets.push(asset)
  }
  for (const command of [row.generator, ...(row.check === null ? [] : [row.check])]) {
    for (const part of command.split('&&')) {
      const script = part
        .trim()
        .split(/\s+/)
        .find(w => /[\\/]/.test(w) && !w.startsWith('-'))
      if (script !== undefined && !existsSync(join(ROOT, script))) deadScripts.push(script)
    }
  }
  for (const source of row.sources) {
    if (source.startsWith('files-of:') && !existsSync(join(ROOT, source.slice('files-of:'.length)))) deadSources.push(source)
  }
}
check('every asset is a tracked file (or a glob over tracked files)', untrackedAssets.length === 0, untrackedAssets.join(', '))
check('every generator and check names a script that exists', deadScripts.length === 0, deadScripts.join(', '))
check('every files-of source exists', deadSources.length === 0, deadSources.join(', '))
const settingsRow = map.rows.find(r => r.assets.includes('scripts/settings/settings-schema.json'))
check('settings types map to the schema snapshot with its generator and check', settingsRow !== undefined && settingsRow.sources.includes('src/utils/settings/**') && settingsRow.generator.includes('gen-settings-schema') && (settingsRow.check ?? '').includes('prove-settings-schema'))
const inkRow = map.rows.find(r => r.assets.includes('scripts/ink-runtime/facade-inventory.json'))
check('the facade inventory is a row', inkRow !== undefined && inkRow.sources.includes('src/ink.ts'))
check('repoPathsIn reads the paths a census names', repoPathsIn('{"sites":[{"file":"src/a/b.ts","line":3},{"file":"scripts/x/y.sh"}]}').join(',') === 'src/a/b.ts,scripts/x/y.sh')
check('repoPathsIn reads the keys of the contract inventory', repoPathsIn(readFileSync(join(ROOT, 'scripts/ownership/contract-inventory.json'), 'utf8')).includes('src/utils/settings/types.ts'))
const badMap = parseGeneratedAssetsMap('# c\na.json\tgen a\n')
check('a row with fewer than four columns is a parse error', badMap.errors.length === 1 && badMap.rows.length === 0)

section('§2 the pure verdict')
const rows = parseGeneratedAssetsMap(
  [
    'gen/schema.json\tbun gen.ts\tbun scripts/check-schema.ts\tsrc/settings/**',
    'gen/census.json\tbun gen-census.ts\tbun scripts/check-census.ts --strict\tfiles-of:gen/census.json',
    'gen/imports.json\tbun gen-imports.ts\tbun scripts/check-imports.ts\tre:from \'[^\']*/ink/',
    'a.out b.out\tbun gen-two.ts\t-\tsrc/two/**',
  ].join('\n'),
).rows
const files: Record<string, string> = {
  'gen/census.json': '{"sites":[{"file":"src/lib/spawn.ts"}]}',
  'src/settings/types.ts': 'export type A = 1',
  'src/lib/spawn.ts': 'spawn()',
  'src/other/x.ts': "import { a } from '../ink/frame.js'",
  'src/plain.ts': 'nothing',
  'src/two/t.ts': 'two',
}
const verdict = (commitPaths: string[], chainedVerifies: string[] = []) =>
  generatedAssetsOwed({ rows, commitPaths, contentOf: p => files[p] ?? null, readFile: p => files[p] ?? null, chainedVerifies })
check('a touched glob source without the asset is owed', verdict(['src/settings/types.ts']).map(o => o.row.assets[0]).join(',') === 'gen/schema.json')
check('…naming the touched path and the source', verdict(['src/settings/types.ts'])[0]!.touched[0]!.path === 'src/settings/types.ts' && verdict(['src/settings/types.ts'])[0]!.touched[0]!.source === 'src/settings/**')
check('the asset in the commit settles it', verdict(['src/settings/types.ts', 'gen/schema.json']).length === 0)
check('the check chained before the commit settles it', verdict(['src/settings/types.ts'], ['bun scripts/check-schema.ts']).length === 0)
check('a chained check must carry its own flags', verdict(['src/lib/spawn.ts'], ['bun scripts/check-census.ts']).length === 1 && verdict(['src/lib/spawn.ts'], ['bun scripts/check-census.ts --strict']).length === 0)
check('a files-of source claims the files the census names', verdict(['src/lib/spawn.ts'])[0]?.row.assets[0] === 'gen/census.json')
check('a re: source claims a changed file by its content', verdict(['src/other/x.ts'])[0]?.row.assets[0] === 'gen/imports.json')
check('an untouched row owes nothing', verdict(['src/plain.ts']).length === 0)
check('every sibling output must be accounted for', verdict(['src/two/t.ts', 'b.out']).length === 1 && verdict(['src/two/t.ts', 'a.out', 'b.out']).length === 0)
check('a row without a check owes the asset itself', describeOwedAssets(verdict(['src/two/t.ts'])).includes('no separate check'))
check('the refusal names the asset, the touched path, the generator and the check', (() => {
  const text = describeOwedAssets(verdict(['src/settings/types.ts']))
  return text.includes('gen/schema.json') && text.includes('src/settings/types.ts') && text.includes('bun gen.ts') && text.includes('bun scripts/check-schema.ts')
})())
check('checkChained matches the script path, not a bare word', checkChained('bun scripts/x/prove-y.ts', ['bun scripts/x/prove-y.ts']) && !checkChained('bun scripts/x/prove-y.ts', ['bun scripts/x/prove-z.ts']))

for (const text of ['printf scripts/x/prove-y.ts --strict', 'echo bun scripts/x/prove-y.ts --strict', 'bun scripts/x/prove-y.ts --strictly', 'printf ignored # bun scripts/x/prove-y.ts --strict']) {
  check('printed, commented and prefix-only checker text cannot discharge an obligation', !checkChained('bun scripts/x/prove-y.ts --strict', [text]))
}
check('the actual invocation accepts an equivalent bun run spelling', checkChained('bun scripts/check-schema.ts', ['bun run "scripts/check-schema.ts"']))
check('a removed content match still owes its generated output', generatedAssetsOwed({ rows, commitPaths: ['src/plain.ts'], contentOf: () => '', previousContentOf: () => "import { x } from '../ink/frame.js'", readFile: () => null, chainedVerifies: [] }).some(row => row.row.assets.includes('gen/imports.json')))
for (const [path, asset] of [
  ['src/new-component.tsx', 'scripts/consistency-census/lockup-census.json'],
  ['scripts/new/prove-spawn.ts', 'scripts/consistency-census/shellstring-census.json'],
  ['src/components/Message.tsx', 'scripts/ink-runtime/deep-import-inventory.json'],
  ['scripts/consistency-census/gen-lockup-census.ts', 'scripts/consistency-census/lockup-census.json'],
]) check('the real map covers new inputs, deleted imports and generator changes', generatedAssetsOwed({ rows: map.rows, commitPaths: [path!], contentOf: () => '', readFile: () => null, chainedVerifies: [] }).some(row => row.row.assets.includes(asset!)))
check('one completion output cannot stand for all three', generatedAssetsOwed({ rows: map.rows, commitPaths: ['src/main.tsx', 'assets/completions/mercury.bash'], contentOf: () => '', readFile: () => null, chainedVerifies: [] }).some(row => row.row.assets.includes('assets/completions/_mercury')))

section('§3 a real repository, through the gate reader')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'generated-assets-')))
const repo = join(scratch, 'repo')
mkdirSync(join(repo, 'scripts', 'gate'), { recursive: true })
mkdirSync(join(repo, 'src', 'settings'), { recursive: true })
mkdirSync(join(repo, 'gen'), { recursive: true })
const g = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' } })
g('init', '-q')
writeFileSync(join(repo, 'scripts/gate/generated-assets.tsv'), 'gen/schema.json\tbun scripts/gen.ts\tbun scripts/prove-schema.ts\tsrc/settings/**\n')
writeFileSync(join(repo, 'src/settings/types.ts'), 'export type A = 1\n')
writeFileSync(join(repo, 'gen/schema.json'), '{}\n')
g('add', '-A')
g('commit', '-q', '-m', 'seed')
writeFileSync(join(repo, 'src/settings/types.ts'), 'export type A = 2\n')
check('same-command staging cannot outrun the checked index', (generatedAssetsRefusal('git add src/settings/types.ts && bun run typecheck && git commit -F m', repo) ?? '').includes('stable commit candidate'))
check('path-limited commits include unstaged tracked changes', commitPathsOf(repo, 'git commit --only src/settings/types.ts -F m').includes('src/settings/types.ts') && generatedAssetsRefusal('git commit --only src/settings/types.ts -F m', repo) !== null)
check('an explicit cwd change uses the selected repository', generatedAssetsRefusal(`cd "${repo}" && git commit --only src/settings/types.ts -F m`, scratch) !== null)
g('add', 'src/settings/types.ts')
check('the index carries the source', commitPathsOf(repo, 'git commit -F m').join(',') === 'src/settings/types.ts')
const refusal = generatedAssetsRefusal('git commit -F m', repo)
check('a commit with the source staged alone is refused', refusal !== null)
check('…naming the asset, the source, the generator and the check', (refusal ?? '').includes('gen/schema.json') && (refusal ?? '').includes('src/settings/types.ts') && (refusal ?? '').includes('bun scripts/gen.ts') && (refusal ?? '').includes('bun scripts/prove-schema.ts'), refusal ?? '')
check('a verify chained before it does not settle the asset (a verify is not the check)', generatedAssetsRefusal('bun run build.ts && git commit -F m', repo) !== null)
check("the row's check chained before the commit settles it", generatedAssetsRefusal('bun scripts/prove-schema.ts && git commit -F m', repo) === null)
check('the check behind a break op does not settle it', generatedAssetsRefusal('bun scripts/prove-schema.ts ; git commit -F m', repo) !== null)
check('chainedSegmentsBeforeCommit walks the unbroken run only', chainedSegmentsBeforeCommit('a ; b && c && git commit -F m').join(',') === 'c,b')
writeFileSync(join(repo, 'gen/schema.json'), '{"v":2}\n')
check('the regenerated asset in the working tree alone is not in the commit', generatedAssetsRefusal('git commit -F m', repo) !== null)
check('…but a -a commit carries it', generatedAssetsRefusal('git commit -a -F m', repo) === null)
check('an attached commit message is not an all-files option', generatedAssetsRefusal('git commit -mdata', repo) !== null)
check('a short option cluster still recognizes all-files before its message', generatedAssetsRefusal('git commit -amdata', repo) === null)
g('add', 'gen/schema.json')
check('the asset staged beside its source settles it', generatedAssetsRefusal('git commit -F m', repo) === null)
g('restore', '--staged', 'gen/schema.json')
check('a `git -C <dir> commit` from another directory reads that repository', commitRepositoryRoot(`git -C ${repo} commit -F m`, scratch) === repo && generatedAssetsRefusal(`git -C ${repo} commit -F m`, scratch) !== null)
const bare = join(scratch, 'nomap')
mkdirSync(bare)
execFileSync('git', ['init', '-q'], { cwd: bare })
writeFileSync(join(bare, 'x.txt'), 'x')
execFileSync('git', ['add', 'x.txt'], { cwd: bare })
check('a repository with no map owes nothing', generatedAssetsRefusal('git commit -F m', bare) === null)
check('a directory outside any repository owes nothing', generatedAssetsRefusal('git commit -F m', tmpdir()) === null)
writeFileSync(join(repo, 'scripts/gate/generated-assets.tsv'), 'broken row\n')
check('a map that does not parse refuses, naming the map', (generatedAssetsRefusal('git commit -F m', repo) ?? '').includes('does not parse'))
rmSync(scratch, { recursive: true, force: true })

section('§4 the wiring')
const gate = readFileSync(join(ROOT, 'src/utils/hooks/commitGate.ts'), 'utf8')
check('the hook consults the rule when the shape allows', gate.includes('if (shape.allow) return generatedAssetsVerdict(command)'))
check('…and after the receipt road allows', /freshReceipt: fresh \}\)\.allow\) return false\s*\n\s*return generatedAssetsVerdict\(command\)/.test(gate))
check('the rule reads the map through the one parser', gate.includes("from './generatedAssets.js'"))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
