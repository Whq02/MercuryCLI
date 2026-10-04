#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const world = realpathSync(mkdtempSync(join(tmpdir(), 'tree-scratch-')))
const scratchTmp = join(world, 'tmp')
mkdirSync(scratchTmp)
const repo = join(world, 'repo')
mkdirSync(repo)
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
execFileSync(realGit, ['init', '-q', repo], { env: gitEnv })
writeFileSync(join(repo, 'README.md'), '# fixture\n')
execFileSync(realGit, ['-C', repo, 'add', 'README.md'], { env: gitEnv })
execFileSync(realGit, ['-C', repo, 'commit', '-q', '-m', 'first'], { env: gitEnv })
writeFileSync(join(repo, 'big.heapsnapshot'), 'x'.repeat(1024 * 1024))

const slowBin = join(world, 'bin')
mkdirSync(slowBin)
writeFileSync(join(slowBin, 'git'), `#!/bin/sh\nif [ "$1" = "add" ]; then sleep 30; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"\n`)
chmodSync(join(slowBin, 'git'), 0o755)

const scratchStores = (): string[] => (existsSync(scratchTmp) ? readdirSync(scratchTmp).filter(name => name.startsWith('gate-tree-')) : [])

process.env.TMPDIR = scratchTmp
process.env.PATH = `${slowBin}:${process.env.PATH ?? ''}`
const { computeWorkingTreeSha } = await import('../../src/utils/healthReport.ts')

section('§1 a check that gives up takes its temp object store with it')
const controller = new AbortController()
const startedAt = Date.now()
const settled = computeWorkingTreeSha(repo, { signal: controller.signal })
setTimeout(() => controller.abort(new Error('check timed out after 300ms')), 300)
const sha = await settled
const tookMs = Date.now() - startedAt
check('the tree read answers null once the check gives up', sha === null, String(sha))
check('…promptly, not after git\'s own timeout', tookMs < 10_000, `${tookMs} ms`)
check('no gate-tree-* store is left in the temp dir', scratchStores().length === 0, scratchStores().join(','))

section('§2 an exit before the read settles still removes the store')
const child = join(world, 'exit-mid-read.ts')
writeFileSync(
  child,
  [
    `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }`,
    `const { computeWorkingTreeSha } = await import(${JSON.stringify(join(ROOT, 'src', 'utils', 'healthReport.ts'))})`,
    `void computeWorkingTreeSha(${JSON.stringify(repo)})`,
    `setTimeout(() => process.exit(0), 1500)`,
    '',
  ].join('\n'),
)
const run = spawn(process.execPath, [child], { cwd: ROOT, env: { ...process.env, TMPDIR: scratchTmp, PATH: `${slowBin}:${process.env.PATH ?? ''}`, MERCURY_CONFIG_DIR: join(world, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
let childErr = ''
run.stderr.on('data', (c: Buffer) => (childErr += c.toString('utf8')))
const code = await new Promise<number | null>(resolve => run.on('close', resolve))
check('the child exited by itself', code === 0, `exit ${code}: ${childErr.slice(-300)}`)
check('its gate-tree-* store is gone after the exit', scratchStores().length === 0, scratchStores().join(','))

rmSync(world, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`} — prove-tree-scratch-cleanup`)
process.exit(failures === 0 ? 0 : 1)
