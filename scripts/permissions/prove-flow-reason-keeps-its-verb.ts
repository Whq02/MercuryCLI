#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const originalCwd = process.cwd()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'flow-reason-')))
const projectDir = join(sandbox, 'proj')
const configDir = join(sandbox, 'home')
mkdirSync(projectDir, { recursive: true })
mkdirSync(configDir, { recursive: true })

process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(projectDir)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.ts')
setOriginalCwd(projectDir)
setProjectRoot(projectDir)
setCwdState(projectDir)

const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { BashPermissionRequest } = await import('../../src/permissions/cards/bash/ShellPermissionRequest.tsx')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.ts')
const { parseForSecurity } = await import('../../src/permissions/rules/decision/commandAnalysis.ts')
const { flowAskSentence } = await import('../../src/permissions/rules/flowLaw.ts')
const { consentContentWidth } = await import('../../src/permissions/cards/consentBodyBudget.ts')
const { stringWidth } = await import('../../src/screen/renderer/stringWidth.ts')
const { wrapText } = await import('../../src/platform/text/truncate.ts')
const { mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')

let failures = 0
const HINT =
  'fit the sentence in fitFlowSentence of src/permissions/cards/PermissionRuleExplanation.tsx: the command gives way from its end down to its first word, then the path the sentence names is cut once in its middle with the name of its file kept, and only then do that first word and that name give way; the words Flow asks before, the verb after the colon and the end of the sentence are never cut, and the sentence stays on one row'

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${HINT}`}`)
  if (!ok) failures++
}

type Mode = 'default' | 'flow'
type Ask = { behavior: string; message?: string }

const QUESTION = 'Do you want to proceed?'
const state = (mode: Mode) => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode }, tasks: {}, sessionHooks: new Map() })
const contextFor = (mode: Mode) => ({ abortController: new AbortController(), getAppState: () => state(mode), setAppState() {}, options: { tools: [BashTool] }, messages: [] }) as never
const assistant = { message: { id: 'flow-reason' } } as never

async function flowAsk(command: string): Promise<Ask> {
  await parseForSecurity(command)
  return (await decideToolPermissionWithModes(BashTool as never, { command }, contextFor('flow'), assistant, `flow-reason-${command.length}`)).decision as Ask
}

async function cardRows(command: string, permissionResult: unknown, mode: Mode, columns: number): Promise<string[]> {
  const base = getDefaultAppState()
  const initialState = { ...base, toolPermissionContext: { ...base.toolPermissionContext, mode } }
  const toolUseContext = contextFor(mode)
  const card = React.createElement(BashPermissionRequest as never, {
    toolUseConfirm: {
      tool: BashTool,
      input: { command },
      toolUseID: `card-${columns}-${command.length}`,
      description: 'Run a shell command',
      cwd: projectDir,
      assistantMessage: assistant,
      permissionResult,
      permissionPromptStartTimeMs: Date.now(),
      onUserInteraction() {},
      onAllow() {},
      onReject() {},
      onAbort() {},
      recheckPermission: async () => {},
      toolUseContext,
    },
    toolUseContext,
    onDone() {},
    onReject() {},
    verbose: false,
  } as never)
  const scene = await mountOffscreen(
    React.createElement(ThemeProvider as never, null, React.createElement(AppStateProvider as never, { initialState } as never, React.createElement(KeybindingSetup as never, null, card))),
    columns,
    40,
  )
  try {
    await waitFor(() => scene.screen().includes(QUESTION), 5000)
    return scene.lines().map(line => line.replace(/^[│\s]+|[│\s]+$/g, ''))
  } finally {
    scene.unmount()
  }
}

async function reasonRow(command: string, ask: Ask, columns: number): Promise<{ row: string; oneRow: boolean }> {
  const rows = await cardRows(command, ask, 'flow', columns)
  const at = rows.findIndex(row => row.startsWith('Flow asks before'))
  return { row: rows[at] ?? '', oneRow: at >= 0 && rows[at + 1] === QUESTION }
}

try {
  const outside = '/c/src/fl1012/t22-outside/out-u25b.txt'
  const boxCommand = `echo out > ${outside}`
  const boxAsk = await flowAsk(boxCommand)
  const boxSentence = `Flow asks before ${boxCommand}: it writes ${outside}, outside the project.`
  check('the sentence Flow gives the card is whole, as the Windows box met it', boxAsk.behavior === 'ask' && boxAsk.message === boxSentence, JSON.stringify(boxAsk.message))

  const boxRows: Record<number, string> = {
    120: `Flow asks before echo out > /c/src/fl1012…: it writes ${outside}, outside the project.`,
    100: `Flow asks before echo…: it writes ${outside}, outside the project.`,
    80: 'Flow asks before echo…: it writes /c/s…/out-u25b.txt, outside the project.',
  }
  for (const columns of [120, 100, 80]) {
    const { row, oneRow } = await reasonRow(boxCommand, boxAsk, columns)
    check(`${columns} columns: the long path leaves the verb and the end of the sentence in place`, /^Flow asks before .+: it writes \S+, outside the project\.$/.test(row), row)
    check(`${columns} columns: the sentence reads ${JSON.stringify(boxRows[columns])}`, row === boxRows[columns], row)
    check(`${columns} columns: the sentence stays on its one row, inside the card`, oneRow && stringWidth(row) <= consentContentWidth(columns), `${stringWidth(row)} cells of ${consentContentWidth(columns)}: ${row}`)
  }

  const target = '/c/src/fl1012/t22-outside/keep/a.txt'
  const wordy = `python3 -c "import os; os.remove('${target}')"`
  const wordyAsk = await flowAsk(wordy)
  check('a long command with a long path asks in Flow', wordyAsk.behavior === 'ask' && /^Flow asks before python3 .+: it deletes or overwrites \S+, outside the project\.$/.test(wordyAsk.message ?? ''), JSON.stringify(wordyAsk.message))
  for (const columns of [120, 100, 80]) {
    const { row, oneRow } = await reasonRow(wordy, wordyAsk, columns)
    const named = /^Flow asks before .+: it deletes or overwrites (\S+), outside the project\.$/.exec(row)?.[1] ?? ''
    check(`${columns} columns: a long command gives way before the verb, the end or the file it names`, (columns === 120 ? named === target : named.endsWith('/a.txt')) && oneRow && stringWidth(row) <= consentContentWidth(columns), row)
  }

  const homeCommand = 'echo out > ~/mercury-proof-nowhere/deep/folder/names/out.txt'
  const homeAsk = await flowAsk(homeCommand)
  const { row: homeRow } = await reasonRow(homeCommand, homeAsk, 80)
  check('80 columns: a path under the home keeps the home as ~ and the name of its file around its one cut', /^Flow asks before echo…: it writes ~\/[^…]+…\/out\.txt, outside the project\.$/.test(homeRow), `${homeRow} of ${homeAsk.message}`)

  const winPath = 'C:\\src\\fl1012\\t22-outside\\out-u25.txt'
  const winCommand = `Set-Content -Path ${winPath} -Value v`
  const winSentence = flowAskSentence({ item: 4, subject: winCommand, why: `it writes ${winPath}, outside the project` })
  const winAsk = { behavior: 'ask', message: winSentence, decisionReason: { type: 'other', reason: winSentence } } as Ask
  const { row: winRow, oneRow: winOneRow } = await reasonRow(winCommand, winAsk, 100)
  check('100 columns: a Windows path is cut the same way, between its drive and the name of its file', winOneRow && winRow === 'Flow asks before Set-Content…: it writes C:\\src\\fl1012\\t22-…\\out-u25.txt, outside the project.', winRow)
  const { row: winNarrow, oneRow: winNarrowOneRow } = await reasonRow(winCommand, winAsk, 80)
  check('80 columns: the name of the file outlasts the first word of the command', winNarrowOneRow && /^Flow asks before \S+…: it writes …\\out-u25\.txt, outside the project\.$/.test(winNarrow), winNarrow)

  const shortCommand = 'rm -rf ~/other'
  const shortAsk = await flowAsk(shortCommand)
  const { row: shortRow } = await reasonRow(shortCommand, shortAsk, 80)
  check('80 columns: a sentence the card holds is drawn as Flow gives it', shortRow !== '' && shortRow === shortAsk.message, `${shortRow} of ${shortAsk.message}`)

  const asBefore = async (label: string, reason: string, mode: Mode): Promise<void> => {
    const rows = await cardRows('echo control', { behavior: 'ask', message: reason, decisionReason: { type: 'other', reason } }, mode, 120)
    check(`120 columns: ${label} is fitted as before`, rows.includes(wrapText(reason, consentContentWidth(120), 'truncate-middle')), JSON.stringify(rows.filter(row => row.includes('…'))))
  }
  const longPath = '/srv/orchard/source-directory'.repeat(6)
  await asBefore("a reason that is not Flow's sentence", `Mercury requested permission to edit ${longPath}/NEXT-SESSION.md, which is a sensitive file.`, 'default')
  await asBefore('a sentence of Flow that names its path before the verb', `Flow asks before writing ${longPath}/NEXT-SESSION.md: it is outside the project.`, 'flow')
} finally {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(failures ? `Flow reason keeps its verb: ${failures} FAILED` : 'Flow reason keeps its verb: ALL PASS')
process.exit(failures ? 1 : 0)
