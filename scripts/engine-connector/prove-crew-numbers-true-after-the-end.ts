#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'crew-after-end-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(join(scratch, 'home'), { recursive: true })
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_OPERATOR = 'sam'
for (const k of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) {
  process.env[k] = '0'
}

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

const React = (await import('react')).default
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/engine/connector/focusedConnector.ts')
const { AppStateProvider, getDefaultAppState } = await import('../../src/screen/app-state/AppState.tsx')
const { crewFactsStamp } = await import('../../src/screen/app-state/crewLedger.ts')
const crew = await import('../../src/engine/connector/crewFacts.ts')
const { CrewView } = await import('../../src/screen/widgets/faces/CrewView.tsx')
const { CrewmateCard } = await import('../../src/screen/fullscreen-layout/CrewmateCard.tsx')
const { crewmateInView, useViewedCrewmate } = await import('../../src/screen/tasks/useCrewmateView.ts')
const { HelmLanesRail } = await import('../../src/screen/fullscreen-layout/HelmLanesRail.tsx')
const { BackgroundTasksDialog, boardCrewmateRowsOf, RosterWorkDetail } = await import('../../src/screen/tasks/BackgroundTasksDialog.tsx')
const { CrewmateDetailDialog } = await import('../../src/screen/tasks/CrewmateDetailDialog.tsx')
const { runCrewmateCommand } = await import('../../src/screen/composer/crewmateCommands.tsx')
const { crewmateMetadataFile } = await import('../../src/screen/tasks/useCrewmateModel.ts')
const { formatTokens } = await import('../../src/platform/text/format.ts')
type WorkRowV1 = import('../../src/engine/connector/types.ts').WorkRowV1
type SessionConnector = import('../../src/engine/connector/types.ts').SessionConnector
type SessionAskV1 = import('../../src/engine/connector/types.ts').SessionAskV1
type WorkRosterV1 = import('../../src/engine/connector/types.ts').WorkRosterV1
type LocalJSXCommandContext = import('../../src/commands/catalogue/commands.ts').LocalJSXCommandContext
type Command = import('../../src/commands/catalogue/commands.ts').Command
type CrewmateTaskState = import('../../src/engine/tasks/local-agent/crewmateTask.ts').CrewmateTaskState
const MODEL_ID = 'claude-fable-5-1'
const SESSION_ID = 'fx-session-after-end'
const NOW = Date.now()
const END_TIME = NOW - 30_000
const START_TIME = END_TIME - 12_000

const settledWork: WorkRowV1 = {
  id: 'bg1',
  kind: 'agent',
  name: 'bg-scout',
  description: 'bg-scout',
  status: 'completed',
  model: MODEL_ID,
  startTime: START_TIME,
  endTime: END_TIME,
  toolUseId: 'tu-bg1',
  toolUses: 7,
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadTokens: 0,
  totalTokens: 1500,
  contextTokens: 1200,
  costUSD: 0.012,
  agentType: 'mercury-crew',
  transcriptAgentId: 'bg1',
}

const bgFacts = crew.crewmateFactsOf(settledWork, SESSION_ID)!
const ledgerState = {
  ...getDefaultAppState(),
  tasks: {},
  crewLedger: {
    bg1: { facts: bgFacts, hosted: true, listed: false, cleared: false, stamp: crewFactsStamp(bgFacts) },
  },
}
const tokensLabel = crew.crewTokensLabel(bgFacts)!
const tokensSummary = crew.crewTokensSummary(bgFacts)
const EMPTY_ROSTER: WorkRosterV1 = { rows: [], mission: [], reported: true }
const NO_ASKS: readonly SessionAskV1[] = []
const NO_RECORDS: ReturnType<SessionConnector['records']> = []
const EMPTY_IDENTITY: ReturnType<SessionConnector['identity']> = {
  firstPartyApi: true,
  consoleBilling: true,
  claudeAiBilling: false,
  accountEmail: null,
}
const MODEL_FACTS: ReturnType<SessionConnector['modelFacts']> = {
  effective: MODEL_ID,
  requested: MODEL_ID,
  source: 'session',
}
const WORKSPACE: ReturnType<SessionConnector['workspace']> = {
  cwd: scratch,
  gitBranch: null,
  isWorktree: false,
}
const emptyConnector: Partial<SessionConnector> = {
  carrier: 'daemon',
  sessionId: () => SESSION_ID,
  workRoster: () => EMPTY_ROSTER,
  subscribeWork: () => () => {},
  records: () => NO_RECORDS,
  subscribeRecords: () => () => {},
  asks: () => NO_ASKS,
  subscribeAsks: () => () => {},
  identity: () => EMPTY_IDENTITY,
  modelFacts: () => MODEL_FACTS,
  subscribeModel: () => () => {},
  subscribePresence: () => () => {},
  workspace: () => WORKSPACE,
  subscribeWorkspace: () => () => {},
}
setFocusedSessionConnector(emptyConnector as SessionConnector)

const paint = async (node: React.ReactNode, width: number, initialState = ledgerState): Promise<string> => {
  return await renderToString(
    React.createElement(AppStateProvider, { initialState }, node),
    width,
  )
}

try {
  section('§1 CrewView row (src/screen/widgets/faces/CrewView.tsx)')
  {
    const frame = await paint(React.createElement(CrewView, { onClose: () => {} }), 120)
    const flat = frame.replace(/\s+/g, ' ')
    check(
      'CrewView lists the settled background crewmate off the roster with landed, tokens, 12s (not growing) and never 0 tool uses',
      flat.includes('bg-scout') &&
        flat.includes('landed') &&
        flat.includes(tokensSummary) &&
        flat.includes('12s') &&
        !flat.includes('42s') &&
        !flat.includes('0 tool uses'),
      flat.slice(0, 350),
    )
  }

  section('§2 CrewmateCard (src/screen/fullscreen-layout/CrewmateCard.tsx)')
  {
    function ViewedCard(): React.ReactNode {
      const viewed = useViewedCrewmate()
      if (viewed === null) return null
      return React.createElement(CrewmateCard, { crewmate: viewed, width: 120 })
    }
    const frame = await paint(
      React.createElement(ViewedCard),
      120,
      { ...ledgerState, viewingCrewmateTaskId: 'bg1' },
    )
    const flat = frame.replace(/\s+/g, ' ')
    check(
      'CrewmateCard reads landed in 12s, tokens and model from crewLedger and never 0 tool uses or a growing clock',
      flat.includes('bg-scout') &&
        flat.includes(MODEL_ID) &&
        flat.includes('landed in 12s') &&
        flat.includes(tokensLabel) &&
        !flat.includes('42s') &&
        !flat.includes('0 tool uses'),
      flat.slice(0, 350),
    )
  }

  section('§3 HelmLanesRail crew rows (src/screen/fullscreen-layout/HelmLanesRail.tsx)')
  {
    const frame = await paint(React.createElement(HelmLanesRail, { width: 34, availRows: 30 }), 34)
    const flat = frame.replace(/\s+/g, ' ')
    check(
      'HelmLanesRail lists the settled crewmate from crewLedger with state landed',
      flat.includes('bg-scout') && flat.includes('landed') && !flat.includes('0 tool uses'),
      flat.slice(0, 350),
    )
  }

  section('§4 BackgroundTasksDialog row and RosterWorkDetail table')
  {
    const boardFrame = await paint(
      React.createElement(BackgroundTasksDialog, {
        onDone: () => {},
        toolUseContext: {} as LocalJSXCommandContext,
      }),
      120,
    )
    const flatBoard = boardFrame.replace(/\s+/g, ' ')
    check(
      'BackgroundTasksDialog lists the settled crewmate from crewLedger with landed, tokens, 12s (not growing) and never 0 tool uses',
      flatBoard.includes('bg-scout') &&
        flatBoard.includes('landed') &&
        flatBoard.includes(tokensLabel) &&
        flatBoard.includes('12s') &&
        !flatBoard.includes('42s') &&
        !flatBoard.includes('0 tool uses'),
      flatBoard.slice(0, 350),
    )

    const workRows = boardCrewmateRowsOf([], [bgFacts])
    const detailRow = workRows.find(row => row.id === 'bg1')
    const detailFrame =
      detailRow === undefined
        ? 'MISSING DETAIL ROW'
        : await paint(React.createElement(RosterWorkDetail, { work: detailRow, now: NOW, onBack: () => {} }), 100)
    const flatDetail = detailFrame.replace(/\s+/g, ' ')
    check(
      'RosterWorkDetail shows state landed, 7 tool uses, ran 12s (not growing) and tokens',
      detailRow !== undefined &&
        flatDetail.includes('landed') &&
        flatDetail.includes('7 tool uses') &&
        !flatDetail.includes('0 tool uses') &&
        flatDetail.includes('12s') &&
        flatDetail.includes(tokensLabel),
      flatDetail.slice(0, 350),
    )
  }

  section('§5 CrewmateDetailDialog (src/screen/tasks/CrewmateDetailDialog.tsx)')
  {
    const task: CrewmateTaskState = {
      id: 'bg1',
      type: 'local_agent',
      status: 'completed',
      description: 'bg-scout',
      prompt: 'Inspect the build',
      agentType: 'mercury-crew',
      startTime: START_TIME,
      endTime: END_TIME,
      outputFile: join(scratch, 'bg1.out'),
      outputOffset: 0,
      notified: true,
      selectedAgent: { agentType: 'mercury-crew', whenToUse: 'general', source: 'built-in', baseDir: scratch, getSystemPrompt: () => '' },
      agentId: 'bg1',
      messages: [],
      retain: false,
      diskLoaded: true,
      evictAfter: END_TIME + 30_000,
      progress: {
        toolUseCount: 7,
        totalToolUseCount: 7,
        tokenCount: 1500,
        totalTokens: 1500,
        recentActivities: [],
      },
      lastReportedToolCount: 7,
      lastReportedTokenCount: 1500,
      isBackgrounded: true,
    }
    const frame = await paint(React.createElement(CrewmateDetailDialog, { agent: task, onDone: () => {} }), 100)
    const flat = frame.replace(/\s+/g, ' ')
    check(
      'CrewmateDetailDialog reads landed in 12s and 1500 tokens from crewLedger, never Completed, never a tool count, never a growing time',
      flat.includes('landed in 12s') &&
        flat.includes('1500 tokens') &&
        !flat.includes('Completed') &&
        !flat.includes('tool use') &&
        !flat.includes('42s'),
      flat.slice(0, 350),
    )
  }

  section('§6 /usage receipt (crewmateUsageWords in src/screen/composer/crewmateCommands.tsx)')
  {
    const viewed = crewmateInView('bg1', { tasks: {}, mainChatTaskId: undefined }, [], SESSION_ID, bgFacts)!
    const metaFile = crewmateMetadataFile(viewed)!
    mkdirSync(join(metaFile, '..'), { recursive: true })
    writeFileSync(metaFile, JSON.stringify({ agentType: 'mercury-crew', model: MODEL_ID }))
    const receipts: string[] = []
    await runCrewmateCommand(
      { name: 'usage', type: 'local', description: 'usage' } as Command,
      '/usage',
      viewed,
      {
        setAppState: () => {},
        receipt: text => { receipts.push(text) },
      },
    )
    const line = receipts[0] ?? ''
    check(
      '/usage receipt shows 7 tool uses, 12s (not growing), input/output tokens and never 0 tool uses',
      line.includes('bg-scout') &&
        line.includes('7 tool uses') &&
        !line.includes('0 tool uses') &&
        line.includes(`${formatTokens(1200)} in`) &&
        line.includes(`${formatTokens(300)} out`) &&
        line.includes('12s') &&
        !line.includes('42s'),
      line,
    )
  }

  section('§7 CrewView: Enter on a settled crewmate (src/screen/widgets/faces/CrewView.tsx)')
  {
    const { mountOffscreen, settle, waitFor } = await import('../lib/settingsPopupHarness.ts')
    const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
    const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
    const { TerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
    const mounted = await mountOffscreen(
      React.createElement(
        AppStateProvider,
        { initialState: ledgerState },
        React.createElement(
          ThemeProvider,
          null,
          React.createElement(
            KeybindingSetup,
            null,
            React.createElement(
              TerminalSizeContext.Provider,
              { value: { columns: 120, rows: 32 } },
              React.createElement(CrewView, { onClose: () => {} }),
            ),
          ),
        ),
      ),
      120,
      32,
    )
    await waitFor(() => mounted.screen().includes('bg-scout'), 2000)
    await settle(250)
    mounted.push('\r')
    const opened = await waitFor(
      () =>
        mounted.screen().includes('crew › bg-scout') &&
        mounted.screen().includes('landed') &&
        mounted.screen().includes('12s') &&
        mounted.screen().includes(tokensLabel) &&
        mounted.screen().includes('esc back'),
      1500,
    )
    check(
      'CrewView (non-popup): Enter on a settled crewmate off the roster opens its card with landed, 12s and tokens from crewLedger',
      opened,
      mounted.screen().replace(/\s+/g, ' ').slice(0, 350),
    )
    mounted.unmount()
    await settle(50)
  }
} finally {
  _resetFocusedSessionConnectorForTesting()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
