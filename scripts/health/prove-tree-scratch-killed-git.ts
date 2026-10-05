#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomFillSync } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const world = realpathSync(mkdtempSync(join(tmpdir(), 'tree-scratch-killed-')))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const gitIn = (dir: string, args: string[], extraEnv: Record<string, string> = {}): string =>
  execFileSync('git', ['-C', dir, ...args], { env: { ...gitEnv, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const seed = (dir: string): void => {
  mkdirSync(dir)
  gitIn(dir, ['init', '-q'])
  gitIn(dir, ['config', 'core.looseCompression', '9'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  gitIn(dir, ['add', 'README.md'])
  gitIn(dir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'first'])
}

const repo = join(world, 'repo')
seed(repo)
mkdirSync(join(repo, 'big'))
const block = Buffer.allocUnsafe(1024 * 1024)
for (const name of ['a.bin', 'b.bin']) {
  const fd = openSync(join(repo, 'big', name), 'w')
  for (let i = 0; i < 64; i++) writeSync(fd, randomFillSync(block))
  closeSync(fd)
}

const holdScript = join(world, 'hold.js')
writeFileSync(holdScript, ["process.stdout.write('held\\n')", 'setTimeout(() => {}, 1500)', ''].join('\n'))

const exitScript = join(world, 'exit-with-reads.js')
writeFileSync(
  exitScript,
  [
    `import { spawn } from 'node:child_process'`,
    `import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'`,
    `import { join } from 'node:path'`,
    `globalThis.MACRO = { VERSION: '1.0.0' }`,
    `const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))`,
    `const { computeWorkingTreeSha } = await import(plan.module)`,
    `const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))`,
    `const stores = dir => readdirSync(dir).filter(entry => entry.startsWith('gate-tree-'))`,
    `const gaveUp = []`,
    `for (const job of plan.jobs) {`,
    `  mkdirSync(job.dir)`,
    `  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = job.dir`,
    `  process.env.PATH = job.path`,
    `  const controller = new AbortController()`,
    `  void computeWorkingTreeSha(plan.repo, { signal: controller.signal })`,
    `  while (!stores(job.dir).some(entry => existsSync(join(job.dir, entry, 'index')) && existsSync(join(job.dir, entry, 'index.lock')))) await sleep(5)`,
    `  if (job.pinned) {`,
    `    const holder = spawn(process.execPath, [plan.hold], { cwd: join(job.dir, stores(job.dir)[0], 'objects'), stdio: ['ignore', 'pipe', 'ignore'] })`,
    `    await new Promise(resolve => holder.stdout.once('data', resolve))`,
    `  }`,
    `  if (job.giveUp) gaveUp.push(controller)`,
    `}`,
    `for (const controller of gaveUp) controller.abort(new Error('check timed out after 10000ms'))`,
    `process.exit(0)`,
    '',
  ].join('\n'),
)

const useScratch = (name: string): string => {
  const dir = join(world, name)
  mkdirSync(dir)
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = dir
  return dir
}
const storesIn = (dir: string): string[] => readdirSync(dir).filter(entry => entry.startsWith('gate-tree-'))
const adding = (dir: string): boolean => storesIn(dir).some(entry => existsSync(join(dir, entry, 'index')) && existsSync(join(dir, entry, 'index.lock')))
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(5)
  }
  return cond()
}
const withPath = async <T>(pathValue: string, run: () => Promise<T>): Promise<T> => {
  const saved = process.env.PATH ?? ''
  process.env.PATH = pathValue
  try {
    return await run()
  } finally {
    process.env.PATH = saved
  }
}
const finished = (child: ChildProcess): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', () => resolve()))

const launcherDir = ((): string | null => {
  if (process.platform !== 'win32') return null
  const dir = join(dirname(dirname(dirname(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()))), 'cmd')
  return existsSync(join(dir, 'git.exe')) ? dir : null
})()
const hostPath = process.env.PATH ?? ''
const roads: Array<{ name: string; path: string }> = [{ name: 'git as found on PATH', path: hostPath }]
if (launcherDir !== null) {
  const others = hostPath.split(delimiter).filter(entry => entry !== '' && !existsSync(join(entry, 'git.exe')))
  roads.push({ name: 'Git for Windows launcher first', path: [launcherDir, ...others].join(delimiter) })
}

const { computeWorkingTreeSha } = await import('../../src/utils/healthReport.ts')

section('§1 a read that finishes returns the tree git itself writes and leaves no store behind')
{
  const small = join(world, 'small')
  seed(small)
  writeFileSync(join(small, 'untracked.txt'), 'new work\n')
  const index = join(world, 'small.index')
  gitIn(small, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: index })
  gitIn(small, ['add', '-A'], { GIT_INDEX_FILE: index })
  const expected = gitIn(small, ['write-tree'], { GIT_INDEX_FILE: index })
  const dir = useScratch('finish')
  const sha = await computeWorkingTreeSha(small)
  check('the tree read answers the tree git itself writes', sha === expected, `${sha} vs ${expected}`)
  check('no gate-tree-* store is left when the read returns', storesIn(dir).length === 0, storesIn(dir).join(','))
}

section('§2 a check that gives up on a read in git add leaves no store behind')
for (const road of roads) {
  const dir = useScratch(`give-up-${roads.indexOf(road)}`)
  const outcome = await withPath(road.path, async () => {
    const controller = new AbortController()
    const settled = computeWorkingTreeSha(repo, { signal: controller.signal })
    const inAdd = await until(() => adding(dir), 60_000)
    controller.abort(new Error('check timed out after 10000ms'))
    const sha = await settled
    return { inAdd, sha, left: storesIn(dir) }
  })
  check(`[${road.name}] the read was inside git add when the check gave up`, outcome.inAdd)
  check(`[${road.name}] the tree read answers null once the check gives up`, outcome.sha === null, String(outcome.sha))
  check(`[${road.name}] no gate-tree-* store is left when the read returns`, outcome.left.length === 0, outcome.left.join(','))
}

section('§3 a store something still holds after the check gave up is waited out, not abandoned')
{
  const dir = useScratch('pinned')
  const controller = new AbortController()
  const settled = computeWorkingTreeSha(repo, { signal: controller.signal })
  await until(() => storesIn(dir).some(entry => existsSync(join(dir, entry, 'objects'))), 60_000)
  const holder = spawn(process.execPath, [holdScript], { cwd: join(dir, storesIn(dir)[0]!, 'objects'), stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>(resolve => holder.stdout!.once('data', () => resolve()))
  controller.abort(new Error('check timed out after 10000ms'))
  await settled
  const left = storesIn(dir)
  check('no gate-tree-* store is left when the read returns', left.length === 0, left.join(','))
  await finished(holder)
}

section('§4 an exit right after the checks gave up, or while reads still run, leaves no store behind')
{
  const jobs = [
    ...roads.flatMap((road, index) => [
      { label: `[${road.name}] a read the check gave up on`, dir: join(world, `exit-gave-up-${index}`), path: road.path, pinned: false, giveUp: true },
      { label: `[${road.name}] a read still running`, dir: join(world, `exit-running-${index}`), path: road.path, pinned: false, giveUp: false },
    ]),
    { label: '[a process still holding the store] a read the check gave up on', dir: join(world, 'exit-pinned'), path: hostPath, pinned: true, giveUp: true },
  ]
  const planFile = join(world, 'plan.json')
  writeFileSync(planFile, JSON.stringify({ module: join(ROOT, 'src', 'utils', 'healthReport.ts'), repo, hold: holdScript, jobs }))
  const run = spawn(process.execPath, [exitScript, planFile], { cwd: ROOT, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe'], timeout: 180_000 })
  let err = ''
  run.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')))
  const code = await new Promise<number | null>(resolve => run.on('close', resolve))
  check('the child exited by itself', code === 0, `exit ${code}: ${err.slice(-300)}`)
  for (const job of jobs) {
    const left = existsSync(job.dir) ? storesIn(job.dir) : ['(never started)']
    check(`${job.label}: its gate-tree-* store is gone after the exit`, left.length === 0, left.join(','))
  }
}

for (let attempt = 0; attempt < 90 && existsSync(world); attempt++) {
  try {
    rmSync(world, { recursive: true, force: true })
  } catch {
    await sleep(1000)
  }
}
if (existsSync(world)) console.log(`  (left behind: ${world})`)
console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`} — prove-tree-scratch-killed-git`)
process.exit(failures === 0 ? 0 : 1)
