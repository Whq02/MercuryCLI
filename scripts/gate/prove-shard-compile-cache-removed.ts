#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const PREFIX = 'mercury-node-compile-cache.'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}

const work = mkdtempSync(join(tmpdir(), 'shard-cache-'))
const cachesIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith(PREFIX)) : [])

type Shard = { status: number | null; log: string; seen: string; stood: boolean; temp: string; world: string }
function runShard(tag: string, suiteExit: number, extra: Record<string, string>): Shard {
  const world = join(work, tag)
  const temp = join(world, 'tmp')
  const suites = join(world, 'suites')
  const seenFile = join(world, 'seen.txt')
  mkdirSync(temp, { recursive: true })
  mkdirSync(join(suites, 'cache-reader'), { recursive: true })
  writeFileSync(
    join(suites, 'cache-reader', 'run-all.sh'),
    `#!/usr/bin/env bash\n# gate-class: pure\nprintf '%s\\n' "\${NODE_COMPILE_CACHE:-}" >'${seenFile}'\n[ -d "\${NODE_COMPILE_CACHE:-}" ] && printf 'stood\\n' >>'${seenFile}'\nexit ${suiteExit}\n`,
  )
  chmodSync(join(suites, 'cache-reader', 'run-all.sh'), 0o755)
  writeFileSync(join(world, 'seed.tsv'), 'cache-reader\t5\n')
  writeFileSync(join(world, 'ceilings.tsv'), '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temp,
    MERCURY_CONFIG_DIR: join(world, 'home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_CI_SHARD_SUITES_DIR: suites,
    MERCURY_CI_SHARD_SEED_FILE: join(world, 'seed.tsv'),
    MERCURY_CI_SHARD_CEILING_FILE: join(world, 'ceilings.tsv'),
    MERCURY_CI_SHARD_OUT: join(world, 'out'),
  }
  for (const name of ['RUNNER_TEMP', 'NODE_COMPILE_CACHE', 'NODE_OPTIONS', 'MERCURY_SUITE_TIMEOUT', 'MERCURY_SUITE_TIMEOUT_FLOOR', 'MERCURY_SUITE_CEILING']) delete env[name]
  Object.assign(env, extra)
  const shard = spawnSync('bash', ['scripts/gate/ci-shard.sh', '0', '1'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' })
  const lines = existsSync(seenFile) ? readFileSync(seenFile, 'utf8').split('\n') : []
  return { status: shard.status, log: `${shard.stdout}${shard.stderr}`.slice(-400), seen: lines[0] ?? '', stood: lines[1] === 'stood', temp, world }
}

console.log('============================================================')
console.log(' the shard runner removes the compile cache it made')
console.log('============================================================')

section('§1 a green shard: one cache while its suite runs, none after the runner exits')
{
  const shard = runShard('green', 0, {})
  check('the shard ran to a green verdict', shard.status === 0, `rc ${shard.status} ${shard.log}`)
  check("the suite read the runner's own cache under the runner's temp, and it stood while the suite ran", shard.seen.startsWith(join(shard.temp, PREFIX)) && shard.stood, `seen ${JSON.stringify(shard.seen)} stood ${shard.stood}`)
  check('no compile cache is left in the temp root after the runner exits', cachesIn(shard.temp).length === 0, cachesIn(shard.temp).join(' '))
  check('the cache the suite read is gone', shard.seen !== '' && !existsSync(shard.seen), shard.seen)
}

section('§2 a red shard: the cache goes with a failing suite too')
{
  const shard = runShard('red', 1, {})
  check('the shard ended red', shard.status !== 0 && shard.status !== null, `rc ${shard.status} ${shard.log}`)
  check("the suite read the runner's own cache", shard.seen.startsWith(join(shard.temp, PREFIX)) && shard.stood, `seen ${JSON.stringify(shard.seen)}`)
  check('no compile cache is left in the temp root after the red runner exits', cachesIn(shard.temp).length === 0, cachesIn(shard.temp).join(' '))
}

section("§3 the hosted runner's temp: made under RUNNER_TEMP, removed from it")
{
  const hosted = join(work, 'hosted-temp')
  mkdirSync(hosted, { recursive: true })
  const shard = runShard('hosted', 0, { RUNNER_TEMP: hosted })
  check('the shard ran to a green verdict', shard.status === 0, `rc ${shard.status} ${shard.log}`)
  check('the cache was made under RUNNER_TEMP, not under TMPDIR', shard.seen.startsWith(join(hosted, PREFIX)) && shard.stood, `seen ${JSON.stringify(shard.seen)}`)
  check('neither temp root keeps a compile cache', cachesIn(hosted).length === 0 && cachesIn(shard.temp).length === 0, [...cachesIn(hosted), ...cachesIn(shard.temp)].join(' '))
}

section("§4 a cache the caller named is the caller's: read by the suite, never removed, none made beside it")
{
  const named = join(work, 'named-cache')
  mkdirSync(named, { recursive: true })
  writeFileSync(join(named, 'kept.txt'), 'the caller wrote this\n')
  const shard = runShard('named', 0, { NODE_COMPILE_CACHE: named })
  check('the shard ran to a green verdict', shard.status === 0, `rc ${shard.status} ${shard.log}`)
  check("the suite read the caller's cache", shard.seen === named && shard.stood, `seen ${JSON.stringify(shard.seen)}`)
  check("the caller's cache and its file stand after the runner exits", existsSync(join(named, 'kept.txt')) && readFileSync(join(named, 'kept.txt'), 'utf8') === 'the caller wrote this\n')
  check('the runner made no cache of its own', cachesIn(shard.temp).length === 0, cachesIn(shard.temp).join(' '))
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
