#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}

if (process.platform === 'win32') {
  console.log('SKIP second-look-runs-reds: the shard runner is a POSIX script')
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'second-look-'))

type Kind = 'green' | 'red-once' | 'red-always' | 'slow'
type Run = { member: string; path: string; bun: string | null; leaveOut: string | null }
type World = { dir: string; suites: string; out: string; ledger: string; env: NodeJS.ProcessEnv }

function world(tag: string, extra: NodeJS.ProcessEnv = {}): World {
  const dir = join(work, tag)
  const suites = join(dir, 'scripts')
  const ledger = join(dir, 'ledger.jsonl')
  mkdirSync(join(dir, 'tmp'), { recursive: true })
  mkdirSync(suites, { recursive: true })
  writeFileSync(join(dir, 'ceilings.tsv'), '')
  writeFileSync(ledger, '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: join(dir, 'tmp'),
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
    BUN: process.execPath,
    MERCURY_CONFIG_DIR: join(dir, 'home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_CI_SHARD_SUITES_DIR: suites,
    MERCURY_CI_SHARD_SEED_FILE: join(dir, 'seed.tsv'),
    MERCURY_CI_SHARD_CEILING_FILE: join(dir, 'ceilings.tsv'),
    MERCURY_CI_SHARD_OUT: join(dir, 'out'),
    SECOND_LOOK_LEDGER: ledger,
  }
  for (const name of ['RUNNER_TEMP', 'NODE_COMPILE_CACHE', 'NODE_OPTIONS', 'BUN_OPTIONS', 'MERCURY_SUITE_TMPDIR', 'MERCURY_SUITE_SCRIPT', 'MERCURY_SUITE_RUNNER_PID', 'MERCURY_PROCESS_LEDGER_DIR', 'MERCURY_TMPDIR', 'MERCURY_SUITE_TIMEOUT', 'MERCURY_SUITE_TIMEOUT_FLOOR', 'MERCURY_SUITE_CEILING', 'MERCURY_SUITE_LEAVE_OUT', 'MERCURY_SUITE_MEMBER', 'MERCURY_SUITE_JOBS', 'MERCURY_CI_RETRY_MAX_SECS']) delete env[name]
  for (const name of Object.keys(env)) if (name.startsWith('BASH_FUNC_')) delete env[name]
  return { dir, suites, out: join(dir, 'out'), ledger, env: { ...env, ...extra } }
}

function member(w: World, group: string, file: string, kind: Kind): void {
  const name = `${group}/${file}`
  const seen = join(w.dir, `${group}.${file}.seen`)
  const row = JSON.stringify({ member: name, path: '', bun: null, leaveOut: null })
  if (file.endsWith('.sh')) {
    writeFileSync(join(w.suites, group, file), `printf '%s\\n' '${row}' >>"$SECOND_LOOK_LEDGER"\n`)
    return
  }
  if (file.endsWith('.py')) {
    writeFileSync(join(w.suites, group, file), `import os\nwith open(os.environ['SECOND_LOOK_LEDGER'], 'a') as ledger:\n    ledger.write(${JSON.stringify(`${row}\n`)})\n`)
    return
  }
  const verdict = kind === 'red-always' ? 'process.exit(1)' : kind === 'red-once' ? `if (!existsSync(${JSON.stringify(seen)})) { writeFileSync(${JSON.stringify(seen)}, ''); process.exit(1) }` : kind === 'slow' ? 'await Bun.sleep(4000)' : ''
  writeFileSync(
    join(w.suites, group, file),
    `import { appendFileSync, existsSync, writeFileSync } from 'node:fs'\nappendFileSync(process.env.SECOND_LOOK_LEDGER!, JSON.stringify({ member: ${JSON.stringify(name)}, path: process.env.PATH ?? '', bun: process.env.BUN ?? null, leaveOut: process.env.MERCURY_SUITE_LEAVE_OUT ?? null }) + '\\n')\n${verdict}\n`,
  )
}

function group(w: World, name: string, runner: string[], members: Array<[string, Kind]>, lists: Record<string, string[]> = {}): void {
  mkdirSync(join(w.suites, name), { recursive: true })
  writeFileSync(join(w.suites, name, 'run-all.sh'), `#!/usr/bin/env bash\n# gate-class: pure\nset -u\n${runner.join('\n')}\n`)
  chmodSync(join(w.suites, name, 'run-all.sh'), 0o755)
  for (const [file, kind] of members) member(w, name, file, kind)
  for (const [list, rows] of Object.entries(lists)) writeFileSync(join(w.suites, name, list), `${rows.join('\n')}\n`)
}

const door = [`. "${ROOT}/scripts/lib/drive-members.sh"`, 'here="$(cd "$(dirname "$0")" && pwd)"', 'fail=0']
const joins = (name: string, list: string, form = ''): string => `drive_members ${name} "$here/\\$name" "$here/${list}"${form === '' ? '' : ` '' ${form}`} || fail=1`

function shard(w: World): Promise<{ code: number | null; text: string }> {
  return new Promise(done => {
    const child = spawn('bash', ['scripts/gate/ci-shard.sh', '0', '1'], { cwd: ROOT, env: w.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
    child.on('close', code => done({ code, text }))
  })
}
const runsOf = (w: World): Run[] => readFileSync(w.ledger, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Run)
const times = (w: World, name: string): number => runsOf(w).filter(run => run.member === name).length
const rowOf = (w: World, name: string): string => {
  const file = join(w.out, 'results.tsv')
  return existsSync(file) ? (readFileSync(file, 'utf8').split('\n').find(line => line.startsWith(`${name}\t`)) ?? '') : ''
}
const logOf = (w: World, name: string, retry = false): string => {
  const file = join(w.out, ...(retry ? ['retry'] : []), `${name}.out`)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

console.log('============================================================')
console.log(" a red group's second look runs its red tests, not the group")
console.log('============================================================')

try {
  const a = world('reds')
  const runnerSaw = join(a.dir, 'listed.runner')
  const cutShort = join(a.dir, 'cut-short.runner')
  group(a, 'listed', [...door, `printf '%s\\t%s\\n' "$PATH" "\${BUN-}" >>'${runnerSaw}'`, joins('listed', 'members.txt'), 'exit "$fail"'], [['prove-green-one.ts', 'green'], ['prove-red-once.ts', 'red-once'], ['prove-green-shell.sh', 'green'], ['prove-green-python.py', 'green']], { 'members.txt': ['prove-green-one.ts', 'prove-red-once.ts', 'prove-green-shell.sh', 'prove-green-python.py'] })
  group(a, 'stays', [...door, joins('stays', 'members.txt', 'run'), 'exit "$fail"'], [['prove-green-two.ts', 'green'], ['prove-red-always.ts', 'red-always']], { 'members.txt': ['prove-green-two.ts', 'prove-red-always.ts'] })
  group(a, 'cut-short', [...door, joins('cut-short', 'first.txt'), `[ -f '${cutShort}' ] || { : >'${cutShort}'; exit 1; }`, joins('cut-short', 'second.txt'), 'exit "$fail"'], [['prove-green-three.ts', 'green'], ['prove-red-once.ts', 'red-once'], ['prove-late.ts', 'green']], { 'first.txt': ['prove-green-three.ts', 'prove-red-once.ts'], 'second.txt': ['prove-late.ts'] })
  group(a, 'unmarked', ['here="$(cd "$(dirname "$0")" && pwd)"', 'bun="${BUN:-$HOME/.bun/bin/bun}"', '"$bun" run "$here/prove-green-six.ts" && "$bun" run "$here/prove-red-once.ts"'], [['prove-green-six.ts', 'green'], ['prove-red-once.ts', 'red-once']])
  writeFileSync(join(a.dir, 'seed.tsv'), 'listed\t6\nstays\t5\ncut-short\t4\nunmarked\t3\n')

  const b = world('budget', { MERCURY_CI_RETRY_MAX_SECS: '3' })
  group(b, 'long', [...door, joins('long', 'members.txt'), 'exit "$fail"'], [['prove-green-slow.ts', 'slow'], ['prove-red-once.ts', 'red-once']], { 'members.txt': ['prove-green-slow.ts', 'prove-red-once.ts'] })
  writeFileSync(join(b.dir, 'seed.tsv'), 'long\t5\n')

  const [first, second] = await Promise.all([shard(a), shard(b)])

  section('§1 a group whose tests join by its list: one test red once, three green')
  check('the group was red, had its second look and came back green', /^listed\tpure\t1\t\d+\t0\t\d+$/.test(rowOf(a, 'listed')), rowOf(a, 'listed') || first.text.slice(-400))
  check('the red test ran twice', times(a, 'listed/prove-red-once.ts') === 2, String(times(a, 'listed/prove-red-once.ts')))
  for (const [file, kind] of [['prove-green-one.ts', 'bun'], ['prove-green-shell.sh', 'shell'], ['prove-green-python.py', 'Python']] as const) {
    check(`a green ${kind} test ran once, in the first attempt only`, times(a, `listed/${file}`) === 1, String(times(a, `listed/${file}`)))
  }
  check('the second look says which tests it did not run again', ['prove-green-one.ts', 'prove-green-shell.sh', 'prove-green-python.py'].every(file => logOf(a, 'listed', true).includes(`second look: scripts/listed/${file} was green in the first attempt and is not run again`)), logOf(a, 'listed', true).slice(0, 600))
  const saw = existsSync(runnerSaw) ? readFileSync(runnerSaw, 'utf8').split('\n').filter(Boolean) : []
  check('the runner saw the same PATH and BUN in both attempts', saw.length === 2 && saw[0] === saw[1] && saw[0]!.endsWith(`\t${process.execPath}`), JSON.stringify(saw.map(line => line.slice(0, 120))))
  const reds = runsOf(a).filter(run => run.member === 'listed/prove-red-once.ts')
  check('the red test saw the same PATH and BUN in both attempts, and the list of what to leave out was not handed to it', reds.length === 2 && reds[0]!.path === reds[1]!.path && reds[0]!.bun === reds[1]!.bun && reds[0]!.bun === process.execPath && reds.every(run => run.leaveOut === null), JSON.stringify(reds.map(run => [run.bun, run.leaveOut, run.path.slice(0, 80)])))

  section('§2 a group started as `bun run`: one test always red')
  check('the group stayed red on its second look', /^stays\tpure\t1\t\d+\t1\t\d+$/.test(rowOf(a, 'stays')), rowOf(a, 'stays'))
  check('the red test ran twice', times(a, 'stays/prove-red-always.ts') === 2, String(times(a, 'stays/prove-red-always.ts')))
  check('the green test ran once', times(a, 'stays/prove-green-two.ts') === 1, String(times(a, 'stays/prove-green-two.ts')))
  check('the shard is red and names the group', first.code === 1 && first.text.includes('re-run still RED — genuine'), `rc ${first.code}`)

  section('§3 a runner that ended before its second list')
  check('the group came back green on its second look', /^cut-short\tpure\t1\t\d+\t0\t\d+$/.test(rowOf(a, 'cut-short')), rowOf(a, 'cut-short'))
  check('the test the first attempt never reached is run in the second look', times(a, 'cut-short/prove-late.ts') === 1, String(times(a, 'cut-short/prove-late.ts')))
  check('the green test ran once, the red test twice', times(a, 'cut-short/prove-green-three.ts') === 1 && times(a, 'cut-short/prove-red-once.ts') === 2, `${times(a, 'cut-short/prove-green-three.ts')} ${times(a, 'cut-short/prove-red-once.ts')}`)

  section('§4 a red group whose output names no test is run again whole')
  check('the group came back green on its second look', /^unmarked\tpure\t1\t\d+\t0\t\d+$/.test(rowOf(a, 'unmarked')), rowOf(a, 'unmarked'))
  check('every test of it ran twice', times(a, 'unmarked/prove-green-six.ts') === 2 && times(a, 'unmarked/prove-red-once.ts') === 2, `${times(a, 'unmarked/prove-green-six.ts')} ${times(a, 'unmarked/prove-red-once.ts')}`)

  section('§5 the line above which a red group gets no second look measures what the second look runs')
  check('a group longer than the line has its red test run again when that test fits under it', /^long\tpure\t1\t\d+\t0\t\d+$/.test(rowOf(b, 'long')), rowOf(b, 'long') || second.text.slice(-400))
  check('the slow green test ran once, the red test twice', times(b, 'long/prove-green-slow.ts') === 1 && times(b, 'long/prove-red-once.ts') === 2, `${times(b, 'long/prove-green-slow.ts')} ${times(b, 'long/prove-red-once.ts')}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-second-look-runs-reds — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
