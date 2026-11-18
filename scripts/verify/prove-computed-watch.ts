#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadImpactManifest, selectImpact } from './impactManifest.ts'
import { computedWatch } from './watchGraph.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const STORE = '.mercury/gate/computed-watch.json'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

section("§1 the tree: every file a suite's proofs touch wakes the suite, and no file loses a claimant")
{
  const computed = computedWatch(ROOT)
  const files = [...new Set(Object.values(computed).flat())].sort()
  const byHand = selectImpact(loadImpactManifest(ROOT), files).perPath
  const byBoth = selectImpact(loadImpactManifest(ROOT, computed), files).perPath
  let pairs = 0
  let unclaimed = 0
  const missed: string[] = []
  for (const [suite, touched] of Object.entries(computed)) {
    for (const file of touched) {
      pairs++
      if (!(byHand[file] ?? []).includes(suite)) unclaimed++
      if (!(byBoth[file] ?? []).includes(suite)) missed.push(`${suite} ${file}`)
    }
  }
  const lost = files.flatMap(file => (byHand[file] ?? []).filter(suite => !suite.startsWith('(') && !(byBoth[file] ?? []).includes(suite)).map(suite => `${suite} ${file}`))
  console.log(`  ${Object.keys(computed).length} suites · ${pairs} suite-and-file pairs a suite's proofs touch, over ${files.length} files · ${unclaimed} of them no header claims`)
  check('with the computed list in the manifest every one of those pairs is claimed', missed.length === 0, `${missed.length} are not: ${missed.slice(0, 8).join(' · ')} — the planner reads the list through selectImpact in scripts/verify/impactManifest.ts`)
  check('no file loses a suite the hand map gave it', lost.length === 0, `${lost.length} lost: ${lost.slice(0, 8).join(' · ')}`)
  check('the list is kept for this tree: a second read gives the same lists', JSON.stringify(computedWatch(ROOT)) === JSON.stringify(computed))
}

const seeded = (ignored: boolean): string => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'computed-watch-repo-')))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), body)
  }
  w('src/a.ts', 'export const a = 1\n')
  w('src/b.ts', 'export const b = 2\n')
  w('src/c.ts', 'export const c = 3\n')
  w('scripts/one/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pure\nfor f in "$(dirname "$0")"/prove-*.ts; do bun run "$f"; done\n')
  w('scripts/one/prove-one.ts', "import { a } from '../../src/a.ts'\nconsole.log(a)\n")
  w('scripts/two/run-all.sh', '#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/c.ts\nbun run "$(dirname "$0")/prove-two.ts"\n')
  w('scripts/two/prove-two.ts', 'console.log(2)\n')
  if (ignored) w('.gitignore', '.mercury/\n')
  return repo
}
const gitIn =
  (repo: string) =>
  (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' } })

section('§2 the store: kept under the digest of the work tree, read again while the tree stands, computed again when it moves')
{
  const repo = seeded(true)
  const g = gitIn(repo)
  g('init', '-q')
  g('add', '-A')
  g('commit', '-q', '-m', 'seed')
  const store = join(repo, STORE)
  const first = computedWatch(repo)
  check('the first read computes the lists and keeps them in the ignored project store', first.one?.join(' ') === 'scripts/one/prove-one.ts src/a.ts' && existsSync(store), `${JSON.stringify(first)} · store ${existsSync(store)}`)
  const kept = existsSync(store) ? (JSON.parse(readFileSync(store, 'utf8')) as { tree: string }) : { tree: '' }
  writeFileSync(store, JSON.stringify({ tree: kept.tree, watch: { one: ['kept'] } }))
  check('while the tree stands the lists come from the store', computedWatch(repo).one?.join() === 'kept')
  writeFileSync(join(repo, 'scripts/one/prove-one.ts'), "import { b } from '../../src/b.ts'\nconsole.log(b)\n")
  const edited = computedWatch(repo)
  const after = JSON.parse(readFileSync(store, 'utf8')) as { tree: string }
  check('a changed file gives another digest and the lists are computed again', edited.one?.join(' ') === 'scripts/one/prove-one.ts src/b.ts' && after.tree !== kept.tree, `${JSON.stringify(edited.one)} · ${after.tree === kept.tree ? 'the same digest' : 'another digest'}`)
  g('add', '-A')
  check('staging the change moves nothing', computedWatch(repo).one?.join(' ') === 'scripts/one/prove-one.ts src/b.ts')
  writeFileSync(join(repo, 'scripts/one/prove-new.ts'), "import { c } from '../../src/c.ts'\nconsole.log(c)\n")
  check('a proof git does not track yet is read', computedWatch(repo).one?.join(' ') === 'scripts/one/prove-new.ts scripts/one/prove-one.ts src/b.ts src/c.ts', JSON.stringify(computedWatch(repo).one))
  check('the store is no changed path of the repository', !g('status', '--porcelain').includes('.mercury'), g('status', '--porcelain'))

  const bun = process.execPath
  const impact = (path: string): { suite: string; reason: string }[] => {
    const ran = spawnSync(bun, [join(ROOT, 'scripts/verify/impact.ts'), '--paths', path, '--json'], { cwd: repo, env: { ...process.env, MERCURY_SLICE_ROOT: repo }, encoding: 'utf8' })
    return ran.status === 0 ? (JSON.parse(ran.stdout) as { suites: { suite: string; reason: string }[] }).suites : []
  }
  const reasons = (path: string): string => impact(path).map(row => `${row.suite} ${row.reason}`).join(' · ')
  check('the planner says which map woke a suite: computed for a file its proof touches, gate-watch for a header line', reasons('src/b.ts') === 'one computed' && reasons('src/c.ts') === 'one computed · two gate-watch' && reasons('src/a.ts') === '', `${reasons('src/b.ts')} | ${reasons('src/c.ts')} | ${reasons('src/a.ts')}`)
  rmSync(repo, { recursive: true, force: true })

  const bare = seeded(false)
  const gb = gitIn(bare)
  gb('init', '-q')
  gb('add', '-A')
  gb('commit', '-q', '-m', 'seed')
  const unkept = computedWatch(bare)
  check('where git does not ignore the store nothing is kept, so the store never shows as a changed path', unkept.one?.join(' ') === 'scripts/one/prove-one.ts src/a.ts' && !existsSync(join(bare, '.mercury')) && gb('status', '--porcelain') === '', gb('status', '--porcelain'))
  rmSync(bare, { recursive: true, force: true })
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
