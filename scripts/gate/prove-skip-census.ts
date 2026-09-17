#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CENSUS = join(ROOT, 'scripts', 'gate', 'skip-census.py')
const PYTHON = '/usr/bin/python3'
const { FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}
const work = mkdtempSync(join(tmpdir(), 'skip-census-'))
const cleanup = (): void => rmSync(work, { recursive: true, force: true })
const row = (dom: string, cls: string, rc: number, secs: number, retryRc: string, retrySecs: string): string =>
  `${dom}\t${cls}\t${rc}\t${secs}\t${retryRc}\t${retrySecs}\n`
const census = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(PYTHON, [CENSUS, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 })
const readRows = (path: string): string[][] =>
  readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'))

console.log('============================================================')
console.log(' skip census — a count of [SKIP] lines per suite, never a verdict')
console.log('============================================================')

section('§1 shard mode — one row per results row, from the attempt that decided the row')
const out = join(work, 'out')
mkdirSync(join(out, 'retry'), { recursive: true })
writeFileSync(
  join(out, 'results.tsv'),
  row('alpha', 'pure', 0, 10, '-', '-') + row('beta', 'cpu', 0, 20, '-', '-') + row('gamma', 'pty', 1, 30, '0', '25') + row('delta', 'pure', 0, 5, '-', '-') + row('epsilon', 'cpu', 1, 7, '-', '-'),
)
const longTail = 'x'.repeat(300)
writeFileSync(join(out, 'alpha.out'), `PASS a\n  \x1b[33m[SKIP]\x1b[0m alpha\tdist pins skipped (first) ${longTail}\nPASS b\n  [SKIP] alpha second\n`)
writeFileSync(join(out, 'beta.out'), 'PASS only\nno skip here\n')
writeFileSync(join(out, 'gamma.out'), 'FAIL first attempt\n  [SKIP] gamma attempt one\n')
writeFileSync(join(out, 'retry', 'gamma.out'), 'PASS on the retry\n  [SKIP] gamma retry road\n')
writeFileSync(join(out, 'epsilon.out'), 'FAIL red\n  [SKIP] epsilon red suite still counted\n')
const shard = census([out])
check('shard mode exits 0 over an out-dir with skips and a red row', shard.status === 0, `rc ${shard.status} ${shard.stderr}`)
const skipsPath = join(out, 'skips.tsv')
check('skips.tsv is written beside results.tsv', existsSync(skipsPath))
const rows = existsSync(skipsPath) ? readRows(skipsPath) : []
check('one row per results row, in results order, three columns each', rows.map(r => r[0]).join(' ') === 'alpha beta gamma delta epsilon' && rows.every(r => r.length === 3), JSON.stringify(rows))
const alpha = rows.find(r => r[0] === 'alpha') ?? []
check('alpha: two [SKIP] lines counted', alpha[1] === '2', JSON.stringify(alpha))
check('alpha: the first skip line kept, colour stripped, tabs flattened, cut at 240 chars', (alpha[2] ?? '').startsWith('[SKIP] alpha dist pins skipped (first) xxx') && (alpha[2] ?? '').length === 240 && !/\x1b|\t/.test(alpha[2] ?? ''), JSON.stringify(alpha[2]))
check('beta: no skip → count 0 and a dash', JSON.stringify(rows.find(r => r[0] === 'beta')) === JSON.stringify(['beta', '0', '-']))
check("gamma: a retried row counts the retry's output (the attempt that decided the row)", JSON.stringify(rows.find(r => r[0] === 'gamma')) === JSON.stringify(['gamma', '1', '[SKIP] gamma retry road']), JSON.stringify(rows.find(r => r[0] === 'gamma')))
check('delta: a suite without an output file is not counted (a dash and the reason), never a zero', JSON.stringify(rows.find(r => r[0] === 'delta')) === JSON.stringify(['delta', '-', 'no output file']))
check("epsilon: a red suite's skips count like a green suite's", JSON.stringify(rows.find(r => r[0] === 'epsilon')) === JSON.stringify(['epsilon', '1', '[SKIP] epsilon red suite still counted']))
check('the shard log names the counts and every suite with skips', shard.stdout.includes('skip census: 3 of 5 suites carried [SKIP] lines, 1 not counted') && /^ {2}alpha\s+2\s+\[SKIP\] alpha/m.test(shard.stdout) && /^ {2}gamma\s+1\s+\[SKIP\] gamma retry road/m.test(shard.stdout) && /^ {2}delta\s+-\s+no output file/m.test(shard.stdout), shard.stdout)

section('§2 aggregate mode — the downloaded shards as one census, printed and appended to the step summary')
const results = join(work, 'results')
for (const s of ['s0', 's1', 's2']) mkdirSync(join(results, s), { recursive: true })
writeFileSync(join(results, 's0', 'results.tsv'), row('alpha', 'pure', 0, 10, '-', '-') + row('beta', 'cpu', 0, 20, '-', '-'))
writeFileSync(join(results, 's0', 'skips.tsv'), 'alpha\t2\t[SKIP] alpha a|b\nbeta\t0\t-\n')
writeFileSync(join(results, 's1', 'results.tsv'), row('gamma', 'pty', 0, 30, '-', '-') + row('delta', 'pure', 0, 5, '-', '-'))
writeFileSync(join(results, 's1', 'skips.tsv'), 'gamma\t3\t[SKIP] gamma g\ndelta\t-\tno output file\n')
writeFileSync(join(results, 's2', 'results.tsv'), row('zeta', 'pure', 0, 3, '-', '-'))
const summaryPath = join(work, 'summary.md')
const agg = census(['--aggregate', results], { GITHUB_STEP_SUMMARY: summaryPath })
check('aggregate mode exits 0', agg.status === 0, `rc ${agg.status} ${agg.stderr}`)
check('the heading names it a count, never a verdict', agg.stdout.includes('## Skip census (a count, never a verdict)'))
check('the counts line: suites with skips, counted, none, not counted', agg.stdout.includes('- suites with `[SKIP]` lines: **2** of 4 counted; 1 carried none; 1 not counted'), agg.stdout)
check('the rows sort by count then name, and a pipe inside a skip line is escaped', agg.stdout.indexOf('| gamma | 3 | [SKIP] gamma g |') > 0 && agg.stdout.indexOf('| alpha | 2 | [SKIP] alpha a\\|b |') > agg.stdout.indexOf('| gamma | 3 |'), agg.stdout)
check('suites a shard reported without a census are named', agg.stdout.includes('- no census from: zeta'))
check('the not-counted suites carry their reason', agg.stdout.includes('- not counted: delta (no output file)'))
const summary = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : ''
check('GITHUB_STEP_SUMMARY receives the same census', summary.includes('## Skip census (a count, never a verdict)') && summary.includes('| gamma | 3 | [SKIP] gamma g |'))
const quiet = join(work, 'quiet')
mkdirSync(join(quiet, 's0'), { recursive: true })
writeFileSync(join(quiet, 's0', 'results.tsv'), row('alpha', 'pure', 0, 10, '-', '-'))
writeFileSync(join(quiet, 's0', 'skips.tsv'), 'alpha\t0\t-\n')
const none = census(['--aggregate', quiet])
check('a census with no skips says so and prints no table', none.status === 0 && none.stdout.includes('- no counted suite carried a `[SKIP]` line') && !none.stdout.includes('| suite |'), none.stdout)

section('§3 usage — a missing results.tsv or a missing argument is refused with the reason, exit 2')
const bare = mkdtempSync(join(work, 'bare-'))
const noResults = census([bare])
check('shard mode without results.tsv exits 2 and names the folder', noResults.status === 2 && noResults.stderr.includes('no results.tsv under'), `rc ${noResults.status} ${noResults.stderr}`)
const noArgs = census([])
check('no argument exits 2 with the usage line', noArgs.status === 2 && noArgs.stderr.includes('usage: skip-census.py'), `rc ${noArgs.status}`)

section('§4 the shard runs the census — a synthetic estate through scripts/gate/ci-shard.sh')
const suites = join(work, 'suites')
mkdirSync(join(suites, 'census'), { recursive: true })
writeFileSync(join(suites, 'census', 'run-all.sh'), '#!/usr/bin/env bash\n# gate-class: pure\necho "PASS one"\necho "  [SKIP] first road not on this box"\necho "  [SKIP] second road not on this box"\nexit 0\n')
chmodSync(join(suites, 'census', 'run-all.sh'), 0o755)
writeFileSync(join(work, 'seed.tsv'), 'census\t5\n')
writeFileSync(join(work, 'ceilings.tsv'), '')
const shardOut = join(work, 'shard-out')
const shardEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CI_SHARD_SUITES_DIR: suites,
  MERCURY_CI_SHARD_SEED_FILE: join(work, 'seed.tsv'),
  MERCURY_CI_SHARD_CEILING_FILE: join(work, 'ceilings.tsv'),
  MERCURY_CI_SHARD_OUT: shardOut,
  MERCURY_CONFIG_DIR: join(work, 'config-home'),
  MERCURY_HOME: join(work, 'boot-home'),
  MERCURY_CREDENTIAL_STORE: 'file',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || FIXTURE_API_KEY,
}
for (const k of ['NODE_OPTIONS', 'MERCURY_SUITE_TIMEOUT', 'MERCURY_SUITE_TIMEOUT_FLOOR', 'MERCURY_SUITE_CEILING']) delete shardEnv[k]
const live = spawnSync('bash', ['scripts/gate/ci-shard.sh', '0', '1'], { cwd: ROOT, env: shardEnv, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' })
check('the synthetic shard ran green', live.status === 0, (live.stdout + live.stderr).slice(-400))
const liveRows = existsSync(join(shardOut, 'skips.tsv')) ? readRows(join(shardOut, 'skips.tsv')) : []
check('the shard wrote skips.tsv beside results.tsv with the suite\'s count and first line', existsSync(join(shardOut, 'results.tsv')) && JSON.stringify(liveRows) === JSON.stringify([['census', '2', '[SKIP] first road not on this box']]), JSON.stringify(liveRows))
check('the shard log carries the census line', live.stdout.includes('skip census: 1 of 1 suites carried [SKIP] lines'), live.stdout.slice(-400))
check('the shard still prints its own skip lines for the green suite', live.stdout.includes('│ skip › ') && live.stdout.includes('[SKIP] first road not on this box'), live.stdout.slice(-400))

section('§5 the workflows keep the per-suite output and the census on every results artifact, and the aggregate prints the census')
for (const [file, prefix] of [['gate.yml', 'gate-results-'], ['drives.yml', 'drives-results-']] as const) {
  const text = readFileSync(join(ROOT, '.github', 'workflows', file), 'utf8')
  const uploads = text.split('- uses: actions/upload-artifact').slice(1).map(c => c.split(/\n {6}- /)[0]!).filter(c => c.includes(`name: ${prefix}`))
  check(`${file}: two results uploads (the shard matrix and the darwin lane) keep their names`, uploads.length === 2 && uploads.some(c => c.includes(`name: ${prefix}shard-\${{ matrix.shard }}`)) && uploads.some(c => c.includes(`name: ${prefix}darwin`)), `${uploads.length} uploads`)
  for (const need of ['ci-gate-out/results.tsv', 'ci-gate-out/notes.tsv', 'ci-gate-out/skips.tsv', 'ci-gate-out/*.out', 'ci-gate-out/retry/*.out']) {
    check(`${file}: every results upload lists ${need}`, uploads.length === 2 && uploads.every(c => c.includes(`\n            ${need}\n`)))
  }
  const censusAt = text.indexOf('/usr/bin/python3 scripts/gate/skip-census.py --aggregate results')
  const verdictAt = text.indexOf('/usr/bin/python3 scripts/gate/ci-verdict.py results --scope')
  check(`${file}: the verdict job prints the census before it judges`, censusAt > 0 && verdictAt > censusAt, `census at ${censusAt}, verdict at ${verdictAt}`)
}

cleanup()
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-skip-census — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
