import React from 'react'
import { mock } from 'bun:test'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('task-recency-expiry')
const tasksModule = await import('../../src/utils/tasks.js')
mock.module('../../src/utils/tasks.js', () => ({ ...tasksModule, isTaskToolsEnabled: () => true }))
const { TaskListV2 } = await import('../../src/components/TaskListV2.js')
const { Box } = await import('../../src/ink.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const realNow = Date.now
const realTimeout = globalThis.setTimeout
const realClear = globalThis.clearTimeout
let now = realNow()
const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>()
Date.now = () => now
globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
  if (delay !== undefined && delay >= 1000 && delay <= 30_000) {
    const handle = realTimeout(() => {}, 60_000)
    timers.set(handle, { at: now + delay, run: () => callback(...args) })
    return handle
  }
  return realTimeout(callback, delay, ...args)
}) as typeof setTimeout
globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
  timers.delete(handle)
  realClear(handle)
}) as typeof clearTimeout
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
type Task = React.ComponentProps<typeof TaskListV2>['tasks'][number]
let rows: Task[] = [
  { id: '1', status: 'pending', subject: 'pending one' },
  { id: '2', status: 'pending', subject: 'pending two' },
  { id: '3', status: 'pending', subject: 'pending three' },
  { id: '4', status: 'pending', subject: 'first completion' },
  { id: '5', status: 'pending', subject: 'second completion' },
]
const element = () => <ThemeProvider><TerminalSizeContext.Provider value={{ columns: 80, rows: 17 }}><Box width={80} height={17} flexDirection="column"><TaskListV2 tasks={rows} /></Box></TerminalSizeContext.Provider></ThemeProvider>
const view = await mountOffscreen(element(), 80, 17)
const elapse = async (ms: number): Promise<void> => {
  now += ms
  for (const [handle, timer] of [...timers]) {
    if (timer.at > now) continue
    timers.delete(handle)
    realClear(handle)
    timer.run()
  }
  await settle(100)
}
try {
  await settle(100)
  rows = rows.map(row => row.id === '4' ? { ...row, status: 'completed' } : row)
  view.resize(element(), 80, 17)
  await settle(100)
  await elapse(1000)
  rows = rows.map(row => row.id === '5' ? { ...row, status: 'completed' } : row)
  view.resize(element(), 80, 17)
  await settle(100)
  check('both new completions have priority', view.screen().includes('first completion') && view.screen().includes('second completion'))
  await elapse(29_000)
  check('the first completion expires', !view.screen().includes('first completion') && view.screen().includes('second completion'))
  await elapse(1000)
  check('the next expiry re-arms without a task-list change', !view.screen().includes('second completion') && view.screen().includes('pending three'))
} finally {
  view.unmount()
  for (const handle of timers.keys()) realClear(handle)
  Date.now = realNow
  globalThis.setTimeout = realTimeout
  globalThis.clearTimeout = realClear
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
