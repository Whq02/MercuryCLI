#!/usr/bin/env bun
import React from 'react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('question-card-last-row')
Object.assign(process.env, { MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true' })
for (const key of ['MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER']) delete process.env[key]
const frameDir = process.argv.includes('--frames') ? process.argv[process.argv.indexOf('--frames') + 1] : undefined
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? `\n${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}

const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { PermissionRequest } = await import('../../src/components/permissions/PermissionRequest.tsx')
const { AskUserQuestionTool } = await import('../../src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { _resetInterviewForProofs } = await import('../../src/services/interview/store.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))

const h = React.createElement
const ASKED = '[whq] ❯ ask one'
const SENTENCE = '[Mercury] One question before I go on (ask one).'
const QUESTION = 'Which engine should the cache use?'
const CONVERSATION = [...Array.from({ length: 40 }, (_, index) => `an earlier row of the conversation, ${index + 1}`), '', ASKED, '', SENTENCE]
const QUESTIONS = [{ question: QUESTION, header: 'Engine', multiSelect: false, options: [{ label: 'Redis', description: 'A shared network cache.' }, { label: 'Memory', description: 'Process-local, nothing to run.' }, { label: 'File', description: 'Durable on one host.' }] }]

function contextOf(): unknown {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' }, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [AskUserQuestionTool], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(), messages: [], readFileState: new Map(), toolUseId: 'toolu_question_card',
    getAppState: () => state, setAppState: () => undefined, setResponseLength: () => undefined, updateFileHistoryState: () => undefined, updateAttributionState: () => undefined,
  }
}

type Card = { view: Mounted; rest: string[] }
async function cardUp(columns: number, rows: number): Promise<Card> {
  _resetInterviewForProofs()
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  const context = contextOf()
  const confirm = {
    tool: AskUserQuestionTool, input: { questions: QUESTIONS }, toolUseID: `toolu_question_${columns}x${rows}`, description: '', toolUseContext: context,
    permissionResult: { behavior: 'ask', message: '' }, assistantMessage: { type: 'assistant', uuid: 'question-card-assistant', message: { id: 'msg_question_card', role: 'assistant', content: [] } },
    onAllow: () => {}, onReject: () => {}, onAbort: () => {}, onUserInteraction: () => {}, recheckPermission: async () => {},
  }
  let raise: (up: boolean) => void = () => {}
  function Scene(): React.ReactNode {
    const [up, setUp] = React.useState(false)
    raise = setUp
    const scrollRef = React.useRef(null)
    const dividerYRef = React.useRef(null)
    return h(KeybindingSetup, null, h(FullscreenLayout, {
      scrollRef, dividerYRef, hidePill: false, newMessageCount: 0, onPillClick: () => {},
      scrollable: h(Box, { flexDirection: 'column' }, ...CONVERSATION.map((row, index) => h(Text, { key: index }, row === '' ? ' ' : row))),
      statusBand: h(Text, null, 'activity specimen'), statusBandActive: false,
      overlay: up ? h(Box, { flexDirection: 'column' }, h(PermissionRequest, { toolUseConfirm: confirm, toolUseContext: context, onDone: () => {}, onReject: () => {}, verbose: false, workerBadge: undefined, setStickyFooter: () => {} } as never)) : null,
      bottom: h(Text, null, ' the status row'),
    } as never))
  }
  const view = await mountOffscreen(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Scene)), columns, rows)
  await waitFor(() => view.screen().includes(SENTENCE), 8_000)
  await settle(250)
  const rest = view.lines()
  raise(true)
  await waitFor(() => view.screen().includes(QUESTION), 8_000)
  await settle(350)
  return { view, rest }
}

type Read = { lines: string[]; tabsAt: number; sentenceAt: number; askedAt: number }
function read(view: Mounted, name: string): Read {
  const lines = view.lines().map(line => line.replace(/\s+$/, ''))
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
  return { lines, tabsAt: lines.findIndex(line => /^(←\s+| )[☐☒]/.test(line)), sentenceAt: lines.findIndex(line => line.includes(SENTENCE)), askedAt: lines.findIndex(line => line.includes(ASKED)) }
}
const around = (frame: Read): string => frame.lines.slice(Math.max(0, frame.tabsAt - 5), frame.tabsAt + 2).map(line => `      |${line.slice(0, 110)}`).join('\n')
const ruleAcross = (line: string | undefined, from: number, width: number): boolean => line !== undefined && line.length >= width - 1 && [...line.slice(from, width - 1)].every(cell => cell === '─')

async function frames(view: Mounted, name: string): Promise<Read[]> {
  const up = read(view, `${name}-card-up`)
  view.push(KEY.down)
  await settle(250)
  const down = read(view, `${name}-after-down`)
  view.push(KEY.up)
  await settle(250)
  return [up, down, read(view, `${name}-after-up`)]
}

section('a screen with no border under the conversation: the question card starts on the row below the last row')
for (const [columns, rows] of [[80, 24], [99, 30]] as const) {
  const { view } = await cardUp(columns, rows)
  try {
    const [up, down, back] = await frames(view, `${columns}x${rows}`)
    check(`${columns}x${rows}: the conversation's last row is on screen with the question up`, up!.sentenceAt >= 0 && up!.tabsAt > 0, around(up!))
    check(`${columns}x${rows}: the card's rule stands on the row below it, the card's tabs on the row below the rule`, up!.sentenceAt >= 0 && up!.tabsAt === up!.sentenceAt + 2 && ruleAcross(up!.lines[up!.tabsAt - 1], 0, columns), around(up!))
    check(`${columns}x${rows}: the row the operator sent stands above them, as it stood`, up!.askedAt >= 0 && up!.askedAt === up!.sentenceAt - 2, around(up!))
    check(`${columns}x${rows}: the same rows stand after ↓ and after ↑ on the card`, [down!, back!].every(frame => frame.sentenceAt === up!.sentenceAt && frame.tabsAt === up!.tabsAt && ruleAcross(frame.lines[frame.tabsAt - 1], 0, columns)), `${around(down!)}\n      …\n${around(back!)}`)
  } finally {
    view.unmount()
  }
}

section('a screen whose conversation pane has a border: the card joins the frame, its rule on the border\'s row')
for (const [columns, rows] of [[120, 40], [178, 51]] as const) {
  const { view, rest } = await cardUp(columns, rows)
  try {
    const side = rest[0]!.indexOf('╭')
    const edgeAtRest = rest.findLastIndex(line => line[side] === '╰')
    const [up, down, back] = await frames(view, `${columns}x${rows}`)
    const paneRowOf = (frame: Read): boolean => frame.lines[frame.sentenceAt]?.[side] === '│'
    check(`${columns}x${rows}: at rest the pane has its border`, side > 0 && edgeAtRest > 0, rest.slice(0, 3).join('\n'))
    check(`${columns}x${rows}: the conversation's last row is the pane's last row, on screen`, up!.sentenceAt >= 0 && paneRowOf(up!), around(up!))
    check(`${columns}x${rows}: one row lies between it and the card's tabs, the border's row, a rule from the pane's side to the screen's edge`, up!.tabsAt === up!.sentenceAt + 2 && ruleAcross(up!.lines[up!.tabsAt - 1], side + 1, columns), around(up!))
    check(`${columns}x${rows}: the same rows stand after ↓ and after ↑ on the card`, [down!, back!].every(frame => frame.sentenceAt === up!.sentenceAt && frame.tabsAt === up!.tabsAt && paneRowOf(frame) && ruleAcross(frame.lines[frame.tabsAt - 1], side + 1, columns)), `${around(down!)}\n      …\n${around(back!)}`)
  } finally {
    view.unmount()
  }
}

_resetInterviewForProofs()
await releaseScratchHome(home)
console.log(`\n${checks - failures} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
