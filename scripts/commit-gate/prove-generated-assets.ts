#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
let sectionFix = ''
const check = (label: string, cond: boolean, detail = ''): void => {
  const shown = [detail, sectionFix].filter(part => part !== '').join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && shown ? ' — ' + shown : ''}`)
  if (!cond) failures++
}
const section = (t: string, fix = ''): void => {
  sectionFix = fix
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const WINDOWS = process.platform === 'win32'
const notRead = (label: string, why: string): void => console.log(`  [SKIP] ${label} — not read on Windows: ${why}`)
const samePath = (a: string | null, b: string): boolean => a !== null && relative(a, b) === ''

const {
  GENERATED_ASSETS_MAP,
  GENERATED_FILE_HEAD_LINES,
  assetRowFor,
  checkChained,
  describeOwedAssets,
  describeUnregisteredGeneratedFiles,
  generatedAssetsOwed,
  generatedFileDeclaration,
  parseGeneratedAssetsMap,
  repoPathsIn,
  unregisteredGeneratedFiles,
} = await import('../../src/permissions/guards/generatedAssets.ts')
const { formatGeneratedAssetRow, registerGeneratedAsset, upsertGeneratedAssetRow } = await import('../lib/generated-assets-map.mjs')
const { generatedAssetsRefusal, chainedSegmentsBeforeCommit, commitRepositoryRoot, commitPathsOf } = await import('../../src/permissions/guards/commitGate.ts')

section('§1 the tracked map is real', 'fix the row the check names in the map file GENERATED_ASSETS_MAP points to (src/permissions/guards/generatedAssets.ts), or parseGeneratedAssetsMap and repoPathsIn there when the reader is wrong')
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
const sdkParked = ![...tracked].some(t => t.startsWith('sdk/'))
if (sdkParked) console.log('  [skip] the SDK is parked and not on this tree (the published lineage carries no sdk/): its asset row is read where it stands')
for (const row of map.rows) {
  for (const asset of row.assets) {
    if (sdkParked && asset.startsWith('sdk/')) continue
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
check('settings types map to the schema snapshot with its generator and check', settingsRow !== undefined && settingsRow.sources.includes('src/platform/settings/**') && settingsRow.generator.includes('gen-settings-schema') && (settingsRow.check ?? '').includes('prove-settings-schema'))
check('repoPathsIn reads the paths a census names', repoPathsIn('{"sites":[{"file":"src/a/b.ts","line":3},{"file":"scripts/x/y.sh"}]}').join(',') === 'src/a/b.ts,scripts/x/y.sh')
check('repoPathsIn reads the keys of the contract inventory', repoPathsIn(readFileSync(join(ROOT, 'scripts/ownership/contract-inventory.json'), 'utf8')).includes('src/platform/settings/settingsSchema.ts'))
const badMap = parseGeneratedAssetsMap('# c\na.json\tgen a\n')
check('a row with fewer than four columns is a parse error', badMap.errors.length === 1 && badMap.rows.length === 0)

section('§2 the pure verdict', 'change generatedAssetsOwed, checkChained or describeOwedAssets in src/permissions/guards/generatedAssets.ts')
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
  'src/other/x.ts': "import { a } from '../screen/renderer/frame.js'",
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
check('a removed content match still owes its generated output', generatedAssetsOwed({ rows, commitPaths: ['src/plain.ts'], contentOf: () => '', previousContentOf: () => "import { x } from '../screen/renderer/frame.js'", readFile: () => null, chainedVerifies: [] }).some(row => row.row.assets.includes('gen/imports.json')))
for (const [path, asset] of [
  ['src/platform/settings/newKey.ts', 'scripts/settings/settings-schema.json'],
  ['src/screen/messages/Message.tsx', 'scripts/ink-runtime/deep-import-inventory.json'],
  ['scripts/settings/gen-settings-schema.ts', 'scripts/settings/settings-schema.json'],
]) check('the real map covers new inputs, deleted imports and generator changes', generatedAssetsOwed({ rows: map.rows, commitPaths: [path!], contentOf: () => '', readFile: () => null, chainedVerifies: [] }).some(row => row.row.assets.includes(asset!)))
const rampOwed = (text: string): boolean => generatedAssetsOwed({ rows: map.rows, commitPaths: ['src/anywhere/rows.ts'], contentOf: () => text, readFile: () => null, chainedVerifies: [] }).some(owed => owed.row.generator === 'bun scripts/splash/bake-ramp.mjs')
check("a changed file that holds the truecolor flag's row owes the splash core, wherever the registry keeps it", rampOwed("{ env: 'MERCURY_TRUECOLOR', kind: 'switch' }") && !rampOwed("{ env: 'MERCURY_OTHER', kind: 'switch' }"))
check('one completion output cannot stand for all three', generatedAssetsOwed({ rows: map.rows, commitPaths: ['src/boot/main.tsx', 'assets/completions/mercury.bash'], contentOf: () => '', readFile: () => null, chainedVerifies: [] }).some(row => row.row.assets.includes('assets/completions/_mercury')))

section('§3 a real repository, through the gate reader', 'change generatedAssetsRefusal or commitPathsOf in src/permissions/guards/commitGate.ts, or generatedAssetsOwed in src/permissions/guards/generatedAssets.ts')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'generated-assets-')))
const repo = join(scratch, 'repo with spaces')
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
writeFileSync(join(repo, 'src/settings/types.ts'), 'export type A = 1\n')
check('a checker cannot attest an index value hidden by the working copy', (generatedAssetsRefusal('bun scripts/prove-schema.ts && git commit -F m', repo) ?? '').includes('differs from the commit candidate'))
writeFileSync(join(repo, 'src/settings/types.ts'), 'export type A = 2\n')
writeFileSync(join(repo, 'gen/schema.json'), '{"unstaged":true}\n')
check('a checker cannot attest an unstaged generated output', (generatedAssetsRefusal('bun scripts/prove-schema.ts && git commit -F m', repo) ?? '').includes('differs from the commit candidate'))
writeFileSync(join(repo, 'gen/schema.json'), '{}\n')
writeFileSync(join(repo, 'src/settings/new.ts'), 'export type Extra = 1\n')
check('untracked generator inputs cannot satisfy a checker for the index', (generatedAssetsRefusal('bun scripts/prove-schema.ts && git commit -F m', repo) ?? '').includes('differs from the commit candidate'))
rmSync(join(repo, 'src/settings/new.ts'))
writeFileSync(join(repo, 'notes.txt'), 'unrelated\n')
check('unrelated untracked files do not invalidate a checker', generatedAssetsRefusal('bun scripts/prove-schema.ts && git commit -F m', repo) === null)
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
check('a `git -C <dir> commit` from another directory reads that repository', samePath(commitRepositoryRoot(`git -C "${repo}" commit -F m`, scratch), repo) && generatedAssetsRefusal(`git -C "${repo}" commit -F m`, scratch) !== null)
const bare = join(scratch, 'nomap')
mkdirSync(bare)
execFileSync('git', ['init', '-q'], { cwd: bare })
writeFileSync(join(bare, 'x.txt'), 'x')
execFileSync('git', ['add', 'x.txt'], { cwd: bare })
check('a repository with no map owes nothing', generatedAssetsRefusal('git commit -F m', bare) === null)
for (const command of [
  `GIT_DIR="${repo}/.git" GIT_WORK_TREE="${repo}" git commit -F m`,
  `GIT_INDEX_FILE="${repo}/.git/index" git commit -F m`,
  `export GIT_DIR="${repo}/.git"; git commit -F m`,
  `GIT_WORK_TREE="${repo}"; git commit -F m`,
]) {
  let reason = ''
  try { reason = generatedAssetsRefusal(command, bare) ?? '' } catch (error) { reason = String(error) }
  check('Git selection assignments cannot borrow another repository map', reason.includes('Git selection environment'), reason)
}
check('message-only and authorship assignments leave genuinely mapless commits alone', generatedAssetsRefusal('GIT_AUTHOR_NAME=writer MSG=msg.txt git commit -F "$MSG"', bare) === null)
for (const command of ['git commit -F "$MSG"', 'git commit -F $MSG', 'git commit -m "$(cat msg.txt)"', 'MSG=msg.txt git commit -F "$MSG"', 'GIT=git; $GIT commit -F m']) {
  try {
    check('message expansion does not activate an absent map', generatedAssetsRefusal(command, bare) === null, command)
  } catch (error) {
    check('message expansion does not activate an absent map', false, `${command}: ${error}`)
  }
}
for (const command of [`git -C "${bare}" commit -F "$MSG"`, `cd "${bare}" && git commit -m "$(cat msg.txt)"`]) {
  try { check('map discovery follows the literal target before reading message arguments', generatedAssetsRefusal(command, repo) === null, command) }
  catch (error) { check('map discovery follows the literal target before reading message arguments', false, `${command}: ${error}`) }
}
for (const command of ['git commit -F "$MSG"', 'git commit -m "$(cat msg.txt)"']) {
  let reason = ''
  try { reason = generatedAssetsRefusal(command, repo) ?? '' } catch (error) { reason = String(error) }
  check('a mapped nonliteral commit names its actual ambiguity and remedy', /variable|substitution/.test(reason) && /literal/.test(reason) && !reason.includes('once git answers'), reason)
}
check('a directory outside any repository owes nothing', generatedAssetsRefusal('git commit -F m', tmpdir()) === null)
mkdirSync(join(repo, 'docs'))
writeFileSync(join(repo, 'src/settings/types.ts'), 'export type A = 1\n')
g('add', 'src/settings/types.ts')
g('mv', 'src/settings/types.ts', 'docs/renamed.txt')
const renamedPaths = commitPathsOf(repo, 'git commit -F m')
check('a renamed source retains both candidate endpoints', renamedPaths.includes('src/settings/types.ts') && renamedPaths.includes('docs/renamed.txt'), renamedPaths.join(', '))
check('renaming out of a watched directory still owes its output', (generatedAssetsRefusal('git commit -F m', repo) ?? '').includes('gen/schema.json'))
const assetCommand = join(repo, 'scripts/gate/generated-assets.ts')
writeFileSync(assetCommand, readFileSync(join(ROOT, 'scripts/gate/generated-assets.ts'), 'utf8').replace("'../../src/permissions/guards/generatedAssets.ts'", JSON.stringify(join(ROOT, 'src/permissions/guards/generatedAssets.ts'))))
const assetListing = execFileSync(process.execPath, [assetCommand, '--staged'], { cwd: repo, env: process.env, encoding: 'utf8' })
check('the generated-asset command also sees the removed rename input', assetListing.includes('gen/schema.json') && assetListing.includes('src/settings/types.ts'), assetListing)
g('mv', 'docs/renamed.txt', 'src/settings/types.ts')
writeFileSync(join(repo, 'src/settings/types.ts'), 'export type A = 2\n')
g('add', 'src/settings/types.ts')
const mapFile = join(repo, GENERATED_ASSETS_MAP)
const committedMap = readFileSync(mapFile, 'utf8')
rmSync(mapFile)
check('an unstaged map deletion cannot discard the indexed obligations', (generatedAssetsRefusal('git commit -F m', repo) ?? '').includes('map differs from the index'))
writeFileSync(mapFile, '')
check('an unstaged empty map cannot discard the indexed obligations', (generatedAssetsRefusal('git commit -F m', repo) ?? '').includes('map differs from the index'))
writeFileSync(mapFile, committedMap.replace('src/settings/**', 'src/unrelated/**'))
check('an unstaged rule change cannot discard the indexed obligations', (generatedAssetsRefusal('git commit -F m', repo) ?? '').includes('map differs from the index'))
writeFileSync(mapFile, committedMap.replaceAll('\n', '\r\n'))
check('a checkout that spells the map with CRLF line ends (core.autocrlf) is not a map change', !(generatedAssetsRefusal('git commit -F m', repo) ?? '').includes('map differs from the index'), String(generatedAssetsRefusal('git commit -F m', repo)))
writeFileSync(mapFile, '')
g('add', GENERATED_ASSETS_MAP)
check('a path-limited commit cannot borrow an excluded staged map change', generatedAssetsRefusal('git commit --only src/settings/types.ts -F m', repo) !== null)
g('restore', '--staged', GENERATED_ASSETS_MAP)
writeFileSync(mapFile, committedMap)
writeFileSync(join(repo, 'scripts/gate/generated-assets.tsv'), 'broken row\n')
check('a map that does not parse refuses, naming the map', (generatedAssetsRefusal('git commit -F m', repo) ?? '').includes('does not parse'))

section('§4 a check the gate could not finish does not refuse the commit: git gives no answer, a file cannot be read', 'change generatedAssetsRefusal in src/permissions/guards/commitGate.ts (or parseGeneratedAssetsMap in src/permissions/guards/generatedAssets.ts) so an unanswered git or unreadable file lets the commit go on')
{
  const calm = join(scratch, 'calm')
  for (const dir of ['scripts/gate', 'lists', 'gen']) mkdirSync(join(calm, dir), { recursive: true })
  const env = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
  const c = (...a: string[]): string => execFileSync('git', a, { cwd: calm, encoding: 'utf8', env })
  c('init', '-q')
  writeFileSync(join(calm, GENERATED_ASSETS_MAP), 'gen/a.json\tbun scripts/gen-a.ts\tbun scripts/prove-a.ts\tfiles-of:lists/a.txt\ngen/b.json\tbun scripts/gen-b.ts\tbun scripts/prove-b.ts\tre:MARK_B\n')
  writeFileSync(join(calm, 'lists/a.txt'), 'src/a.ts\n')
  writeFileSync(join(calm, 'gen/a.json'), '{}\n')
  writeFileSync(join(calm, 'gen/b.json'), '{}\n')
  writeFileSync(join(calm, 'notes.txt'), 'one\n')
  c('add', '-A')
  c('commit', '-q', '-m', 'seed')
  writeFileSync(join(calm, 'notes.txt'), 'two\n')
  c('add', 'notes.txt')
  const realGit = Bun.which('git') ?? 'git'
  const fake = join(scratch, 'fake-git')
  mkdirSync(fake)
  writeFileSync(join(fake, 'git'), `#!/bin/sh\nhere="$(dirname "$0")"\nif [ -s "$here/arm" ]; then\n  case " $* " in\n    *"$(cat "$here/arm")"*) if [ -e "$here/slow" ]; then exec sleep 6; fi; kill -KILL $$ ;;\n  esac\nfi\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
  const path = process.env.PATH
  const verdict = (arm: string, slow = false): string => {
    writeFileSync(join(fake, 'arm'), arm)
    if (slow) writeFileSync(join(fake, 'slow'), '1')
    else rmSync(join(fake, 'slow'), { force: true })
    process.env.PATH = `${fake}${delimiter}${path}`
    try { return String(generatedAssetsRefusal('git commit -F m', calm)) } catch (error) { return `REFUSED: ${error instanceof Error ? error.message : String(error)}` } finally { process.env.PATH = path }
  }
  check('control: with git answering, a commit that touches no generated source owes nothing', verdict('') === 'null', verdict(''))
  const goesOn = (label: string, arm: string, slow = false): void => {
    if (WINDOWS) return notRead(label, 'the row plants a shell-script git on PATH, which Windows does not start')
    const answer = verdict(arm, slow)
    check(label, answer === 'null', answer)
  }
  goesOn('git rev-parse --show-toplevel gives no answer within the 3 s limit: the commit goes on, as on 1.0.11', 'rev-parse --show-toplevel', true)
  goesOn('git rev-parse --show-toplevel ends without an exit status: the commit goes on', 'rev-parse --show-toplevel')
  goesOn("git show HEAD:<the map> ends without an exit status: the commit goes on with the working tree's and the index's map", ` HEAD:${GENERATED_ASSETS_MAP} `)
  goesOn("git show HEAD:<a committed path> ends without an exit status: the commit goes on, the path's previous content unmatched", ' HEAD:notes.txt ')
  if (WINDOWS) notRead('a files-of: list that is there and cannot be read (EACCES): the commit goes on', 'a POSIX mode does not make a file unreadable there')
  else {
    chmodSync(join(calm, 'lists/a.txt'), 0o000)
    const unreadable = verdict('')
    chmodSync(join(calm, 'lists/a.txt'), 0o644)
    check('a files-of: list that is there and cannot be read (EACCES): the commit goes on', process.getuid?.() === 0 || unreadable === 'null', unreadable)
  }
  writeFileSync(join(calm, 'notes.txt'), 'MARK_B\n')
  c('add', 'notes.txt')
  const owed = verdict('')
  check('control: the same gate still refuses what it did read (a staged source that matches re:MARK_B owes gen/b.json)', owed.includes('gen/b.json'), owed)
  const uncompiled = parseGeneratedAssetsMap('gen/s.json\tbun scripts/gen-s.ts\tbun scripts/prove-s.ts\tsrc/** re:[oops\n')
  const named: string[] = (uncompiled as { skipped?: string[] }).skipped ?? []
  check('a re: source that does not compile is left out of its row and named; it is no map error and the row keeps its other source', uncompiled.errors.length === 0 && named.length === 1 && named[0]!.startsWith('line 1: re:[oops is not a regular expression that compiles') && JSON.stringify(uncompiled.rows[0]?.sources) === JSON.stringify(['src/**']), JSON.stringify(uncompiled))
  const skip = join(scratch, 'skip')
  for (const dir of ['scripts/gate', 'src', 'gen']) mkdirSync(join(skip, dir), { recursive: true })
  const k = (...a: string[]): string => execFileSync('git', a, { cwd: skip, encoding: 'utf8', env })
  k('init', '-q')
  writeFileSync(join(skip, GENERATED_ASSETS_MAP), 'gen/s.json\tbun scripts/gen-s.ts\tbun scripts/prove-s.ts\tsrc/** re:[oops\n')
  writeFileSync(join(skip, 'src/x.ts'), 'export const x = 1\n')
  writeFileSync(join(skip, 'gen/s.json'), '{}\n')
  writeFileSync(join(skip, 'notes.txt'), 'one\n')
  k('add', '-A')
  k('commit', '-q', '-m', 'seed')
  writeFileSync(join(skip, 'notes.txt'), 'two\n')
  k('add', 'notes.txt')
  const judged = (): string => {
    try { return String(generatedAssetsRefusal('git commit -F m', skip)) } catch (error) { return `REFUSED: ${error instanceof Error ? error.message : String(error)}` }
  }
  const unrelated = judged()
  check('a map that holds such a source no longer refuses every commit in its repository', unrelated === 'null', unrelated)
  const gate = await import('../../src/permissions/guards/commitGate.ts')
  const { judgeToolCall } = await import('../../src/permissions/guards/guards.ts')
  const { setFlagEnv, deleteFlagEnv } = await import('../../src/platform/substrate/flagRegistry.ts')
  const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
  setFlagEnv('MERCURY_COMMIT_GATE', '1')
  gate.engageCommitGate('skipped-source')
  const notesOf = async (callId: string): Promise<string[]> => {
    const answered = await runWithCwdOverride(skip, () => judgeToolCall('skipped-source', { tool: 'Bash', input: { command: 'bun run typecheck && git commit -F m' }, callId, messages: [] }))
    return answered.refused ? [`REFUSED: ${answered.reason}`] : answered.notes.map(note => String(note.content))
  }
  const first = await notesOf('skipped-1')
  const second = await notesOf('skipped-2')
  gate.disengageCommitGate('skipped-source')
  deleteFlagEnv('MERCURY_COMMIT_GATE')
  check('the commit goes on and one note says which source was skipped, the map first, and what to do', first.length === 1 && first[0]!.startsWith(`${GENERATED_ASSETS_MAP} line 1: re:[oops is not a regular expression that compiles`) && first[0]!.endsWith('so the commit was not checked against that source — fix the pattern in the map.'), JSON.stringify(first))
  check('…once: the next commit carries no note', second.length === 0, JSON.stringify(second))
  writeFileSync(join(skip, 'src/x.ts'), 'export const x = 2\n')
  k('add', 'src/x.ts')
  const stillOwed = judged()
  check("control: the row's other source still judges (a staged file under src/** owes gen/s.json)", stillOwed.includes('gen/s.json'), stillOwed)
}
rmSync(scratch, { recursive: true, force: true })


section('§5 the generators register themselves; the census names what they missed', 'change generatedFileDeclaration or unregisteredGeneratedFiles in src/permissions/guards/generatedAssets.ts, or upsertGeneratedAssetRow or registerGeneratedAsset in scripts/lib/generated-assets-map.mjs; for a real-map failure add the missing generator row to the map')
check('a "GENERATED by <script>" head declares its generator', generatedFileDeclaration('assets/x/out.sh', '#!/bin/sh\n# GENERATED by scripts/x/gen-out.ts — do not edit\n') === 'scripts/x/gen-out.ts')
check('an AUTO-GENERATED by line spelled with bun run declares it', generatedFileDeclaration('src/a.ts', '// AUTO-GENERATED by `bun run scripts/x/gen-a.ts` — DO NOT EDIT BY HAND') === 'scripts/x/gen-a.ts')
check('a generatedBy key declares it', generatedFileDeclaration('scripts/x/c.json', '{\n  "generatedBy": "scripts/x/gen-c.ts",\n  "sites": []\n}') === 'scripts/x/gen-c.ts')
check('a composedBy key declares it', generatedFileDeclaration('scripts/x/f.json', '{\n "base": "abc",\n "composedBy": "scripts/x/gen-f.ts",\n') === 'scripts/x/gen-f.ts')
check('a Regenerate: line declares it', generatedFileDeclaration('scripts/x/census.md', '# census (GENERATED)\n\n> Regenerate: `bun run scripts/x/gen-census.ts --write`.\n') === 'scripts/x/gen-census.ts')
check('a .generated. name declares itself', generatedFileDeclaration('src/x/table.generated.ts', 'export const T = 1\n') === 'its name')
check('a declaration past the head does not count', generatedFileDeclaration('docs/x.md', '\n'.repeat(GENERATED_FILE_HEAD_LINES) + 'GENERATED by scripts/x/gen.ts') === null)
check('a script naming itself is not generated', generatedFileDeclaration('scripts/x/gen-out.ts', '// gen-out — the census is generated by scripts/x/gen-out.ts') === null)
check('prose about generation with no script path is not a declaration', generatedFileDeclaration('src/x/y.ts', '// DO NOT EDIT without a review; the generated parts live elsewhere') === null)
check('a source a deploy splices (managed by) is not a generated file', generatedFileDeclaration('scripts/ops/launcher.sh', '#!/bin/bash\n# managed by scripts/x/deploy.sh — do not hand-edit\n') === null)
check('the map itself is never a generated file', generatedFileDeclaration(GENERATED_ASSETS_MAP, '# rows regenerated by scripts/x/gen.ts') === null)
const fixtureRows = parseGeneratedAssetsMap('gen/schema.json\tbun gen.ts\t-\tsrc/**\nsrc/integrations/skills/bundled/**\tbun gen-bundled.ts\t-\tskills/**\n').rows
const unregistered = unregisteredGeneratedFiles(
  [
    { path: 'gen/schema.json', head: '{"generatedBy": "scripts/x/gen.ts"}' },
    { path: 'src/integrations/skills/bundled/a.ts', head: '// AUTO-GENERATED by scripts/skills/gen-bundled.ts' },
    { path: 'assets/out.sh', head: '# GENERATED by scripts/x/gen-out.ts' },
    { path: 'src/plain.ts', head: 'export const a = 1' },
  ],
  fixtureRows,
)
check('the census names the declared file with no row and nothing else', unregistered.length === 1 && unregistered[0]!.path === 'assets/out.sh' && unregistered[0]!.declares === 'scripts/x/gen-out.ts', JSON.stringify(unregistered))
check('a glob row covers the files under it', assetRowFor('src/integrations/skills/bundled/a.ts', fixtureRows) !== null)
check('the red names the file, its generator and the register remedy', (() => {
  const text = describeUnregisteredGeneratedFiles(unregistered)
  return text.includes('assets/out.sh') && text.includes('scripts/x/gen-out.ts') && text.includes('--register')
})())
const mapHeader = '# the map\n#\n'
const seeded = `${mapHeader}a.json\tbun scripts/x/gen-a.ts\tbun scripts/x/prove-a.ts\tsrc/a/**\n`
const outRow = { assets: 'assets/out.sh', generator: 'bun scripts/x/gen-out.ts', check: null, sources: 'src/out/**' }
const added = upsertGeneratedAssetRow(seeded, outRow)
check('a new generator appends its row after the last one, the header kept', added.action === 'added' && added.text === `${seeded}assets/out.sh\tbun scripts/x/gen-out.ts\t-\tsrc/out/**\n`, added.text)
const again = upsertGeneratedAssetRow(added.text, outRow)
check('registering again is byte-identical', again.action === 'unchanged' && again.text === added.text)
const moved = upsertGeneratedAssetRow(added.text, { assets: ['assets/core.sh'], generator: 'bun scripts/x/gen-out.ts', check: 'bun scripts/x/gen-out.ts --check', sources: ['src/out/**', 'src/core.ts'] })
check('a generator whose output moved replaces its own row in place (one row per generator)', moved.action === 'updated' && moved.text === `${mapHeader}a.json\tbun scripts/x/gen-a.ts\tbun scripts/x/prove-a.ts\tsrc/a/**\nassets/core.sh\tbun scripts/x/gen-out.ts\tbun scripts/x/gen-out.ts --check\tsrc/out/** src/core.ts\n`, moved.text)
check('what the writer wrote, the parser reads back', (() => {
  const parsed = parseGeneratedAssetsMap(moved.text)
  return parsed.errors.length === 0 && parsed.rows.length === 2 && parsed.rows[1]!.assets[0] === 'assets/core.sh' && parsed.rows[1]!.check === 'bun scripts/x/gen-out.ts --check' && parsed.rows[1]!.sources.join(' ') === 'src/out/** src/core.ts'
})())
let refusedRow = ''
try {
  formatGeneratedAssetRow({ assets: '', generator: 'bun x', sources: 'a' })
} catch (error) {
  refusedRow = String(error)
}
check('a row with no asset is refused', refusedRow.includes('names no asset'))
const censusScratch = mkdtempSync(join(tmpdir(), 'generated-census-'))
mkdirSync(join(censusScratch, 'scripts', 'gate'), { recursive: true })
mkdirSync(join(censusScratch, 'assets'), { recursive: true })
writeFileSync(join(censusScratch, GENERATED_ASSETS_MAP), '# map\n')
writeFileSync(join(censusScratch, 'assets/out.sh'), '# GENERATED by scripts/x/gen-out.ts\necho hi\n')
const censusOf = () => unregisteredGeneratedFiles([{ path: 'assets/out.sh', head: readFileSync(join(censusScratch, 'assets/out.sh'), 'utf8') }], parseGeneratedAssetsMap(readFileSync(join(censusScratch, GENERATED_ASSETS_MAP), 'utf8')).rows)
check('an unregistered fixture file is red', censusOf().length === 1)
const registered = registerGeneratedAsset(outRow, { root: censusScratch })
check('the generator registering itself writes the row into the map', registered.action === 'added' && readFileSync(join(censusScratch, GENERATED_ASSETS_MAP), 'utf8') === '# map\nassets/out.sh\tbun scripts/x/gen-out.ts\t-\tsrc/out/**\n')
check('…and the census is green', censusOf().length === 0)
rmSync(censusScratch, { recursive: true, force: true })
const BINARY_EXTENSION = /\.(?:png|jpe?g|gif|webp|ico|icns|wav|mp3|mp4|mov|woff2?|ttf|otf|node|wasm|zip|gz|tgz|cast|pdf|dylib|so|dll|exe)$/i
const heads: Array<{ path: string; head: string }> = []
const headBuffer = Buffer.alloc(2048)
for (const path of execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)) {
  if (BINARY_EXTENSION.test(path)) continue
  let fd: number
  try {
    fd = openSync(join(ROOT, path), 'r')
  } catch {
    continue
  }
  let read = 0
  try {
    read = readSync(fd, headBuffer, 0, headBuffer.length, 0)
  } finally {
    closeSync(fd)
  }
  const slice = headBuffer.subarray(0, read)
  if (slice.includes(0)) continue
  heads.push({ path, head: slice.toString('utf8') })
}
const realUnregistered = unregisteredGeneratedFiles(heads, map.rows)
check('every tracked file that declares a generator has a row in the real map', realUnregistered.length === 0, realUnregistered.length > 0 ? describeUnregisteredGeneratedFiles(realUnregistered) : '')
check('the real map has one row per generator', new Set(map.rows.map(r => r.generator)).size === map.rows.length)
for (const [file, generator] of [
  ['scripts/critters/fixtures/zzz-frames.json', 'scripts/critters/gen-zzz-frames.ts'],
  ['src/integrations/vulcan-optable/optable.generated.ts', 'scripts/vulcan/regen-optable.mjs'],
  ['assets/vulcan/addon/core/op_classes.gd', 'scripts/vulcan/regen-optable.mjs'],
  ['assets/splash/splash-core.mjs', 'scripts/splash/bake-menu.mjs'],
  ['scripts/builtin-tools/fixtures/RESULTS.md', 'scripts/builtin-tools/bench-builtin-tools.ts'],
]) check(`${file} is a row of ${generator}`, (assetRowFor(file!, map.rows)?.generator ?? '').includes(generator!))

section('§6 the build asks the generator of each file it ships', 'change buildCheckedRows, staleBuildAssets or executableBit in scripts/lib/generated-assets-map.mjs; a stale file is fixed by running the generator the check names')
{
  const { buildCheckedRows, staleBuildAssets } = await import('../lib/generated-assets-map.mjs')
  const buildRows: Array<{ assets: string; generator: string; check: string }> = buildCheckedRows(mapText)
  for (const bake of ['bun scripts/splash/bake-menu.mjs', 'bun scripts/splash/bake-ramp.mjs']) {
    check(`the build checks the splash core through ${bake}`, buildRows.some(row => row.assets === 'assets/splash/splash-core.mjs' && row.generator === bake && row.check === `${bake} --check`))
  }
  for (const asset of ['src/integrations/blender/bridgeFiles.generated.ts', 'src/integrations/unity/bridgeFiles.generated.ts', 'assets/host/llamacpp-engine.json', 'src/integrations/vulcan/addonFiles.generated.ts', 'src/integrations/vulcan-optable/optable.generated.ts assets/vulcan/addon/core/op_classes.gd', 'src/integrations/extensions/bundled/content.generated.ts', 'src/integrations/skills/bundled/**', 'docs/EXTENSIONS.md mercury-skills/extension-maker/references/CONTRACT.md src/integrations/skills/bundled/extension-maker/references/CONTRACT.md']) {
    check(`the build checks ${asset}`, buildRows.some(row => row.assets === asset))
  }
  check('every row the build checks asks its own generator with --check', buildRows.every(row => row.check === `${row.generator.split('&&').at(-1)!.trim()} --check`), buildRows.filter(row => row.check !== `${row.generator.split('&&').at(-1)!.trim()} --check`).map(row => row.check).join(' | '))
  check('every row the build checks is a row the gate reads, with the same check', buildRows.every(row => map.rows.some(gateRow => gateRow.generator === row.generator && gateRow.check === row.check)))
  const carried = formatGeneratedAssetRow({ assets: 'made.txt', generator: 'bun scripts/gen-a.mjs', check: 'bun scripts/check-a.mjs', sources: 'source.txt', build: true })
  check('a generator that sets build writes the fifth column, and the gate reads the row as before', carried.endsWith('\tsource.txt\tbuild') && parseGeneratedAssetsMap(carried).rows[0]?.check === 'bun scripts/check-a.mjs' && buildCheckedRows(carried).length === 1)
  check('a table checked out with CRLF line ends still names its build rows', buildCheckedRows(`${carried}\r\n${carried.replace('gen-a', 'gen-c')}\r\n`).length === 2)
  let noCheck = ''
  try {
    formatGeneratedAssetRow({ assets: 'made.txt', generator: 'bun scripts/gen-a.mjs', sources: 'source.txt', build: true })
  } catch (error) {
    noCheck = String(error)
  }
  check('a row that asks for the build and names no check is refused', noCheck.includes('names no check'))
  const buildScratch = realpathSync(mkdtempSync(join(tmpdir(), 'generated-build-')))
  mkdirSync(join(buildScratch, 'scripts', 'gate'), { recursive: true })
  writeFileSync(join(buildScratch, 'scripts/check-a.mjs'), "import { readFileSync } from 'node:fs'\nif (readFileSync('made.txt', 'utf8') !== readFileSync('source.txt', 'utf8')) {\n  console.error('made.txt trails source.txt')\n  process.exit(1)\n}\n")
  writeFileSync(join(buildScratch, 'source.txt'), 'one\n')
  writeFileSync(join(buildScratch, 'made.txt'), 'one\n')
  check('a tree with no map has nothing for the build to check', (await staleBuildAssets(buildScratch)).length === 0)
  writeFileSync(join(buildScratch, GENERATED_ASSETS_MAP), `${carried}\nother.txt\tbun scripts/gen-b.mjs\tbun scripts/check-b.mjs\tsource.txt\ngone.txt\tbun scripts/gen-gone.mjs\tbun scripts/check-gone.mjs\tsource.txt\tbuild\n`)
  check('a current file: the build has nothing to say, a row without the column is not run, and a row whose check is not in the tree (a build of a part of it) is passed over', (await staleBuildAssets(buildScratch)).length === 0)
  writeFileSync(join(buildScratch, 'source.txt'), 'two\n')
  const staleRows: Array<{ assets: string; generator: string; output: string }> = await staleBuildAssets(buildScratch)
  check('one feeding source changed: the row is stale at once, with the command to run and the words of its check', staleRows.length === 1 && staleRows[0]!.assets === 'made.txt' && staleRows[0]!.generator === 'bun scripts/gen-a.mjs' && staleRows[0]!.output.includes('made.txt trails source.txt'), JSON.stringify(staleRows))
  writeFileSync(join(buildScratch, 'made.txt'), 'two\n')
  check('the regenerated file settles it', (await staleBuildAssets(buildScratch)).length === 0)
  rmSync(buildScratch, { recursive: true, force: true })
  const { executableBit, indexedExecutables } = await import('../lib/generated-assets-map.mjs')
  check('a payload the index holds as executable is executable, whatever its file says on disk', executableBit({ indexed: true, onDisk: false, committed: false, platform: 'win32' }) === true && executableBit({ indexed: true, onDisk: false, committed: false, platform: 'linux' }) === true)
  check('Windows keeps no such bit: with no index, or an index entry made there without it, the committed record stands', executableBit({ indexed: undefined, onDisk: false, committed: true, platform: 'win32' }) === true && executableBit({ indexed: false, onDisk: false, committed: true, platform: 'win32' }) === true && executableBit({ indexed: undefined, onDisk: false, committed: false, platform: 'win32' }) === false)
  check('where files keep the bit the index decides, and a path it does not hold is read from the file', executableBit({ indexed: false, onDisk: true, committed: true, platform: 'darwin' }) === false && executableBit({ indexed: undefined, onDisk: true, committed: false, platform: 'linux' }) === true && executableBit({ indexed: undefined, onDisk: false, committed: true, platform: 'linux' }) === false)
  const bundled = join(ROOT, 'src', 'integrations', 'extensions', 'bundled')
  const executables = [...(indexedExecutables(bundled) as Map<string, boolean>)].filter(([, executable]) => executable).map(([path]) => path)
  if (executables.length === 0) console.log('  [skip] the index holds no executable payload under the bundled extensions: their generator is not run on a copy')
  else {
    const { cpSync } = await import('node:fs')
    const { spawnSync } = await import('node:child_process')
    const bundledScratch = realpathSync(mkdtempSync(join(tmpdir(), 'generated-bundled-')))
    const copy = join(bundledScratch, 'bundled')
    cpSync(bundled, copy, { recursive: true })
    const inCopy = (...a: string[]): string => execFileSync('git', a, { cwd: copy, encoding: 'utf8', stdio: 'pipe' })
    inCopy('init', '-q')
    inCopy('add', '-A')
    inCopy('update-index', '--chmod=+x', '--', ...executables)
    for (const path of executables) chmodSync(join(copy, path), 0o644)
    const generate = (flags: string[], before: string[] = []) => spawnSync(process.execPath, [...before, join(ROOT, 'scripts', 'extensions', 'gen-bundled.ts'), '--root', copy, ...flags], { encoding: 'utf8' })
    const said = (run: { stdout: string; stderr: string }): string => `${run.stdout}${run.stderr}`.slice(-300)
    const recorded = readFileSync(join(copy, 'content.generated.ts'))
    const checked = generate(['--check'])
    check(`${executables.join(', ')}: not executable on disk and executable in the index, the bundled extensions read current`, checked.status === 0, said(checked))
    const written = generate([])
    check('…and a regeneration there writes the bytes that were committed', written.status === 0 && readFileSync(join(copy, 'content.generated.ts')).equals(recorded), said(written))
    rmSync(join(copy, '.git'), { recursive: true, force: true })
    const asWindows = join(bundledScratch, 'as-windows.mjs')
    writeFileSync(asWindows, "Object.defineProperty(process, 'platform', { value: 'win32' })\n")
    const archive = generate(['--check'], ['--preload', asWindows])
    check('with no index on Windows (a source archive) the committed record keeps the bit: the bundled extensions read current', archive.status === 0, said(archive))
    check('with no index where files keep the bit, the file is read: a payload that lost it reads stale', process.platform === 'win32' || generate(['--check']).status !== 0)
    writeFileSync(join(copy, executables[0]!), Buffer.concat([readFileSync(join(copy, executables[0]!)), Buffer.from([0, 1])]))
    check('a payload whose bytes changed reads stale on Windows too', generate(['--check'], ['--preload', asWindows]).status !== 0)
    rmSync(bundledScratch, { recursive: true, force: true })
  }
  const staleHere: Array<{ assets: string; generator: string }> = await staleBuildAssets(ROOT)
  check('every file the build checks is current on this tree', staleHere.length === 0, staleHere.map(row => `${row.assets}: run ${row.generator}`).join(' | '))
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
