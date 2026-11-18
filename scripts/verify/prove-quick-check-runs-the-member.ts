#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const scratch = mkdtempSync(join(tmpdir(), 'quick-check-member-'))
const marks = join(scratch, 'markers')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: scratch, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' } })
const w = (rel: string, body: string): void => {
  mkdirSync(join(scratch, rel, '..'), { recursive: true })
  writeFileSync(join(scratch, rel), body)
}
const runner = (rel: string, lines: string[]): void => {
  w(rel, ['#!/usr/bin/env bash', ...lines, ''].join('\n'))
  chmodSync(join(scratch, rel), 0o755)
}
const mark = (name: string): string => `mkdir -p '${marks}'; echo ran >>'${join(marks, name)}'`
const member = (name: string): string => `import { appendFileSync, mkdirSync } from 'node:fs'\nmkdirSync(${JSON.stringify(marks)}, { recursive: true })\nappendFileSync(${JSON.stringify(join(marks, name))}, 'ran\\n')\n`
const markers = (): string => (existsSync(marks) ? readdirSync(marks).sort().join(',') : '')
const resetMarkers = (): void => rmSync(marks, { recursive: true, force: true })

const env = {
  ...process.env,
  BUN: process.execPath,
  MERCURY_SLICE_ROOT: scratch,
  MERCURY_SLICE_NO_CI: '1',
  MERCURY_SLICE_CORES: '8',
  MERCURY_GATE_NO_PREBUILD: '1',
  MERCURY_CONFIG_DIR: join(scratch, 'config-home'),
  MERCURY_HOME: join(scratch, 'proof-home'),
  BROWSER: '/usr/bin/true',
}
function fast(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ['run', join(REPO, 'scripts/verify/fast.ts'), ...args], { cwd: scratch, encoding: 'utf8', timeout: 180_000, env })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
function twin(name: string | null): { status: number | null; out: string } {
  const r = spawnSync('bash', ['scripts/stream-drives/run-all.sh'], { cwd: scratch, encoding: 'utf8', timeout: 60_000, env: { ...env, ...(name === null ? {} : { MERCURY_SUITE_MEMBER: name }) } })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const lineWith = (out: string, ...words: string[]): string => out.split('\n').find(l => words.every(word => l.includes(word))) ?? ''
function lastEvidence(): { scope: string; coverage: string; ok: boolean } | undefined {
  const candidates = [join(scratch, '.mercury', 'verify', 'evidence.json')]
  const verifyRoot = join(scratch, 'config-home', 'verify')
  if (existsSync(verifyRoot)) for (const entry of readdirSync(verifyRoot)) candidates.unshift(join(verifyRoot, entry, 'evidence.json'))
  const found = candidates.find(p => existsSync(p))
  return found === undefined ? undefined : ((JSON.parse(readFileSync(found, 'utf8')).records ?? []) as Array<{ scope: string; coverage: string; ok: boolean }>).at(-1)
}

runner('scripts/typecheck/run-all.sh', ['# gate-class: pure', 'exit 0'])
runner('scripts/stream/run-all.sh', ['# gate-class: pure', mark('stream'), 'claimed=$(cat scripts/stream-*/members.txt 2>/dev/null)', 'exit 0'])
runner('scripts/stream-drives/run-all.sh', ['# gate-class: pty', 'set -uo pipefail', '. "$(dirname "$0")/../lib/drive-members.sh" || exit 78', 'cd "$(dirname "$0")/../.." || exit 1', `drive_members stream-drives 'scripts/stream/$name' "scripts/stream-drives/members.txt"`])
w('scripts/stream-drives/members.txt', 'prove-one.ts\nprove-two.ts\n')
w('scripts/stream/prove-one.ts', member('one'))
w('scripts/stream/prove-two.ts', member('two'))
runner('scripts/loop-drives/run-all.sh', ['# gate-class: pty', 'while read -r name; do f="scripts/loop/$name"; "$BUN" "$f" || exit 1; done < scripts/loop-drives/members.txt'])
w('scripts/loop-drives/members.txt', 'prove-loop.ts\n')
runner('scripts/loop/run-all.sh', ['# gate-class: pure', mark('loop'), 'claimed=$(cat scripts/loop-*/members.txt 2>/dev/null)', 'exit 0'])
w('scripts/loop/prove-loop.ts', member('loop-member'))
mkdirSync(join(scratch, 'scripts', 'gate'), { recursive: true })
cpSync(join(REPO, 'scripts/run-all-suites.sh'), join(scratch, 'scripts/run-all-suites.sh'))
for (const file of ['run-suite.sh', 'suite-grants.sh', 'timeline.py']) cpSync(join(REPO, 'scripts/gate', file), join(scratch, 'scripts/gate', file))
for (const file of ['drive-members.sh', 'suite-env.sh', 'firstRunSeed.ts', 'project-home.sh', 'process-ledger.sh', 'proofScratch.cjs', 'proofBrowser.cjs', 'box_shape.py']) cpSync(join(REPO, 'scripts/lib', file), join(scratch, 'scripts/lib', file))
w('scripts/gate/duration-seed.tsv', 'typecheck\t5\nstream\t5\nloop\t5\n')
w('scripts/gate/impact-ignore.txt', 'docs/**\n')
w('.gitignore', '.mercury/\nmarkers/\nconfig-home/\nproof-home/\n')
git('init', '-q')
git('add', '-A')
git('commit', '-q', '-m', 'fixture')
const headSha = git('rev-parse', 'HEAD').trim()
const headTree = git('rev-parse', 'HEAD^{tree}').trim()
w('.mercury/gate/verdict.json', JSON.stringify({ ok: true, pass: ['typecheck', 'stream', 'loop'], fail: [], headSha, dirty: false, treeSha: headTree, durationS: 600, durations: { typecheck: 5, stream: 5, loop: 5 }, classes: { typecheck: 'pure', stream: 'pure', loop: 'pure' }, flakes: [] }))

try {
  section("§1 the runner's own filter: one member by MERCURY_SUITE_MEMBER, and a name that is no member is an error")
  {
    const whole = twin(null)
    check('with no name the twin runs every member', whole.status === 0 && markers() === 'one,two', `${whole.status} · ${markers()}`)
    resetMarkers()
    const one = twin('prove-two.ts')
    check('with a name it runs that member alone and says so', one.status === 0 && markers() === 'two' && one.out.includes('one member alone by MERCURY_SUITE_MEMBER (prove-two.ts)'), `${one.status} · ${markers()} · ${lineWith(one.out, 'MERCURY_SUITE_MEMBER')}`)
    resetMarkers()
    const none = twin('prove-nope.ts')
    check('a name its list does not hold exits 1 by its own line and runs nothing', none.status === 1 && markers() === '' && none.out.includes('MERCURY_SUITE_MEMBER names prove-nope.ts, which is no member in scripts/stream-drives/members.txt'), `${none.status} · ${markers()} · ${none.out.trim()}`)
  }

  section('§2 a member of a suite the full run does not read, changed alone: the quick check runs that member through the twin')
  {
    appendFileSync(join(scratch, 'scripts/stream/prove-one.ts'), 'console.log(1)\n')
    resetMarkers()
    const plan = fast(['--plan'])
    check('the plan names the twin as not read by the full run', lineWith(plan.out, 'not read by the anchor').includes('stream-drives'), lineWith(plan.out, 'not read by the anchor'))
    check('and says the changed member runs here, through the twin', lineWith(plan.out, 'scripts/stream/prove-one.ts changed and is a member of stream-drives').includes('scripts/stream-drives/run-all.sh') && lineWith(plan.out, 'plan:').includes('changed members alone [prove-one.ts of stream-drives]'), `${lineWith(plan.out, 'is a member of')} · ${lineWith(plan.out, 'plan:')}`)
    check('a plan runs nothing', plan.status === 0 && markers() === '', `${plan.status} · ${markers()}`)
    const ran = fast([])
    check('the run is green', ran.status === 0, `status ${ran.status} · ${ran.out.slice(-500)}`)
    check('the changed member ran once, its sibling in the twin did not, and the plain suite ran in the pool', markers() === 'one,stream' && readFileSync(join(marks, 'one'), 'utf8') === 'ran\n', markers())
    check("the verdict holds the member's line with its seconds", /✓ member prove-one\.ts of stream-drives, alone through its own runner \(\d+s\)/.test(ran.out) && ran.out.includes('stream-drives but for the changed members above'), `${lineWith(ran.out, 'member prove-one.ts')} · ${lineWith(ran.out, 'NOT covered')}`)
    const row = lastEvidence()
    check('the evidence row names the member', row?.scope === 'fast' && row.ok === true && row.coverage.includes('members alone [prove-one.ts of stream-drives]'), JSON.stringify(row))
  }

  section('§3 a red member turns the quick check red')
  {
    writeFileSync(join(scratch, 'scripts/stream/prove-one.ts'), 'process.exit(1)\n')
    resetMarkers()
    const ran = fast([])
    check('exit 1, with the member named as failed', ran.status === 1 && /✕ member prove-one\.ts of stream-drives/.test(ran.out) && ran.out.includes('verify:fast RED'), `status ${ran.status} · ${lineWith(ran.out, 'member prove-one.ts')}`)
    git('checkout', '--', 'scripts/stream/prove-one.ts')
  }

  section('§4 a runner that cannot run one member alone, and a suite the anchor has never seen')
  {
    appendFileSync(join(scratch, 'scripts/loop/prove-loop.ts'), 'console.log(1)\n')
    resetMarkers()
    const ran = fast([])
    check('a changed member of a suite whose runner has no filter is named as not run, and is not run', ran.status === 0 && lineWith(ran.out, 'scripts/loop/prove-loop.ts changed and is a member of loop-drives').includes('cannot run one member alone') && markers() === 'loop', `${ran.status} · ${markers()} · ${lineWith(ran.out, 'loop-drives')}`)
    git('checkout', '--', 'scripts/loop/prove-loop.ts')
    runner('scripts/fresh-drives/run-all.sh', ['# gate-class: pty', '. "$(dirname "$0")/../lib/drive-members.sh" || exit 78', 'cd "$(dirname "$0")/../.." || exit 1', `drive_members fresh-drives 'scripts/stream/$name' "scripts/fresh-drives/members.txt"`])
    w('scripts/fresh-drives/members.txt', 'prove-one.ts\n')
    const plan = fast(['--plan'])
    check('a suite the anchor has never seen is still an escalation to the full run', lineWith(plan.out, 'plan verdict').includes('ESCALATE to the FULL gate (new-suite)') && lineWith(plan.out, 'plan verdict').includes('fresh-drives'), lineWith(plan.out, 'plan verdict'))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
