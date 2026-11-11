#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'git-host-off-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const repo = join(scratch, 'repo')
mkdirSync(repo)
const g = (...args: string[]): string => {
  const run = Bun.spawnSync(['git', ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'p', GIT_AUTHOR_EMAIL: 'p@x', GIT_COMMITTER_NAME: 'p', GIT_COMMITTER_EMAIL: 'p@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`)
  return run.stdout.toString()
}
g('init', '-q')
writeFileSync(join(repo, 'one.txt'), 'one\n')
g('add', 'one.txt')
g('commit', '-q', '-m', 'one')

const { setCwd } = await import('../../src/utils/Shell.ts')
setCwd(repo)
const { GitTool } = await import('../../src/tools/GitTool/GitTool.ts')

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const context = { abortController: new AbortController(), messages: [], options: {}, getAppState: () => ({}), setAppState: () => {} } as never
const answer = async (input: Record<string, unknown>): Promise<{ result: string; outcome: string }> =>
  ((await GitTool.call(input as never, context)) as { data: { result: string; outcome: string } }).data

const HOST_READS: Array<[string, Record<string, unknown>]> = [
  ['hostSearch', { op: 'hostSearch', searchKind: 'code', query: 'needle' }],
  ['prDiff', { op: 'prDiff', pr: 7 }],
  ['runs', { op: 'runs' }],
  ['runWatch', { op: 'runWatch', run: '42' }],
]

console.log('§1 a host read refused by the flag names the value the flag was set to')
for (const word of ['off', 'false', 'no']) {
  process.env.MERCURY_REPO_HOST = word
  for (const [op, input] of HOST_READS) {
    const out = await answer(input)
    check(`${op} under MERCURY_REPO_HOST=${word} is refused with that value`, out.outcome === 'failed' && out.result === `repository-host reads are disabled (MERCURY_REPO_HOST=${word})`, out.result)
  }
}

console.log('§2 a 0 reads as it always has, and no other value is printed for it')
process.env.MERCURY_REPO_HOST = '0'
for (const [op, input] of HOST_READS) {
  const out = await answer(input)
  check(`${op} under MERCURY_REPO_HOST=0 reads as before`, out.outcome === 'failed' && out.result === 'repository-host reads are disabled (MERCURY_REPO_HOST=0)', out.result)
}
delete process.env.MERCURY_REPO_HOST

console.log(`\nprove-git-host-off-names-set-value: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
