#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform === 'win32') {
  console.log('prove-tree-fingerprint-budget: the shim legs need a posix shell — skipped on win32')
  process.exit(0)
}

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'tree-budget-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME)
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_TREE_SCAN_CEILING
delete process.env.MERCURY_TREE_SCAN_TIMEOUT_MS
delete process.env.GIT_SHIM_SLEEP_MS
delete process.env.GIT_SHIM_SLEEP_FOR
process.env.GIT_CONFIG_GLOBAL = join(SCRATCH, 'gitconfig')
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
process.env.GIT_CONFIG_SYSTEM = '/dev/null'
process.env.XDG_CONFIG_HOME = join(SCRATCH, 'xdg')

const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
const SHIM_DIR = join(SCRATCH, 'shim')
mkdirSync(SHIM_DIR)
const LOG = join(SCRATCH, 'git.log')
writeFileSync(LOG, '')
writeFileSync(
  join(SHIM_DIR, 'git'),
  [
    '#!/bin/bash',
    'if [ -n "$GIT_SHIM_SLEEP_MS" ] && { [ -z "$GIT_SHIM_SLEEP_FOR" ] || [ "$1" = "$GIT_SHIM_SLEEP_FOR" ]; }; then sleep "$(awk "BEGIN{print $GIT_SHIM_SLEEP_MS/1000}")"; fi',
    `printf '%s\\t%s\\n' "$PWD" "$*" >> "${LOG}"`,
    `exec "${REAL_GIT}" "$@"`,
    '',
  ].join('\n'),
)
chmodSync(join(SHIM_DIR, 'git'), 0o755)
process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ''}`

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ['-C', cwd, '-c', 'user.email=prover@example.invalid', '-c', 'user.name=prover', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function makeRepo(dir: string, files: number): void {
  mkdirSync(dir, { recursive: true })
  const dirs = Math.max(1, Math.min(50, Math.floor(files / 100)))
  let n = 0
  for (let d = 0; d < dirs; d++) {
    const dd = join(dir, 'src', `mod${String(d).padStart(2, '0')}`)
    mkdirSync(dd, { recursive: true })
    for (let f = 0; f < Math.ceil(files / dirs) && n < files; f++, n++) {
      writeFileSync(join(dd, `file${String(f).padStart(3, '0')}.ts`), `// module ${d} file ${f}\nexport const v${f} = ${(d * 7919 + f * 104729) % 1000003}\n`.repeat(4))
    }
  }
  const nested = join(dir, 'nested', 'plain')
  mkdirSync(nested, { recursive: true })
  for (let i = 0; i < 5; i++) writeFileSync(join(nested, `note${i}.txt`), `note ${i}\n`)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'seed')
}
function countObjects(dir: string): { count: number; size: number } {
  const out = git(dir, 'count-objects', '-v')
  const num = (k: string): number => Number(new RegExp(`^${k}: (\\d+)$`, 'm').exec(out)?.[1] ?? NaN)
  return { count: num('count'), size: num('size') }
}
type Row = { cwd: string; argv: string }
function rows(): Row[] {
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [cwd = '', ...argv] = l.split('\t')
      return { cwd, argv: argv.join('\t') }
    })
}
const mark = (): number => rows().length
const since = (n: number): Row[] => rows().slice(n)
const isAdd = (r: Row): boolean => r.argv.startsWith('add -A')
const EXCLUDE_ADD = 'add -A -- . :(exclude,glob)**/.claude/** :(exclude,glob)**/.mercury/**'

const vs = await import('../../src/utils/verification/verificationState.ts')
vs._resetVerificationStateForTesting()

const repo = join(SCRATCH, 'repo')
makeRepo(repo, 5000)
const FILES = 5000 + 5 + 1
const repoIndex = join(repo, '.git', 'index')

section('§1 the index persists — the second digest is a stat walk')
const repoIndexBefore = statSync(repoIndex).mtimeMs
const t0 = performance.now()
const first = await vs.computeWorkingTreeDigestAsync(repo, { fresh: true })
const firstMs = performance.now() - t0
check('the first digest answers (the seed scan)', first !== null)
const storeDirs = existsSync(join(HOME, 'verify')) ? readdirSync(join(HOME, 'verify')) : []
const store = storeDirs.length === 1 ? join(HOME, 'verify', storeDirs[0]!) : ''
check("Mercury's index lives under its config home, beside the evidence file", store !== '' && existsSync(join(store, 'index')), storeDirs.join(','))
let secondMs = Number.POSITIVE_INFINITY
let second: string | null = null
for (let i = 0; i < 3; i++) {
  const t = performance.now()
  second = await vs.computeWorkingTreeDigestAsync(repo, { fresh: true })
  secondMs = Math.min(secondMs, performance.now() - t)
}
check(`a digest on the unchanged tree costs ≤ 10% of the first (${Math.round(firstMs)} ms → ${Math.round(secondMs)} ms)`, secondMs <= firstMs / 10, `${Math.round((secondMs / firstMs) * 100)}%`)
check('…and names the same tree', second === first)
check("the repository's own index is never touched", statSync(repoIndex).mtimeMs === repoIndexBefore)

section('§2 the repository gains nothing — 20 digests over a changing untracked file')
{
  const scratchFile = join(repo, 'scratch.txt')
  const before = countObjects(repo)
  const seen = new Set<string | null>()
  for (let i = 0; i < 20; i++) {
    writeFileSync(scratchFile, `version ${i}\n`.repeat(50))
    vs.markMutation(undefined, [scratchFile], repo)
    seen.add(await vs.computeWorkingTreeDigestAsync(repo))
  }
  const after = countObjects(repo)
  check(`the repository's object count is unchanged (${before.count} → ${after.count})`, before.count === after.count && before.size === after.size)
  check('…while the digest changed every time (20 distinct trees)', seen.size === 20 && !seen.has(null))
  check('…and the Mercury-owned store is swept after each tree', !existsSync(join(store, 'objects')) || readdirSync(join(store, 'objects')).length === 0)
}

section('§3 exclude before the cost — harness churn never moves the digest, never hashes')
{
  const harness = join(repo, '.mercury')
  mkdirSync(harness, { recursive: true })
  const churn = join(harness, 'churn.bin')
  const base = await vs.computeWorkingTreeDigestAsync(repo, { fresh: true })
  writeFileSync(churn, Buffer.alloc(8 << 20, 1))
  vs.markMutation(undefined, [churn], repo)
  let n0 = mark()
  const d1 = await vs.computeWorkingTreeDigestAsync(repo)
  let r = since(n0)
  check('an unignored churning file under .mercury never moves the digest', d1 === base, `${base} vs ${d1}`)
  check('…the add ran the exclude road (no reset)', r.some(x => x.argv === EXCLUDE_ADD) && !r.some(x => x.argv.startsWith('reset ')), r.map(x => x.argv).join(' | '))
  const blob = git(repo, 'hash-object', churn).trim()
  check('…and the file was never hashed into the repository', spawnSync(REAL_GIT, ['-C', repo, 'cat-file', '-e', blob]).status !== 0)
  writeFileSync(join(repo, '.gitignore'), '.mercury/\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'ignore the harness dir')
  vs.markMutation(undefined, [join(repo, '.gitignore')], repo)
  const base2 = await vs.computeWorkingTreeDigestAsync(repo, { fresh: true })
  writeFileSync(churn, Buffer.alloc(8 << 20, 2))
  vs.markMutation(undefined, [churn], repo)
  n0 = mark()
  const d2 = await vs.computeWorkingTreeDigestAsync(repo)
  r = since(n0)
  check('the ignored-and-present harness dir (the exclude-pathspec trap) still rides the exclude road', d2 === base2 && r.some(x => x.argv === EXCLUDE_ADD) && !r.some(x => x.argv.startsWith('reset ')), r.map(x => x.argv).join(' | '))
  mkdirSync(join(repo, '.claude'), { recursive: true })
  const settings = join(repo, '.claude', 'settings.json')
  writeFileSync(settings, '{}\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'track a harness file')
  vs.markMutation(undefined, [settings], repo)
  const base3 = await vs.computeWorkingTreeDigestAsync(repo, { fresh: true })
  writeFileSync(settings, '{"edited":true}\n')
  vs.markMutation(undefined, [settings], repo)
  const d3 = await vs.computeWorkingTreeDigestAsync(repo)
  check("a tracked harness file's edit never moves the digest", d3 === base3)
  const real = join(repo, 'src', 'mod00', 'file000.ts')
  writeFileSync(real, 'export const changed = 1\n')
  vs.markMutation(undefined, [real], repo)
  const d4 = await vs.computeWorkingTreeDigestAsync(repo)
  check('…while a real edit does', d4 !== null && d4 !== base3)
}

section('§4 event-driven, one in flight — readers on timers reuse the last value')
{
  vs.markMutation(undefined, undefined, repo)
  let n0 = mark()
  const [a, b] = await Promise.all([vs.computeWorkingTreeDigestAsync(repo), vs.computeWorkingTreeDigestAsync(repo)])
  check('two concurrent callers produce ONE git run', a === b && since(n0).filter(isAdd).length === 1, `${since(n0).filter(isAdd).length} adds`)
  n0 = mark()
  await vs.computeWorkingTreeDigestAsync(repo)
  await vs.computeWorkingTreeDigestAsync(repo)
  check('a reader with no mutation since the last digest spawns nothing', since(n0).length === 0, since(n0).map(x => x.argv).join(' | '))
  const f = join(repo, 'src', 'mod01', 'file001.ts')
  n0 = mark()
  for (let i = 0; i < 10; i++) {
    writeFileSync(f, `export const burst = ${i}\n`)
    vs.markMutation(undefined, [f], repo)
  }
  await vs.computeWorkingTreeDigestAsync(repo)
  check('ten mutations in a burst then one read: ONE scan', since(n0).filter(isAdd).length === 1, `${since(n0).filter(isAdd).length} adds`)
  n0 = mark()
  for (let i = 0; i < 10; i++) {
    writeFileSync(f, `export const each = ${i}\n`)
    vs.markMutation(undefined, [f], repo)
    await vs.computeWorkingTreeDigestAsync(repo)
  }
  const adds = since(n0).filter(isAdd).length
  check(`ten mutations each followed by a read: at most ten scans (${adds})`, adds >= 1 && adds <= 10)
  n0 = mark()
  vs.markTreeSuspectAfterTurn()
  await vs.computeWorkingTreeDigestAsync(repo)
  await vs.computeWorkingTreeDigestAsync(repo)
  check('a turn end makes the cached digest suspect exactly once', since(n0).filter(isAdd).length === 1)
  const HOT = [
    'src/services/workbench/projection.ts',
    'src/services/workbench/currentWork.ts',
    'src/services/mission/projection.ts',
    'src/state/telemetryBus.ts',
    'src/services/concourse/coordinatorBoard.ts',
    'src/components/HelmLanesRail.tsx',
    'src/components/concourse/ConcourseRoute.tsx',
  ]
  for (const file of HOT) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8')
    check(`${file} names only the async twin (no sync digest, no sync snapshot)`, !/\bcomputeWorkingTreeDigest\b(?!Async)/.test(src) && !/\bgetProjectSnapshot\(/.test(src))
  }
  const rt = readFileSync(join(REPO_ROOT, 'src/services/run/runTurnObserver.ts'), 'utf8')
  check('the turn boundary is the fingerprint clock (runTurnObserver marks the tree suspect)', rt.includes('markTreeSuspectAfterTurn()'))
}

section('§5 bounded to the launch folder — a nested launch never looks above itself')
{
  const nested = join(repo, 'nested', 'plain')
  const rootDigest = await vs.computeWorkingTreeDigestAsync(repo, { fresh: true })
  const n0 = mark()
  const nd = await vs.computeWorkingTreeDigestAsync(nested, { fresh: true })
  const r = since(n0)
  check('a nested launch folder has its own digest', nd !== null && nd !== rootDigest)
  check('every add ran from the launch folder with pathspec `.`', r.filter(isAdd).length >= 1 && r.filter(isAdd).every(x => x.cwd === nested && x.argv === EXCLUDE_ADD), r.filter(isAdd).map(x => `${x.cwd} ${x.argv}`).join(' | '))
  check('…and the tree was written for the launch folder alone', r.some(x => x.argv === 'write-tree --missing-ok --prefix=nested/plain/'), r.map(x => x.argv).join(' | '))
  const outside = join(repo, 'src', 'mod02', 'file002.ts')
  writeFileSync(outside, 'export const outside = 1\n')
  vs.markMutation(undefined, [outside], nested)
  const nd2 = await vs.computeWorkingTreeDigestAsync(nested)
  check('a file outside the launch folder never moves its digest', nd2 === nd)
  const inside = join(nested, 'note0.txt')
  writeFileSync(inside, 'inside edit\n')
  vs.markMutation(undefined, [inside], nested)
  const nd3 = await vs.computeWorkingTreeDigestAsync(nested)
  check('…while a file inside does', nd3 !== null && nd3 !== nd)
  const nestedHarness = join(nested, '.mercury')
  mkdirSync(nestedHarness, { recursive: true })
  const nestedChurn = join(nestedHarness, 'churn.bin')
  writeFileSync(nestedChurn, Buffer.alloc(4 << 20, 3))
  vs.markMutation(undefined, [nestedChurn], nested)
  const n1 = mark()
  const nd4 = await vs.computeWorkingTreeDigestAsync(nested)
  check("a churning file under the nested launch folder's own .mercury never moves its digest", nd4 === nd3, `${nd3} vs ${nd4}`)
  check('…and rode the exclude road there too (no reset)', !since(n1).some(x => x.cwd === nested && x.argv.startsWith('reset ')))
  const nestedBlob = git(repo, 'hash-object', nestedChurn).trim()
  check('…and was never hashed into the repository', spawnSync(REAL_GIT, ['-C', repo, 'cat-file', '-e', nestedBlob]).status !== 0)
}

section('§6 a budget that speaks — a timeout and a ceiling read unmeasured, once')
{
  const slow = join(SCRATCH, 'slow')
  makeRepo(slow, 40)
  process.env.MERCURY_TREE_SCAN_TIMEOUT_MS = '120'
  process.env.GIT_SHIM_SLEEP_MS = '600'
  process.env.GIT_SHIM_SLEEP_FOR = 'add'
  let notices = 0
  const unsub = vs.subscribeVerification(() => notices++)
  const td = await vs.computeWorkingTreeDigestAsync(slow, { fresh: true })
  check('a forced timeout answers null (unmeasured, never a stale tree)', td === null)
  const st = vs.treeScanStatus(slow)
  check('…the status reads unmeasured — timeout', st.state === 'unmeasured' && st.reason === 'timeout', JSON.stringify(st))
  check('…the note names the timeout, the count and the step', /^tree unmeasured — the scan timed out after [\d.]+ s over \d+ files \(git add\)$/.test(vs.treeScanNote(slow) ?? ''), vs.treeScanNote(slow) ?? 'null')
  check('…and the summary line carries it for the doctor', /tree unmeasured/.test(vs.verificationSummary(slow, { skipDigest: true }).detail))
  check('…ONE notice surfaced', notices === 1, String(notices))
  const n0 = mark()
  const idle = await vs.computeWorkingTreeDigestAsync(slow)
  check('a reader on a timer reuses the last value inside the budget window (no scan)', idle === null && !since(n0).some(x => x.cwd === slow && isAdd(x)))
  await vs.computeWorkingTreeDigestAsync(slow, { fresh: true })
  check('a second fault stays silent (still one notice)', notices === 1, String(notices))
  unsub()
  delete process.env.MERCURY_TREE_SCAN_TIMEOUT_MS
  delete process.env.GIT_SHIM_SLEEP_MS
  delete process.env.GIT_SHIM_SLEEP_FOR

  const big = join(SCRATCH, 'big')
  makeRepo(big, 300)
  process.env.MERCURY_TREE_SCAN_CEILING = '100'
  const n1 = mark()
  const cd = await vs.computeWorkingTreeDigestAsync(big, { fresh: true })
  check('a tree above the ceiling is never scanned', cd === null && !since(n1).some(x => x.cwd === big && isAdd(x)), since(n1).filter(x => x.cwd === big).map(x => x.argv).join(' | '))
  const cs = vs.treeScanStatus(big)
  check('…and reads unmeasured with its count', cs.state === 'unmeasured' && cs.reason === 'ceiling' && cs.fileCount >= 101, JSON.stringify(cs))
  check('…the summary line names the ceiling', /above the 100-file scan ceiling/.test(vs.verificationSummary(big, { skipDigest: true }).detail), vs.verificationSummary(big, { skipDigest: true }).detail)
  const sd = vs.computeWorkingTreeDigest(big, { fresh: true })
  check('the sync form refuses the same tree', sd === null && !since(n1).some(x => x.cwd === big && isAdd(x)))
  delete process.env.MERCURY_TREE_SCAN_CEILING
}

section('§7 the same tree, both forms — and the certificate sha byte-identical')
{
  const A = join(SCRATCH, 'eqA')
  const B = join(SCRATCH, 'eqB')
  makeRepo(A, 200)
  writeFileSync(join(A, 'scratch.txt'), 'untracked\n')
  cpSync(A, B, { recursive: true })
  const sA = vs.computeWorkingTreeDigest(A, { fresh: true })
  const aB = await vs.computeWorkingTreeDigestAsync(B, { fresh: true })
  check('sync ≡ async over identical trees', sA !== null && sA === aB, `${sA} vs ${aB}`)
  const idx = mkdtempSync(join(tmpdir(), 'cert-expect-'))
  const env = { ...process.env, PATH: process.env.PATH?.replace(`${SHIM_DIR}:`, ''), GIT_INDEX_FILE: join(idx, 'index') }
  const run = (args: string[]): string => execFileSync(REAL_GIT, args, { cwd: A, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  run(['read-tree', 'HEAD'])
  run(['add', '-A'])
  const expected = run(['write-tree']).trim()
  rmSync(idx, { recursive: true, force: true })
  const before = countObjects(A)
  const { computeWorkingTreeSha } = await import('../../src/utils/healthReport.ts')
  const got = await computeWorkingTreeSha(A)
  const after = countObjects(A)
  check('the health certificate names the same tree with its objects redirected', got === expected, `${got} vs ${expected}`)
  check("…and the repository gained nothing from it (the untracked file's blob went beside the temp index)", after.count === before.count, `${before.count} → ${after.count}`)
  check('the certificate still includes the harness dirs (its semantics are untouched)', !readFileSync(join(REPO_ROOT, 'src/utils/healthReport.ts'), 'utf8').includes('exclude).mercury'))
}

section('§8 no job outlives its repository — a mid-scan removal quiesces, a cancel awaits')
{
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  const gone = join(SCRATCH, 'gone')
  makeRepo(gone, 120)
  process.env.GIT_SHIM_SLEEP_MS = '1500'
  process.env.GIT_SHIM_SLEEP_FOR = 'add'
  const n0 = mark()
  const pending = vs.computeWorkingTreeDigestAsync(gone, { fresh: true })
  await sleep(450)
  check('a scan is in flight (its add is running)', vs._treeScanChildrenForTesting(gone) === 1, String(vs._treeScanChildrenForTesting(gone)))
  rmSync(join(gone, '.git'), { recursive: true, force: true })
  const d = await pending
  check('the digest answers null once the repository is gone — and it is not a fault', d === null && vs.treeScanStatus(gone).state === 'unknown', JSON.stringify(vs.treeScanStatus(gone)))
  check('no Mercury git job survives the repository', vs._treeScanChildrenForTesting(gone) === 0)
  check('the running add was killed mid-step and no tree was written', !since(n0).some(x => x.cwd === gone && (isAdd(x) || x.argv.startsWith('write-tree'))), since(n0).filter(x => x.cwd === gone).map(x => x.argv).join(' | '))
  check('.git is not recreated', !existsSync(join(gone, '.git')))
  const n1 = mark()
  const again = await vs.computeWorkingTreeDigestAsync(gone)
  check('the next reader re-resolves: not a repository, no job', again === null && !since(n1).some(x => x.cwd === gone && isAdd(x)))

  const stays = join(SCRATCH, 'stays')
  makeRepo(stays, 120)
  const p2 = vs.computeWorkingTreeDigestAsync(stays, { fresh: true })
  await sleep(450)
  check('a second scan is in flight', vs._treeScanChildrenForTesting(stays) === 1)
  await vs.invalidateTreeScans(stays)
  check('invalidateTreeScans cancels and awaits the running job', vs._treeScanChildrenForTesting(stays) === 0 && (await p2) === null)
  check('…drops the record and the cache (no fault, no notice)', vs.treeScanStatus(stays).state === 'unknown')
  delete process.env.GIT_SHIM_SLEEP_MS
  delete process.env.GIT_SHIM_SLEEP_FOR
  const n2 = mark()
  const d2 = await vs.computeWorkingTreeDigestAsync(stays, { fresh: true })
  check('a later demand re-resolves the repository and scans it afresh', d2 !== null && since(n2).some(x => x.cwd === stays && isAdd(x)))
  check('…and the repository is intact (invalidation is not deletion)', existsSync(join(stays, '.git')))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures === 0) {
  console.log(' ✅ ALL TREE-FINGERPRINT BUDGET CHECKS PASS')
  process.exit(0)
} else {
  console.log(` ❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
