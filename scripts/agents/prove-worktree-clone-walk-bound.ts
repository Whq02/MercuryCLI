#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mock } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { volumeClones } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const files = (root: string): string[] => {
  const rows: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), rel)
      else rows.push(rel)
    }
  }
  if (present(root) && lstatSync(root).isDirectory()) walk(root, '')
  return rows
}
const staged = (home: string): string[] => (existsSync(home) ? readdirSync(home).filter(name => name.startsWith('.cloning-')) : [])

const scenario = process.argv[2]
if (scenario !== undefined) {
  const dir = process.argv[3] as string
  const realCopy = fsPromises.copyFile
  mock.module('node:fs/promises', () => ({
    ...fsPromises,
    copyFile: (from: string, to: string, mode?: number): Promise<void> => {
      if (basename(to).startsWith('.clone-probe-')) return realCopy(from, to, mode)
      if (scenario === 'slow') return wait(300).then(() => realCopy(from, to, mode))
      if (basename(from) === 'stuck.js') return new Promise<void>(() => {})
      return realCopy(from, to, mode)
    },
  }))
  process.env.MERCURY_WORKTREE_CLONE = 'files'
  const started = performance.now()
  const took = (): number => Math.round(performance.now() - started)
  if (scenario === 'launch') {
    const state = await import('../../src/bootstrap/state.ts')
    const config = await import('../../src/utils/config/globalConfig.ts')
    const { createAgentWorktree } = await import('../../src/utils/worktree.ts')
    process.chdir(dir)
    state.setOriginalCwd(dir)
    state.setCwdState(dir)
    state.setIsInteractive(true)
    config.enableConfigs()
    const made = await createAgentWorktree('agent-af100001')
    const ms = took()
    await wait(1500)
    const link = (rel: string): boolean => present(join(made.worktreePath, rel)) && lstatSync(join(made.worktreePath, rel)).isSymbolicLink() && realpathSync(join(made.worktreePath, rel)) === realpathSync(join(dir, rel))
    console.log('RESULT ' + JSON.stringify({ ms, dependencies: link('node_modules'), pack: link('vendor/pack-a'), failure: made.prepareFailure ?? null, staged: staged(dirname(made.worktreePath)), tracked: present(join(made.worktreePath, 'package.json')) }))
    process.exit(0)
  }
  const { cloneIntoWorktree } = (await import('../../src/utils/worktreeClone.ts')) as unknown as { cloneIntoWorktree: (pairs: unknown, checkout: string, worktree: string, bound?: number) => Promise<string[]> }
  const home = join(dir, '.mercury', 'worktrees')
  const first = join(home, 'agent-af000001')
  mkdirSync(first, { recursive: true })
  const outcome = await cloneIntoWorktree([{ source: join(dir, 'node_modules'), target: join(first, 'node_modules') }], dir, first, scenario === 'slow' ? 2000 : 1500)
  const ms = took()
  if (scenario === 'slow') {
    console.log('RESULT ' + JSON.stringify({ ms, outcome: outcome[0], whole: JSON.stringify(files(join(first, 'node_modules'))) === JSON.stringify(files(join(dir, 'node_modules'))), staged: staged(home) }))
    process.exit(0)
  }
  const end = Date.now() + 5000
  while (staged(home).length > 0 && Date.now() < end) await wait(50)
  const second = join(home, 'agent-af000002')
  mkdirSync(second, { recursive: true })
  const again = performance.now()
  const next = await cloneIntoWorktree([{ source: join(dir, 'node_modules'), target: join(second, 'node_modules') }], dir, second, 1500)
  console.log('RESULT ' + JSON.stringify({ ms, outcome: outcome[0], atName: present(join(first, 'node_modules')), staged: staged(home), nextOutcome: next[0], nextMs: Math.round(performance.now() - again), nextAtName: present(join(second, 'node_modules')) }))
  process.exit(0)
}

process.chdir(ROOT)
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const skip = (label: string): void => console.log(`  [SKIP] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-walk-bound-')))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const fill = (dir: string, folders: number, each: number, stuck: boolean): void => {
  for (let folder = 0; folder < folders; folder++) {
    mkdirSync(join(dir, 'node_modules', `pkg-${folder}`, 'lib'), { recursive: true })
    for (let index = 0; index < each; index++) writeFileSync(join(dir, 'node_modules', `pkg-${folder}`, 'lib', `m${index}.js`), `module.exports = ${folder * 100 + index}\n`)
  }
  if (stuck) writeFileSync(join(dir, 'node_modules', 'pkg-1', 'lib', 'stuck.js'), 'module.exports = "the call for this file never answers"\n')
  mkdirSync(join(dir, 'node_modules', '.bin'))
  symlinkSync('../pkg-0/lib/m0.js', join(dir, 'node_modules', '.bin', 'tool'))
}
const run = (name: string, dir: string, killAfterMs: number): { result: Record<string, unknown> | null; waited: number; tail: string } => {
  const started = Date.now()
  const child = spawnSync(process.execPath, [import.meta.path, name, dir], { encoding: 'utf8', timeout: killAfterMs, killSignal: 'SIGKILL', env: { ...process.env } })
  const line = (child.stdout ?? '').split('\n').find(row => row.startsWith('RESULT '))
  return { result: line === undefined ? null : (JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>), waited: Date.now() - started, tail: `${child.stdout ?? ''}${child.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ').slice(0, 400) }
}

try {
  if (!(volumeClones(scratch) && process.platform !== 'win32')) {
    section('a volume that cannot clone: the walk is refused at its first file and never runs')
    skip("the proof's runtime cannot force a clone of one file here: there is no walk to go quiet")
  } else {
    section('§1 a walk that keeps moving is never given up, however long it takes')
    const slowDir = join(scratch, 'slow')
    mkdirSync(slowDir)
    fill(slowDir, 8, 8, false)
    const slow = run('slow', slowDir, 120_000)
    console.log(`  64 files whose clone takes 300 ms each, sixteen at once, under a bound of 2,000 ms of quiet: the walk took ${String(slow.result?.ms)} ms`)
    check('the folder is cloned whole though the walk outlasts the bound', slow.result !== null && slow.result.outcome === 'cloned' && slow.result.whole === true && Number(slow.result.ms) > 2000, slow.tail)
    check('…and nothing is left beside the copy', slow.result !== null && (slow.result.staged as string[]).length === 0, slow.tail)

    section('§2 a walk in which one call never answers is given up once nothing has moved for the bound')
    const stuckDir = join(scratch, 'stuck')
    mkdirSync(stuckDir)
    fill(stuckDir, 4, 6, true)
    const stuck = run('stuck', stuckDir, 30_000)
    console.log(stuck.result === null ? `  the walk had not answered after ${stuck.waited} ms and was ended by the proof` : `  one of 25 files never answers, bound 1,500 ms of quiet: answered for after ${String(stuck.result.ms)} ms`)
    check('the clone is answered for, not waited on for ever', stuck.result !== null, `no answer in ${stuck.waited} ms: ${stuck.tail}`)
    check('…as a clone that failed, so the caller makes the link as before', stuck.result !== null && stuck.result.outcome === 'failed', JSON.stringify(stuck.result))
    check('…with nothing at the folder\'s name and nothing left beside the copy', stuck.result !== null && stuck.result.atName === false && (stuck.result.staged as string[]).length === 0, JSON.stringify(stuck.result))
    check('a second folder asked for between the same volumes is not walked again in that process: it is answered at once and nothing is made', stuck.result !== null && stuck.result.nextOutcome === 'unsupported' && stuck.result.nextAtName === false && Number(stuck.result.nextMs) < Number(stuck.result.ms), JSON.stringify(stuck.result))

    section('§3 a copy asked for over such a folder is made, with the links, ten seconds later')
    const repo = join(scratch, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\nvendor/*/\n.mercury/\n')
    writeFileSync(join(repo, 'package.json'), '{"name":"walk-bound"}\n')
    mkdirSync(join(repo, 'vendor'))
    writeFileSync(join(repo, 'vendor', 'pack-a.lock.json'), '{}\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'first')
    fill(repo, 4, 6, true)
    mkdirSync(join(repo, 'vendor', 'pack-a'))
    writeFileSync(join(repo, 'vendor', 'pack-a', 'marker'), 'pack\n')
    const launch = run('launch', repo, 60_000)
    console.log(launch.result === null ? `  the copy had not been made after ${launch.waited} ms and the proof ended the wait` : `  the copy was handed back after ${String(launch.result.ms)} ms`)
    check('the copy is handed back, with its tracked files', launch.result !== null && launch.result.tracked === true, `no answer in ${launch.waited} ms: ${launch.tail}`)
    check('…after the ten seconds of quiet and not before', launch.result !== null && Number(launch.result.ms) >= 10_000, JSON.stringify(launch.result))
    check('its dependency folder is the link to the checkout\'s, as after any clone that fails', launch.result !== null && launch.result.dependencies === true, JSON.stringify(launch.result))
    check('…and so is the pack, without a second wait', launch.result !== null && launch.result.pack === true && Number(launch.result.ms) < 20_000, JSON.stringify(launch.result))
    check('no failure is reported and nothing is left beside the copy', launch.result !== null && launch.result.failure === null && (launch.result.staged as string[]).length === 0, JSON.stringify(launch.result))
    const source = readFileSync(join(ROOT, 'src/utils/worktreeClone.ts'), 'utf8')
    check('the bound is ten seconds in which nothing moved, or the caller\'s own bound when that is shorter', source.includes('const WALK_QUIET_BOUND_MS = 10_000') && source.includes('const quietBoundMs = Math.min(answerBoundMs, WALK_QUIET_BOUND_MS)'))
  }
} finally {
  if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
  rmSync(scratch, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
