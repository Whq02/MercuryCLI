import React from 'react'
import { mock } from 'bun:test'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('workflow-liveness-refresh')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail !== '' ? `\n${detail}` : ''}`)
  if (!ok) failures++
}
await import('../../src/tools/AgentTool/AgentTool.js')
const runView = await import('../../src/components/tasks/RunDetailPane.js')
const manifests = await import('../../src/tools/WorkflowTool/runManifest.js')
let alive = true
let listings = 0
const record = { version: 1, runId: 'fixture-run', runDir: home, title: 'fixture workflow', startTime: Date.now() - 120000, status: 'running', ownerPid: 987654, agentCount: 0, totalTokens: 0, totalToolCalls: 0, agents: [], mtimeMs: Date.now() - 60000 }
mock.module('../../src/components/tasks/RunDetailPane.js', () => ({ ...runView, pidAlive: () => alive }))
mock.module('../../src/tools/WorkflowTool/runManifest.js', () => ({
  ...manifests,
  listWorkflowRunsDetailed: async () => { listings++; return { rows: [{ ...record }], unreadable: 0 } },
}))
const { WorkflowsBoard } = await import('../../src/components/tasks/WorkflowsBoard.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
const { Box } = await import('../../src/ink.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const view = await mountOffscreen(<AppStateProvider><ThemeProvider><KeybindingSetup><Box width={120} height={40} flexDirection="column"><WorkflowsBoard onClose={() => {}} /></Box></KeybindingSetup></ThemeProvider></AppStateProvider>, 120, 40)
try {
  await waitFor(() => listings > 0, 3000)
  await settle(300)
  view.push(KEY.down)
  await settle(100)
  view.push(KEY.down)
  await settle(100)
  check('a silent live owner starts as wedged on the external board', await waitFor(() => view.screen().includes('wedged'), 3000))
  const before = listings
  alive = false
  check('the manifest poll runs again even though no file facts changed', await waitFor(() => listings > before, 6000))
  check('owner death changes the unchanged manifest to stale without reopening', await waitFor(() => view.screen().includes('stale') && !view.screen().includes('wedged'), 1500), view.screen())
} finally {
  view.unmount()
  await settle(50)
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
