import React from 'react'
import { mock } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('component-state-guards')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}

const session = { originalCwd: process.cwd(), worktreePath: join(home, 'worktree'), worktreeBranch: 'fixture', originalHeadCommit: 'base' }
let statusCode = 0
let countCode = 0
let countText = '0'
let changed = ''
let removed = 0
const checkedDirectories: string[] = []
const worktrees = await import('../../src/utils/worktree.js')
const execution = await import('../../src/utils/execFileNoThrow.js')
const logs = await import('../../src/utils/sessionStorage/logs.js')
mock.module('../../src/utils/worktree.js', () => ({
  ...worktrees,
  getCurrentWorktreeSession: () => session,
  cleanupWorktree: async () => { removed++ },
  keepWorktree: async () => {},
}))
mock.module('../../src/utils/execFileNoThrow.js', () => ({
  ...execution,
  execFileNoThrow: async () => ({ code: 0, stdout: '', stderr: '' }),
  execFileNoThrowWithCwd: async (_command: string, args: string[], options: { cwd: string }) => {
    checkedDirectories.push(options.cwd)
    return args[0] === 'status'
      ? { code: statusCode, stdout: changed, stderr: '' }
      : { code: countCode, stdout: countText, stderr: '' }
  },
}))
mock.module('../../src/utils/sessionStorage/logs.js', () => ({ ...logs, saveWorktreeState: () => {} }))

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
} finally {
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
