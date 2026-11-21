#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const work = mkdtempSync(join(tmpdir(), 'local-drives-'))
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
try {
  const scripts = join(work, 'project/scripts')
  mkdirSync(scripts, { recursive: true })
  for (const dir of ['gate', 'lib']) symlinkSync(join(root, 'scripts', dir), join(scripts, dir))
  const ref = process.argv.indexOf('--ref')
  const runner = ref < 0 ? readFileSync(join(root, 'scripts/run-all-suites.sh'), 'utf8') : spawnSync('git', ['show', `${process.argv[ref + 1]}:scripts/run-all-suites.sh`], { cwd: root, encoding: 'utf8' }).stdout
  writeFileSync(join(scripts, 'run-all-suites.sh'), runner)
  const suites = join(work, 'suites')
  const count = join(work, 'count')
  for (const [name, cls, body] of [['quiet', 'pure', 'exit 0'], ['capture', 'pty', 'exit 0'], ['x-drives', 'pty', `printf 'run\\n' >> '${count}'; exit 7`]]) {
    mkdirSync(join(suites, name!), { recursive: true })
    writeFileSync(join(suites, name!, 'run-all.sh'), `#!/usr/bin/env bash\n# gate-class: ${cls}\n${body}\n`)
  }
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('MERCURY_GATE_')) delete env[key]
  Object.assign(env, { MERCURY_GATE_SUITES_DIR: suites, MERCURY_GATE_NO_PREBUILD: '1', MERCURY_GATE_JOBS: '2' })
  const release = join(work, 'verdict.json')
  const run = (args: string[], verdict: string) => spawnSync('bash', [join(scripts, 'run-all-suites.sh'), ...args], { cwd: root, env: { ...env, MERCURY_GATE_VERDICT_FILE: verdict }, encoding: 'utf8' })
  const first = run([], release)
  const original = existsSync(release) ? readFileSync(release, 'utf8') : '{}'
  const v = JSON.parse(original)
  check('the local release excludes a planted x-drives but retains its other pty suite', first.status === 0 && v.pass?.sort().join(',') === 'capture,quiet' && !existsSync(count), `rc ${first.status}, pass ${v.pass}; the default --class release in scripts/run-all-suites.sh must skip a suite whose '# gate-class:' is pty and named *-drives, and still run other pty suites`)
  const drives = run(['--class', 'drives'], join(work, 'drives-verdict.json'))
  const dv = existsSync(join(work, 'drives-verdict.json')) ? JSON.parse(readFileSync(join(work, 'drives-verdict.json'), 'utf8')) : {}
  check('the drives guide runs a red drive exactly once with a separate advisory verdict', drives.status === 1 && dv.scope === 'drives' && dv.fail?.join(',') === 'x-drives' && readFileSync(count, 'utf8') === 'run\n', `rc ${drives.status}, scope ${dv.scope}; run-all-suites.sh --class drives in scripts/run-all-suites.sh must run the *-drives suites once and write a verdict with scope drives to MERCURY_GATE_VERDICT_FILE`)
  check('the guide preserves the release verdict and writes its own ledger', readFileSync(release, 'utf8') === original && existsSync(join(work, 'drives-ledger.jsonl')), 'scripts/run-all-suites.sh with --class drives must leave the release verdict file as it was and write drives-ledger.jsonl beside the drives verdict')
  rmSync(count, { force: true })
  const subset = run(['x-drives'], join(work, 'subset.json'))
  check('an explicit drives suite is still runnable without writing a full verdict', subset.status === 1 && existsSync(count) && !existsSync(join(work, 'subset.json')), `rc ${subset.status}; scripts/run-all-suites.sh given a suite name must run it even when it is a drive, and must not write a verdict file for a subset`)
  const hosted = (scope: string) => spawnSync('bash', ['scripts/gate/ci-shard.sh', '0', '1', '--class', scope, '--plan-only'], { cwd: root, env: { ...env, MERCURY_CI_SHARD_SUITES_DIR: suites }, encoding: 'utf8' }).stdout.trim().split('\n').sort()
  check('the hosted release still excludes all pty, and hosted drives includes the planted drive', hosted('release').join(',') === 'quiet' && hosted('drives').join(',') === 'capture,x-drives', `release ${hosted('release').join(',')} · drives ${hosted('drives').join(',')}; the --class plan in scripts/gate/ci-shard.sh must keep every pty suite out of release and plan the *-drives suites under drives`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
process.exit(failures ? 1 : 0)
