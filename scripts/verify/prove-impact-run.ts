#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const bun = process.execPath
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const estate = realpathSync(mkdtempSync(join(tmpdir(), 'impact-run-estate-')))
mkdirSync(join(estate, 'scripts', 'gate'), { recursive: true })
cpSync(join(ROOT, 'scripts/gate/run-suite.sh'), join(estate, 'scripts/gate/run-suite.sh'))
mkdirSync(join(estate, 'scripts', 'lib'), { recursive: true })
cpSync(join(ROOT, 'scripts/lib/suite-env.sh'), join(estate, 'scripts/lib/suite-env.sh'))
cpSync(join(ROOT, 'scripts/lib/firstRunSeed.ts'), join(estate, 'scripts/lib/firstRunSeed.ts'))
for (const [suite, rc] of [
  ['a', 0],
  ['b', 0],
  ['c', 3],
] as const) {
  mkdirSync(join(estate, 'scripts', suite))
  writeFileSync(
    join(estate, 'scripts', suite, 'run-all.sh'),
    `#!/usr/bin/env bash\n# gate-class: pure\n# gate-watch: src/${suite}/**\nset -u\n. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"\necho "suite ${suite} ran"\nexit ${rc}\n`,
  )
  chmodSync(join(estate, 'scripts', suite, 'run-all.sh'), 0o755)
}
mkdirSync(join(estate, 'src', 'a'), { recursive: true })

const env = { ...process.env, MERCURY_SLICE_ROOT: estate, MERCURY_CONFIG_DIR: join(estate, 'home'), MERCURY_GATE_PREBUILT: '1' }
function impact(args: string[], cwd = ROOT): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(bun, [join(ROOT, 'scripts/verify/impact.ts'), ...args], { cwd, env, encoding: 'utf8' })
  return { code: res.status ?? 1, stdout: res.stdout, stderr: res.stderr }
}

section('§1 --run over one owed suite')
const one = impact(['--paths', 'src/a/x.ts', '--run'])
check('exit 0 with the one suite green', one.code === 0, one.stderr)
const oneRows = one.stdout.trim().split('\n')
check('exactly suite a ran, with rc 0 and its seconds', oneRows.length === 1 && /^a\t0\t\d+$/.test(oneRows[0] ?? ''), one.stdout)
check('the reading names the run', one.stderr.includes('impact --run: 1 suite(s), 0 red'))

section('§2 --run over two suites, one red')
const two = impact(['--paths', 'src/b/y.ts', 'src/c/z.ts', '--run'])
check('exit 1 when a suite is red', two.code === 1)
check('both rows land, c red with its exit code', /^b\t0\t\d+$/m.test(two.stdout) && /^c\t3\t\d+$/m.test(two.stdout), two.stdout)
check('the reading counts the red', two.stderr.includes('2 suite(s), 1 red'))
check('a listing (no --run) prints the suites, not rows', impact(['--paths', 'src/b/y.ts']).stdout.trim() === 'b')

section('§2b unclassified execution refuses before any suite starts')
mkdirSync(join(estate, 'scripts', 'identity'))
const ran = join(estate, 'unexpected-run')
writeFileSync(join(estate, 'scripts', 'identity', 'run-all.sh'), `#!/usr/bin/env bash\n# gate-class: pure\nprintf ran > '${ran}'\n`)
for (const args of [
  ['--paths', 'unwatched/file.txt', '--run'],
  ['--paths', 'src/a/x.ts', 'unwatched/file.txt', '--run'],
  ['--paths', 'unwatched/file.txt', '--run', '--json'],
]) {
  const unclassified = impact(args)
  check('unclassified execution exits nonzero with the missing path and remedy', unclassified.code === 1 && unclassified.stderr.includes('unwatched/file.txt') && /declare|watch|full/i.test(unclassified.stderr), unclassified.stdout + unclassified.stderr)
  check('even a whole-tree suite does not run for an incomplete selection', !existsSync(ran))
}
rmSync(join(estate, 'scripts', 'identity'), { recursive: true, force: true })
const jsonRun = impact(['--paths', 'src/a/x.ts', '--run', '--json'])
const jsonResult = JSON.parse(jsonRun.stdout)
check('--run with --json executes the selection and returns actual exits', jsonRun.code === 0 && jsonResult.results?.length === 1 && jsonResult.results[0].suite === 'a' && jsonResult.results[0].rc === 0, jsonRun.stdout)
const jsonRed = impact(['--paths', 'src/c/z.ts', '--run', '--json'])
check('--json cannot turn a red execution into a listing success', jsonRed.code === 1 && JSON.parse(jsonRed.stdout).results?.[0]?.rc === 3, jsonRed.stdout)

section('§3 --staged and --dirty on a scratch repository')
const repo = join(estate, 'repo')
mkdirSync(join(repo, 'scripts', 'gate'), { recursive: true })
const g = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' } })
g('init', '-q')
cpSync(join(estate, 'scripts'), join(repo, 'scripts'), { recursive: true })
mkdirSync(join(repo, 'src', 'a'), { recursive: true })
writeFileSync(join(repo, 'src/a/x.ts'), '1')
g('add', '-A')
g('commit', '-q', '-m', 'seed')
writeFileSync(join(repo, 'src/a/x.ts'), '2')
g('add', 'src/a/x.ts')
const repoEnv = { ...env, MERCURY_SLICE_ROOT: repo }
const stagedRun = spawnSync(bun, [join(ROOT, 'scripts/verify/impact.ts'), '--staged'], { cwd: repo, env: repoEnv, encoding: 'utf8' })
check('--staged names the suite the index owes', stagedRun.status === 0 && stagedRun.stdout.trim() === 'a', stagedRun.stdout + stagedRun.stderr)
mkdirSync(join(repo, 'src', 'c'), { recursive: true })
writeFileSync(join(repo, 'src/c/new.ts'), 'untracked')
const dirtyRun = spawnSync(bun, [join(ROOT, 'scripts/verify/impact.ts'), '--dirty'], { cwd: repo, env: repoEnv, encoding: 'utf8' })
check('--dirty reads the working tree against HEAD, the untracked file included', dirtyRun.status === 0 && dirtyRun.stdout.trim().split('\n').join(',') === 'a,c', dirtyRun.stdout + dirtyRun.stderr)
g('commit', '-q', '-am', 'x')
rmSync(join(repo, 'src/c'), { recursive: true, force: true })
const cleanRun = spawnSync(bun, [join(ROOT, 'scripts/verify/impact.ts'), '--dirty'], { cwd: repo, env: repoEnv, encoding: 'utf8' })
check('--dirty on a clean tree exits 2 (never reads as nothing to run)', cleanRun.status === 2)

section('§4 the real estate names the suites a change owes')
const real = spawnSync(bun, [join(ROOT, 'scripts/verify/impact.ts'), '--paths', 'src/utils/settings/types.ts', 'src/ink/launcherAltHold.ts'], { cwd: ROOT, env: { ...process.env, MERCURY_GATE_PREBUILT: '1' }, encoding: 'utf8' })
const named = new Set(real.stdout.trim().split('\n'))
check('a settings type change owes the settings suite', named.has('settings'))
check('a terminal runtime change owes the ink-runtime suite', named.has('ink-runtime'))
const sharedPaths = ['scripts/lib/proof-runner.sh', 'scripts/lib/new-helper.ts', 'assets/completions/mercury.bash', 'assets/completions/_mercury', 'assets/completions/mercury.fish']
const watched = spawnSync(bun, [join(ROOT, 'scripts/verify/impact.ts'), '--paths', ...sharedPaths, '--json'], { cwd: ROOT, env: { ...process.env, MERCURY_SLICE_ROOT: ROOT }, encoding: 'utf8' })
const classified = JSON.parse(watched.stdout)
check('shared helper and completion paths are classified', watched.status === 0 && classified.unclassified.length === 0, watched.stdout)
for (const path of sharedPaths) check('the actual owning suite watches the path, not only the whole-tree default', classified.perPath[path].includes(path.startsWith('scripts/lib/') ? 'gate' : 'project-services'), `${path}: ${classified.perPath[path]}`)

rmSync(estate, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
