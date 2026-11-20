#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'
import { mountOffscreen, settle, waitFor } from '../lib/settingsPopupHarness.ts'

const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'prove-wider-w01-')))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
mkdirSync(home, { recursive: true })
mkdirSync(project, { recursive: true })

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as unknown as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '1.0.0' }
process.chdir(project)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { setProjectRoot } = await import('../../src/bootstrap/state.ts')
setProjectRoot(project)
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { pinsPath, readPins, usagePath, readUsage } = await import('../../src/mneme/mnemeUsage.ts')
const { libraryMetaPath, readLibraryMeta } = await import('../../src/mneme/mnemeLibrary.ts')
const { call: callMemoryCommand } = await import('../../src/commands/memory/memory.tsx')
const { MemoryCentreView } = await import('../../src/components/memory/MemoryCentreView.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { Box } = await import('../../src/ink.ts')

const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })

async function memoryStatsText(): Promise<string> {
  let reply = ''
  await callMemoryCommand(
    text => {
      reply = text ?? ''
    },
    { readFileState: new Map() as never, messages: [] },
    'stats',
  )
  return reply
}

async function renderMemoryCentre(): Promise<string> {
  const el = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(
      ThemeProvider as never,
      {},
      React.createElement(
        Box,
        { flexDirection: 'column', width: 200, height: 32 },
        React.createElement(MemoryCentreView, { onClose: () => {}, width: 196, rowBudget: 30 }),
      ),
    ),
  )
  const m = await mountOffscreen(el, 200, 32)
  await waitFor(() => m.screen().includes('facts and decisions'), 4000)
  await settle(100)
  const text = m.lines().map(l => l.trim()).join(' ')
  m.unmount()
  return text
}

try {
  section('§1 w01-1: unreadable pins.json, usage.json, library.json')
  {
    const p = pinsPath(dir)
    writeFileSync(p, '{not valid json')
    const pins = readPins(dir)
    check('corrupt pins.json still returns [] without throwing', pins.length === 0)
    const centre = await renderMemoryCentre()
    check(
      'Memory Centre note shows the unread sentence for corrupt pins.json',
      centre.includes(`${p} could not be read (`) && centre.includes('so what it holds is not shown — fix or remove the file.'),
      centre,
    )
    const stats = await memoryStatsText()
    check(
      '/memory stats shows the unread sentence for corrupt pins.json',
      stats.includes(`${p} could not be read (`) && stats.includes('so what it holds is not shown — fix or remove the file.'),
      stats,
    )
    unlinkSync(p)
    readPins(dir)
    const statsAfter = await memoryStatsText()
    check('removing corrupt pins.json clears the unread sentence on next read', !statsAfter.includes('could not be read'), statsAfter)

    const u = usagePath(dir)
    writeFileSync(u, '{not valid json')
    const usage = readUsage(dir)
    check('corrupt usage.json still returns {} without throwing', Object.keys(usage).length === 0)
    const centreUsage = await renderMemoryCentre()
    check(
      'Memory Centre note shows the unread sentence for corrupt usage.json',
      centreUsage.includes(`${u} could not be read (`) && centreUsage.includes('so what it holds is not shown — fix or remove the file.'),
      centreUsage,
    )
    writeFileSync(u, JSON.stringify({ version: 1, rows: {} }))
    readUsage(dir)
    const statsUsageAfter = await memoryStatsText()
    check('fixing usage.json clears the unread sentence', !statsUsageAfter.includes('could not be read'), statsUsageAfter)

    const l = libraryMetaPath(dir)
    writeFileSync(l, '{not valid json')
    const meta = readLibraryMeta(dir)
    check('corrupt library.json still returns fresh meta without throwing', meta.seqCounter === 0 && meta.lastConsolidatedAt === null)
    const statsLib = await memoryStatsText()
    check(
      '/memory stats shows the unread sentence for corrupt library.json',
      statsLib.includes(`${l} could not be read (`) && statsLib.includes('so what it holds is not shown — fix or remove the file.'),
      statsLib,
    )
    const centreLib = await renderMemoryCentre()
    check(
      'Memory Centre note shows the unread sentence for corrupt library.json',
      centreLib.includes(`${l} could not be read (`) && centreLib.includes('so what it holds is not shown — fix or remove the file.'),
      centreLib,
    )
    if (POSIX_MODES) {
      writeFileSync(l, JSON.stringify({ version: 1, seqCounter: 3, lastConsolidatedAt: null }), { mode: 0o600 })
      chmodSync(l, 0o200)
      try {
        readLibraryMeta(dir)
        const statsEacces = await memoryStatsText()
        check(
          '/memory stats shows the unread sentence for EACCES library.json',
          statsEacces.includes(`${l} could not be read (`) && statsEacces.includes('so what it holds is not shown — fix or remove the file.'),
          statsEacces,
        )
      } finally {
        chmodSync(l, 0o600)
      }
    }
    writeFileSync(l, JSON.stringify({ version: 1, seqCounter: 3, lastConsolidatedAt: null }))
    readLibraryMeta(dir)
    const statsLibAfter = await memoryStatsText()
    check('fixing library.json clears the unread sentence', !statsLibAfter.includes('could not be read'), statsLibAfter)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall checks passed')
process.exit(0)
