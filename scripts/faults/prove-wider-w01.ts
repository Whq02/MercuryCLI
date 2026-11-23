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
const UNREAD_FIX =
  'the reader of that file in src/sessions/mneme must call recordMnemeUnread(path, error) on failure and clearMnemeUnread(path) on success (src/sessions/mneme/mnemeUnread.ts), and the screen must show mnemeUnreadSentence'
const CREW_NOTE_FIX =
  'the note comes from subagentMemoryLoadNote in src/tools/crewmate/subagentDoctrine.ts; check where src/tools/crewmate/call/call.ts and src/tools/crewmate/runCrewmate.ts use it when loadMemoryPrompt fails'
const PROBE_FIX =
  'the preserved-thinking row is built in src/platform/health/sections/memory.ts from readThinkingDropLedger in src/models/roads/anthropic/thinkingBinding.ts'
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}${!cond && hint ? ` — to fix: ${hint}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { setProjectRoot } = await import('../../src/boot/process-state/processState.ts')
setProjectRoot(project)
const { mnemeLibraryDir } = await import('../../src/sessions/mneme/mnemeGates.ts')
const { mnemeUnreadSentence } = await import('../../src/sessions/mneme/mnemeUnread.ts')
const { lineagePath, mnemeProjectKey } = await import('../../src/sessions/mneme/paths.ts')
const { pinsPath, readPins, usagePath, readUsage } = await import('../../src/sessions/mneme/mnemeUsage.ts')
const { libraryMetaPath, readLibraryMeta } = await import('../../src/sessions/mneme/mnemeLibrary.ts')
const { readLedger } = await import('../../src/sessions/mneme/ledger.ts')
const { currentBufferPath, readBuffer, readConsumingRows } = await import('../../src/sessions/mneme/mnemeBuffer.ts')
const { currentLedger } = await import('../../src/sessions/mneme/mnemeFootnotes.ts')
const { frontPagePath, pinnedStatusPath, readPinnedStatus } = await import('../../src/sessions/mneme/mnemeFrontPage.ts')
const { handoverReceiptPath, readHandoverReceipt } = await import('../../src/sessions/mneme/mnemeHandover.ts')
const { readMaintenanceReceipts } = await import('../../src/sessions/mneme/mnemeMaintenance.ts')
const { journalPath, readJournal } = await import('../../src/sessions/mneme/journal.ts')
const { call: callMemoryCommand } = await import('../../src/commands/memory/memory.tsx')
const { MemoryCentreView } = await import('../../src/screen/memory/MemoryCentreView.tsx')
const { configMemoryRows } = await import('../../src/screen/settings/config/configRowsMemory.tsx')
const { memoryChecks } = await import('../../src/platform/health/sections/memory.ts')
const { runHealthReport } = await import('../../src/platform/health/healthReport.ts')
const { readThinkingDropLedger, thinkingDropLedgerPath } = await import('../../src/models/roads/anthropic/thinkingBinding.ts')
const { agentToolCall } = await import('../../src/tools/crewmate/call/call.ts')
const { agentToolResultBlock } = await import('../../src/tools/crewmate/call/resultBlock.ts')
const { runAgent } = await import('../../src/tools/crewmate/runCrewmate.ts')
const { MERCURY_CREW_AGENT } = await import('../../src/tools/crewmate/built-in/mercuryCrewAgent.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { tellTheToolTable } = await import('../../src/tools/kit/toolTable.ts')
const { getCommandQueueSnapshot, resetCommandQueue } = await import('../../src/daemon/runner/messageQueueManager.ts')
const { memoryLifecycleCheck } = await import('../../src/platform/health/sections/settings/prompt.ts')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { Box } = await import('../../src/screen/themedRenderer.ts')
const { dirname } = await import('node:path')

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
      UNREAD_FIX,
    )
    const stats = await memoryStatsText()
    check(
      '/memory stats shows the unread sentence for corrupt pins.json',
      stats.includes(`${p} could not be read (`) && stats.includes('so what it holds is not shown — fix or remove the file.'),
      stats,
      UNREAD_FIX,
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
      UNREAD_FIX,
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
      UNREAD_FIX,
    )
    const centreLib = await renderMemoryCentre()
    check(
      'Memory Centre note shows the unread sentence for corrupt library.json',
      centreLib.includes(`${l} could not be read (`) && centreLib.includes('so what it holds is not shown — fix or remove the file.'),
      centreLib,
      UNREAD_FIX,
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
          UNREAD_FIX,
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

  section('§2 w01-2: unreadable ledger, buffer, consuming rows, pinned status, handover, maintenance, journal')
  {
    const projectKey = mnemeProjectKey()
    const front = frontPagePath(dir)
    writeFileSync(front, '# Memory\n## Index\n- alpha (1 fact)\n')
    const memCheck = memoryChecks().find(c => c.id === 'memory')!
    const lifeCheck = memoryLifecycleCheck()

    const ps = pinnedStatusPath(dir)
    writeFileSync(ps, '{not json')
    check('corrupt pinned-status.json keeps readPinnedStatus null', readPinnedStatus(dir) === null)
    const memPinned = await memCheck.run()
    check(
      'memory health row warns with unread sentence for corrupt pinned-status.json',
      memPinned.status === 'warn' && memPinned.evidence.includes(`${ps} could not be read (`) && memPinned.evidence.includes('so what it holds is not shown — fix or remove the file.'),
      JSON.stringify(memPinned),
      UNREAD_FIX,
    )
    const cfgRows = configMemoryRows({
      config: {} as never,
      merged: {} as never,
      tokens: { warning: 'yellow', textSecondary: 'gray' } as never,
      boolValue: () => null,
      writeGlobal: () => {},
      writeSource: () => false,
      recordToggle: () => {},
      recordSet: () => {},
      bump: () => {},
      themeSetting: 'dark' as never,
    })
    const pinnedRow = cfgRows.find(r => r.id === 'memory.pinnedLimit')
    check(
      'configMemoryRows warning shows unread sentence for corrupt pinned-status.json',
      typeof pinnedRow?.warning === 'string' && pinnedRow.warning.includes(`${ps} could not be read (`) && !pinnedRow.warning.includes('0 rules pinned'),
      String(pinnedRow?.warning),
      UNREAD_FIX,
    )
    unlinkSync(ps)
    readPinnedStatus(dir)
    const memPinnedAfter = await memCheck.run()
    check('removing corrupt pinned-status.json restores memory health row to ok', memPinnedAfter.status === 'ok', JSON.stringify(memPinnedAfter))

    const ho = handoverReceiptPath(dir)
    writeFileSync(ho, '{not json')
    check('corrupt handover.json keeps readHandoverReceipt null', readHandoverReceipt(dir) === null)
    const memHandover = await memCheck.run()
    check(
      'memory health row warns with unread sentence for corrupt handover.json',
      memHandover.status === 'warn' && memHandover.evidence.includes(`${ho} could not be read (`) && memHandover.evidence.includes('so what it holds is not shown — fix or remove the file.'),
      JSON.stringify(memHandover),
      UNREAD_FIX,
    )
    unlinkSync(ho)
    readHandoverReceipt(dir)

    if (POSIX_MODES) {
      const bufPath = currentBufferPath(dir)
      writeFileSync(bufPath, '{"ts":"2026-01-01T00:00:00.000Z","source":"t","text":"hi"}\n', { mode: 0o600 })
      chmodSync(bufPath, 0o200)
      try {
        check('unreadable current.jsonl keeps readBuffer []', readBuffer(dir).length === 0)
        const lifeBuf = await lifeCheck.run()
        check(
          'memory-lifecycle health row warns with unread sentence for unreadable current.jsonl',
          lifeBuf.status === 'warn' && lifeBuf.evidence.includes(`${bufPath} could not be read (`) && lifeBuf.evidence.includes('so what it holds is not shown — fix or remove the file.'),
          JSON.stringify(lifeBuf),
          UNREAD_FIX,
        )
      } finally {
        chmodSync(bufPath, 0o600)
        unlinkSync(bufPath)
      }
      readBuffer(dir)

      const consPath = join(dir, 'consuming-1.jsonl')
      writeFileSync(consPath, '{"ts":"2026-01-01T00:00:00.000Z","source":"t","text":"hi"}\n', { mode: 0o600 })
      chmodSync(consPath, 0o200)
      try {
        check('unreadable consuming-*.jsonl keeps readConsumingRows []', readConsumingRows(dir).length === 0)
        const lifeCons = await lifeCheck.run()
        check(
          'memory-lifecycle health row warns with unread sentence for unreadable consuming-*.jsonl',
          lifeCons.status === 'warn' && lifeCons.evidence.includes(`${consPath} could not be read (`),
          JSON.stringify(lifeCons),
          UNREAD_FIX,
        )
      } finally {
        chmodSync(consPath, 0o600)
        unlinkSync(consPath)
      }
      readConsumingRows(dir)
      const lifeConsAfter = await lifeCheck.run()
      check('removing unreadable consuming-*.jsonl clears memory-lifecycle warning', lifeConsAfter.status === 'ok', JSON.stringify(lifeConsAfter))

      chmodSync(dir, 0o300)
      try {
        check('unreadable library dir keeps readConsumingRows []', readConsumingRows(dir).length === 0)
        const dirUnread = mnemeUnreadSentence([dir])
        check(
          'mnemeUnread records unread sentence for unreadable library dir',
          dirUnread !== null && dirUnread.includes(`${dir} could not be read (`),
          String(dirUnread),
          UNREAD_FIX,
        )
      } finally {
        chmodSync(dir, 0o700)
      }
      readConsumingRows(dir)
      check('restoring library dir clears unread sentence', mnemeUnreadSentence([dir]) === null, String(mnemeUnreadSentence([dir])))

      const maintPath = join(dir, 'maintenance.jsonl')
      writeFileSync(maintPath, '{"ts":"2026-01-01T00:00:00.000Z","trigger":"operator","ran":true,"reason":"ok"}\n', { mode: 0o600 })
      chmodSync(maintPath, 0o200)
      try {
        check('unreadable maintenance.jsonl keeps readMaintenanceReceipts []', readMaintenanceReceipts(dir).length === 0)
        const statsMaint = await memoryStatsText()
        check(
          '/memory stats shows unread sentence for unreadable maintenance.jsonl',
          statsMaint.includes(`${maintPath} could not be read (`),
          statsMaint,
          UNREAD_FIX,
        )
      } finally {
        chmodSync(maintPath, 0o600)
        unlinkSync(maintPath)
      }
      readMaintenanceReceipts(dir)

      const ledPath = lineagePath(projectKey)
      mkdirSync(dirname(ledPath), { recursive: true })
      writeFileSync(ledPath, '', { mode: 0o600 })
      chmodSync(ledPath, 0o200)
      try {
        check('unreadable ledger.jsonl keeps readLedger and currentLedger []', readLedger(projectKey).length === 0 && currentLedger().length === 0)
        const statsLed = await memoryStatsText()
        check(
          '/memory stats shows unread sentence for unreadable ledger.jsonl',
          statsLed.includes(`${ledPath} could not be read (`),
          statsLed,
          UNREAD_FIX,
        )
      } finally {
        chmodSync(ledPath, 0o600)
        unlinkSync(ledPath)
      }
      readLedger(projectKey)

      const jPath = journalPath(projectKey)
      mkdirSync(dirname(jPath), { recursive: true })
      writeFileSync(jPath, '## 2026-01-01T00:00:00.000Z\n\nhi\n', { mode: 0o600 })
      chmodSync(jPath, 0o200)
      try {
        check('unreadable journal.md keeps readJournal []', readJournal(projectKey).length === 0)
        const statsJournal = await memoryStatsText()
        check(
          '/memory stats shows unread sentence for unreadable journal.md',
          statsJournal.includes(`${jPath} could not be read (`) && statsJournal.includes('so what it holds is not shown — fix or remove the file.'),
          statsJournal,
          UNREAD_FIX,
        )
        const centreJournal = await renderMemoryCentre()
        check(
          'Memory Centre note shows unread sentence for unreadable journal.md',
          centreJournal.includes(`${jPath} could not be read (`),
          centreJournal.slice(-400),
          UNREAD_FIX,
        )
      } finally {
        chmodSync(jPath, 0o600)
        unlinkSync(jPath)
      }
      readJournal(projectKey)
      const statsFinal = await memoryStatsText()
      check('clearing all unreadable files leaves /memory stats clean', !statsFinal.includes('could not be read'), statsFinal)
    }
  }

  section('§3 w01-3: unreadable or corrupt thinking-drop ledger in preserved-thinking health row')
  {
    const runPreservedThinkingRow = async () => {
      const cert = await runHealthReport({}, [{ id: 'memory', title: 'Memory', checks: () => memoryChecks().filter(c => c.id === 'preserved-thinking') }])
      return cert.sections[0]!.checks[0]!
    }
    const ledgerPath = thinkingDropLedgerPath()
    const cleanRow = await runPreservedThinkingRow()
    check('absent thinking-drop ledger reads ok in preserved-thinking health row', cleanRow.status === 'ok', JSON.stringify(cleanRow))

    writeFileSync(ledgerPath, '{not json')
    check('corrupt thinking-drop ledger keeps readThinkingDropLedger returning null', readThinkingDropLedger() === null)
    const corruptRow = await runPreservedThinkingRow()
    check(
      'corrupt thinking-drop ledger reads unknown (probe threw) in preserved-thinking health row',
      corruptRow.status === 'unknown' && corruptRow.evidence.startsWith('probe threw:'),
      JSON.stringify(corruptRow),
      PROBE_FIX,
    )

    if (POSIX_MODES) {
      writeFileSync(ledgerPath, JSON.stringify({ last: { at: '2026-01-01T00:00:00.000Z', kind: 'first', lawful: null, reason: 'r', path: 'p', count: 1, consecutive: 1, model: 'm' }, longestRun: 1 }), { mode: 0o600 })
      chmodSync(ledgerPath, 0o200)
      try {
        check('unreadable thinking-drop ledger keeps readThinkingDropLedger returning null', readThinkingDropLedger() === null)
        const eaccesRow = await runPreservedThinkingRow()
        check(
          'unreadable thinking-drop ledger reads unknown (probe threw) in preserved-thinking health row',
          eaccesRow.status === 'unknown' && eaccesRow.evidence.startsWith('probe threw:'),
          JSON.stringify(eaccesRow),
          PROBE_FIX,
        )
      } finally {
        chmodSync(ledgerPath, 0o600)
      }
    }
    unlinkSync(ledgerPath)
    const afterRow = await runPreservedThinkingRow()
    check('removing thinking-drop ledger restores preserved-thinking health row to ok', afterRow.status === 'ok', JSON.stringify(afterRow))
  }

  section('§4 w01-4: crewmate launch notes when loadMemoryPrompt fails')
  if (POSIX_MODES) {
    process.env.ANTHROPIC_API_KEY = 'test-key-000'
    tellTheToolTable({ getAllBaseTools: () => [], assembleToolPool: () => [] })
    let appState: Record<string, unknown> = {
      toolPermissionContext: getEmptyToolPermissionContext(),
      mcp: { clients: [], tools: [] },
      tasks: {},
    }
    const setAppState = (fn: (prev: Record<string, unknown>) => Record<string, unknown>): void => {
      appState = fn(appState)
    }
    const makeContext = () => ({
      options: {
        engineModel: 'claude-sonnet-4-6',
        tools: [],
        mcpClients: [],
        agentDefinitions: { activeAgents: [MERCURY_CREW_AGENT], allAgents: [MERCURY_CREW_AGENT] },
      },
      getAppState: () => appState,
      setAppState,
      setAppStateForTasks: setAppState,
      abortController: new AbortController(),
      readFileState: new Map(),
      messages: [],
      toolUseId: 'tu-w01-4',
      startTurn: async function* () {},
    })
    const parentMsg = {
      type: 'assistant',
      uuid: '00000000-0000-0000-0000-000000000001',
      message: { id: 'm1', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, type: 'message', usage: { input_tokens: 0, output_tokens: 0 } },
    }
    chmodSync(dir, 0o300)
    try {
      const ctx = makeContext()
      const answer = await agentToolCall(
        { description: 'probe launch', prompt: 'say ok', run_in_background: true },
        ctx as never,
        (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
        parentMsg as never,
      )
      ctx.abortController.abort()
      const receipt = agentToolResultBlock(answer.data, 'tu-w01-4')
      const receiptText = receipt.content.map(b => b.text).join('\n')
      check('crewmate launch is not refused when loadMemoryPrompt fails', answer.data.status === 'async_launched', JSON.stringify(answer.data))
      check(
        'async launch receipt carries the pinned-rules memory load note',
        receiptText.includes('this crewmate runs without your pinned rules: memory could not be loaded ('),
        receiptText,
        CREW_NOTE_FIX,
      )

      resetCommandQueue()
      const runCtx = makeContext()
      const gen = runAgent({
        agentDefinition: MERCURY_CREW_AGENT,
        promptMessages: [],
        toolUseContext: runCtx as never,
        canUseTool: (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
        isAsync: false,
        querySource: 'agent:default' as never,
        availableTools: [],
        description: 'probe runAgent',
      })
      for await (const _ of gen) {
      }
      const queued = getCommandQueueSnapshot().map(item => String(item.value)).join('\n')
      check(
        'runAgent enqueues receipt note when buildAgentSystemPrompt hits loadMemoryPrompt failure',
        queued.includes('this crewmate runs without your pinned rules: memory could not be loaded ('),
        queued,
        CREW_NOTE_FIX,
      )
      resetCommandQueue()
    } finally {
      chmodSync(dir, 0o700)
    }

    const okCtx = makeContext()
    const okAnswer = await agentToolCall(
      { description: 'clean launch', prompt: 'say ok', run_in_background: true },
      okCtx as never,
      (async () => ({ behavior: 'allow', updatedInput: {} })) as never,
      parentMsg as never,
    )
    okCtx.abortController.abort()
    const okText = agentToolResultBlock(okAnswer.data, 'tu-w01-4-ok').content.map(b => b.text).join('\n')
    check(
      'clean crewmate launch carries no memory-load failure note',
      !okText.includes('this crewmate runs without your pinned rules'),
      okText,
    )
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
