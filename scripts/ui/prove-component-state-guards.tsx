import React from 'react'
import { mock } from 'bun:test'
import { join } from 'node:path'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('component-state-guards')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}

let session = { originalCwd: process.cwd(), worktreePath: join(home, 'worktree'), worktreeBranch: 'fixture', originalHeadCommit: 'base', worktreeName: 'fixture', sessionId: 'fixture-session' }
let statusCode = 0
let countCode = 0
let countText = '0'
let changed = ''
let removed = 0
const checkedDirectories: string[] = []
const worktrees = await import('../../src/utils/worktree.js')
const realCleanup = worktrees.cleanupWorktree
const realCurrent = worktrees.getCurrentWorktreeSession
let realRemoval = false
let removalError = ''
let exitsRecorded = 0
const execution = await import('../../src/utils/execFileNoThrow.js')
const logs = await import('../../src/utils/sessionStorage/logs.js')
const runCommand = execution.execFileNoThrowWithCwd
mock.module('../../src/utils/worktree.js', () => ({
  ...worktrees,
  getCurrentWorktreeSession: () => session,
  cleanupWorktree: async () => { removed++; if (realRemoval) await realCleanup() },
  keepWorktree: async () => {},
}))
mock.module('../../src/utils/execFileNoThrow.js', () => ({
  ...execution,
  execFileNoThrow: async () => ({ code: 0, stdout: '', stderr: '' }),
  execFileNoThrowWithCwd: async (_command: string, args: string[], options: { cwd: string }) => {
    if (args[0] === 'worktree' && removalError !== '') return { code: 128, stdout: '', stderr: removalError }
    if (realRemoval) return runCommand(_command, args, options)
    checkedDirectories.push(options.cwd)
    return args[0] === 'status'
      ? { code: statusCode, stdout: changed, stderr: '' }
      : { code: countCode, stdout: countText, stderr: '' }
  },
}))
mock.module('../../src/utils/sessionStorage/logs.js', () => ({ ...logs, saveWorktreeState: () => { exitsRecorded++ } }))

const { ValidationErrorsList } = await import('../../src/components/ValidationErrorsList.js')
const { WorktreeExitDialog } = await import('../../src/components/WorktreeExitDialog.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { Box } = await import('../../src/ink.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const mount = (element: React.ReactNode) => mountOffscreen(<AppStateProvider><ThemeProvider><KeybindingSetup><Box width={100} height={24} flexDirection="column">{element}</Box></KeybindingSetup></ThemeProvider></AppStateProvider>, 100, 24)

try {
  const property = '__mercury_validation_fixture__'
  const prototype = Object.prototype as Record<string, unknown>
  check('prototype fixture starts absent', !Object.hasOwn(prototype, property))
  const validation = await mount(<ValidationErrorsList errors={[
    { path: `__proto__.${property}`, message: 'validation fixture' },
    { path: 'view.__proto__.nested', message: 'nested fixture' },
  ]} />)
  const painted = await waitFor(() => validation.screen().includes('validation fixture') && validation.screen().includes('nested fixture'), 3000)
  check('validation paths cannot write Object.prototype', !Object.hasOwn(prototype, property) && !Object.hasOwn(prototype, 'nested'))
  check('prototype-named paths still render their own errors', painted)
  validation.unmount()
  await settle(50)
  delete prototype[property]
  delete prototype.nested

  for (const scenario of [
    { name: 'changed tree', status: 0, count: 0, text: '0', changed: ' M tracked.ts\n', expected: 0 },
    { name: 'failed status', status: 128, count: 0, text: '0', changed: '', expected: 0 },
    { name: 'failed commit count', status: 0, count: 128, text: '', changed: '', expected: 0 },
    { name: 'invalid commit count', status: 0, count: 0, text: 'unknown', changed: '', expected: 0 },
    { name: 'clean tree', status: 0, count: 0, text: '0', changed: '', expected: 1 },
  ]) {
    statusCode = scenario.status
    countCode = scenario.count
    countText = scenario.text
    changed = scenario.changed
    removed = 0
    checkedDirectories.length = 0
    const view = await mount(<WorktreeExitDialog onDone={() => {}} />)
    await waitFor(() => scenario.expected === 0 ? view.screen().includes('Keep worktree') : removed === 1, 3000)
    check(`${scenario.name}: probes the session worktree, not process.cwd()`, checkedDirectories.length === 2 && checkedDirectories.every(path => path === session.worktreePath))
    check(`${scenario.name}: only proven empty work is silently removed`, removed === scenario.expected)
    const outAt = process.argv.indexOf('--out')
    if (outAt >= 0) {
      const output = process.argv[outAt + 1]!
      mkdirSync(output, { recursive: true })
      writeFileSync(join(output, `${scenario.name.replaceAll(' ', '-')}.txt`), view.screen())
    }
    if (scenario.expected === 0) check(`${scenario.name}: keeps the choice available`, view.screen().includes('Keep worktree'))
    view.unmount()
    await settle(50)
  }
  const root = join(home, 'repo')
  mkdirSync(root)
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  git(['init', '-q'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
  const parent = join(root, 'trees')
  mkdirSync(parent)
  const bootstrap = await import('../../src/bootstrap/state.js')
  const { getCurrentProjectConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
  bootstrap.setOriginalCwd(root)
  bootstrap.setProjectRoot(root)
  bootstrap.setCwdState(root)
  realRemoval = true
  for (const scenario of ['read-only parent', 'file held open', 'successful removal']) {
    const slug = scenario.replaceAll(' ', '-')
    const path = join(parent, slug)
    git(['worktree', 'add', '-qb', slug, path])
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
    session = { originalCwd: root, worktreePath: path, worktreeBranch: slug, originalHeadCommit: sha, worktreeName: slug, sessionId: 'fixture-session' }
    worktrees.restoreWorktreeSession(session)
    saveCurrentProjectConfig(c => ({ ...c, activeWorktreeSession: { originalCwd: root, worktreePath: path, worktreeName: slug, sessionId: session.sessionId } }))
    const expectedFailure = scenario !== 'successful removal'
    if (scenario === 'read-only parent' && process.platform !== 'win32') chmodSync(parent, 0o555)
    removalError = scenario === 'file held open' ? `fatal: failed to delete '${path}': Device or resource busy` : process.platform === 'win32' && scenario === 'read-only parent' ? `fatal: failed to delete '${path}': Permission denied` : ''
    if (scenario === 'file held open') writeFileSync(join(path, 'held.txt'), 'keep this file')
    exitsRecorded = 0
    let result: string | undefined
    let reported = 0
    const view = await mount(<WorktreeExitDialog onDone={message => { result = message; reported++ }} />)
    if (scenario === 'file held open') {
      check('a held file presents the existing remove choice', await waitFor(() => view.screen().includes('Remove worktree'), 3000))
      view.push(KEY.down)
      await settle(80)
      view.push(KEY.enter)
    }
    await waitFor(() => result !== undefined, 4000)
    if (expectedFailure) {
      check(`${scenario}: the failure row carries the OS reason, not Removed`, result !== undefined && !result.startsWith('Removed') && /Permission denied|Device or resource busy/.test(result))
      check(`${scenario}: the row names the tree and a retry action`, result !== undefined && result.includes(path) && /retry|try again/i.test(result))
      check(`${scenario}: the tree and session record stay`, existsSync(path) && realCurrent()?.worktreePath === path && getCurrentProjectConfig().activeWorktreeSession?.worktreePath === path)
      check(`${scenario}: session history is not cleared`, exitsRecorded === 0)
      if (scenario === 'file held open') check('the held file is untouched', readFileSync(join(path, 'held.txt'), 'utf8') === 'keep this file')
    } else {
      check('successful removal reports Removed once', result?.startsWith('Removed') === true && reported === 1)
      check('successful removal clears the tree and both records', !existsSync(path) && realCurrent() === null && getCurrentProjectConfig().activeWorktreeSession === undefined && exitsRecorded === 1)
    }
    view.unmount()
    if (process.platform !== 'win32') chmodSync(parent, 0o755)
    removalError = ''
    rmSync(path, { recursive: true, force: true })
    git(['worktree', 'prune'])
    worktrees.restoreWorktreeSession(null)
  }
} finally {
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
