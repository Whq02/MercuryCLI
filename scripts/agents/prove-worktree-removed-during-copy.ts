#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mock } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneRoadExpected, volumeClones } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const road = process.argv[2]
if (road !== undefined) {
  const action = process.argv[3] as string
  const scratch = process.argv[4] as string
  const repo = join(scratch, 'repo')
  const outside = join(scratch, 'outside')
  mkdirSync(join(repo, 'node_modules'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.mercury/\n')
  writeFileSync(join(repo, 'node_modules', 'file'), 'dependency')
  writeFileSync(join(outside, 'personal'), 'keep me')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'main'); git('add', '.gitignore'); git('commit', '-qm', 'fixture')
  let release!: () => void
  let announce!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { announce = resolve })
  if (road === 'walk') {
    process.env.MERCURY_WORKTREE_CLONE = 'files'
    const copy = promises.copyFile
    mock.module('node:fs/promises', () => ({ ...promises, copyFile: async (...args: Parameters<typeof copy>): ReturnType<typeof copy> => {
      await copy(...args)
      if (String(args[1]).includes('.clone-probe-')) { announce(); await held }
    } }))
  } else {
    if (road === 'cp') process.env.MERCURY_WORKTREE_CLONE = 'cp'
    else delete process.env.MERCURY_WORKTREE_CLONE
    const exec = await import('../../src/utils/execFileNoThrow.ts')
    const original = exec.execFileNoThrowWithCwd
    mock.module('../../src/utils/execFileNoThrow.ts', () => ({ ...exec, execFileNoThrowWithCwd: async (...args: Parameters<typeof original>): ReturnType<typeof original> => {
      if (args[0] === '/usr/bin/osascript' || (args[0] === 'cp' && args[1][0] === '-a')) { announce(); await held }
      return original(...args)
    } }))
  }
  const state = await import('../../src/bootstrap/state.ts')
  const config = await import('../../src/utils/config/globalConfig.ts')
  const wt = await import('../../src/utils/worktree.ts')
  process.chdir(repo); state.setOriginalCwd(repo); state.setCwdState(repo); state.setIsInteractive(true); config.enableConfigs()
  const made = await wt.createAgentWorktree('agent-a123abcd', { foldersBehindLaunch: true })
  await started
  await wt.unlockAgentWorktree(made.worktreePath, repo)
  git('worktree', 'remove', made.worktreePath)
  const removed = !existsSync(made.worktreePath)
  if (action === 'link') symlinkSync(outside, made.worktreePath, 'dir')
  if (action === 'new') { mkdirSync(made.worktreePath); writeFileSync(join(made.worktreePath, 'personal'), 'keep me') }
  release()
  await made.ready
  const rootKept = action === 'gone' ? !existsSync(made.worktreePath) : action === 'link' ? lstatSync(made.worktreePath).isSymbolicLink() : readdirSync(made.worktreePath).join(',') === 'personal' && readFileSync(join(made.worktreePath, 'personal'), 'utf8') === 'keep me'
  console.log('RESULT ' + JSON.stringify({ removed, rootKept, outsideKept: readdirSync(outside).join(',') === 'personal' && readFileSync(join(outside, 'personal'), 'utf8') === 'keep me', sourceKept: readFileSync(join(repo, 'node_modules', 'file'), 'utf8') === 'dependency', staged: readdirSync(dirname(made.worktreePath)).filter(name => name.startsWith('.cloning-')), failure: made.prepareFailure ?? null }))
  process.exit(0)
}
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-removed-copy-')))
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ' — ' + detail : ''}`); if (!ok) failures++ }
try {
  const roads: string[] = []
  if (cloneRoadExpected(scratch)) roads.push(process.platform === 'darwin' ? 'apfs' : 'cp')
  if (process.platform !== 'win32' && volumeClones(scratch)) roads.push('walk')
  if (roads.length === 0) console.log('  [SKIP] this volume or platform cannot clone: there is no pending private copy')
  for (const mode of roads) for (const action of ['gone', 'link', 'new']) {
    const place = join(scratch, mode + '-' + action)
    mkdirSync(place)
    const child = spawnSync(process.execPath, [import.meta.path, mode, action, place], { cwd: ROOT, env: process.env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' })
    const line = child.stdout.split('\n').find(row => row.startsWith('RESULT '))
    check(`${mode}/${action}: the held copy finishes after the removal`, child.status === 0 && line !== undefined, child.stderr)
    if (line === undefined) continue
    const result = JSON.parse(line.slice(7)) as { removed: boolean; rootKept: boolean; outsideKept: boolean; sourceKept: boolean; staged: string[]; failure: unknown }
    check(`${mode}/${action}: the registered worktree was removed while the copy waited`, result.removed)
    check(`${mode}/${action}: the removed or replaced root is left alone`, result.rootKept, line)
    check(`${mode}/${action}: no clone or link is written through the replacement`, result.outsideKept, line)
    check(`${mode}/${action}: the checkout stays whole and staging is discarded`, result.sourceKept && result.staged.length === 0 && result.failure === null, line)
  }
} finally { process.chdir(ROOT); rmSync(scratch, { recursive: true, force: true }) }
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
