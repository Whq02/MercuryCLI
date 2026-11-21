#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const work = mkdtempSync(join(tmpdir(), 'shard-temp-'))

type Seen = { status: number | null; log: string; home: string; cache: string; homeStood: boolean }
function runShard(tag: string, tempAsHanded: (temp: string) => string): Seen {
  const world = join(work, tag)
  const temp = join(world, 'tmp')
  const suites = join(world, 'suites')
  const seenFile = join(world, 'seen.txt')
  mkdirSync(temp, { recursive: true })
  mkdirSync(join(suites, 'home-reader'), { recursive: true })
  writeFileSync(
    join(suites, 'home-reader', 'run-all.sh'),
    `#!/usr/bin/env bash\n# gate-class: pure\nprintf '%s\\n%s\\n' "\${MERCURY_CONFIG_DIR:-}" "\${NODE_COMPILE_CACHE:-}" >'${seenFile}'\n[ -d "\${MERCURY_CONFIG_DIR:-}" ] && printf 'stood\\n' >>'${seenFile}'\nexit 0\n`,
  )
  chmodSync(join(suites, 'home-reader', 'run-all.sh'), 0o755)
  writeFileSync(join(world, 'seed.tsv'), 'home-reader\t5\n')
  writeFileSync(join(world, 'ceilings.tsv'), '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: tempAsHanded(temp),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_CI_SHARD_SUITES_DIR: suites,
    MERCURY_CI_SHARD_SEED_FILE: join(world, 'seed.tsv'),
    MERCURY_CI_SHARD_CEILING_FILE: join(world, 'ceilings.tsv'),
    MERCURY_CI_SHARD_OUT: join(world, 'out'),
  }
  for (const name of ['RUNNER_TEMP', 'NODE_COMPILE_CACHE', 'NODE_OPTIONS', 'MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'MERCURY_SUITE_TIMEOUT', 'MERCURY_SUITE_TIMEOUT_FLOOR', 'MERCURY_SUITE_CEILING']) delete env[name]
  const shard = spawnSync('bash', ['scripts/gate/ci-shard.sh', '0', '1'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' })
  const lines = existsSync(seenFile) ? readFileSync(seenFile, 'utf8').split('\n') : []
  return { status: shard.status, log: `${shard.stdout}${shard.stderr}`.slice(-400), home: lines[0] ?? '', cache: lines[1] ?? '', homeStood: lines[2] === 'stood' }
}

const mend = 'scripts/gate/ci-shard.sh takes its temp root from RUNNER_TEMP or TMPDIR: strip a trailing slash before a folder name is joined to it'

console.log('the shard runner hands a suite a config home and a compile cache spelled as the disk spells a path')
for (const [tag, words, tempAsHanded] of [
  ['plain', 'a temp root with no trailing slash', (temp: string) => temp],
  ['slash', 'a temp root that ends in a slash, as macOS hands TMPDIR', (temp: string) => `${temp}/`],
] as const) {
  const seen = runShard(tag, tempAsHanded)
  check(`${words}: the shard ran green and its suite stood in a config home the runner made`, seen.status === 0 && seen.homeStood, `scripts/gate/ci-shard.sh must exit 0 and export a MERCURY_CONFIG_DIR folder that exists when the suite runs (see where shard_temp and ambient_home are set); rc ${seen.status} ${seen.log}`)
  check(`${words}: the config home holds no doubled slash and equals its own resolved spelling`, seen.home !== '' && !seen.home.includes('//') && seen.home === resolve(seen.home), `${JSON.stringify(seen.home)} — ${mend}`)
  check(`${words}: the compile cache holds no doubled slash and equals its own resolved spelling`, seen.cache !== '' && !seen.cache.includes('//') && seen.cache === resolve(seen.cache), `${JSON.stringify(seen.cache)} — ${mend}`)
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
