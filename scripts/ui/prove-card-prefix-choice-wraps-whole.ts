#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as React from 'react'

Object.assign(globalThis, { MACRO: { VERSION: '1.0.0' } })

const originalCwd = process.cwd()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'card-prefix-choice-')))
const projectDir = join(sandbox, 'W1-humanize')
const configDir = join(sandbox, 'home')
mkdirSync(projectDir, { recursive: true })
mkdirSync(configDir, { recursive: true })
writeFileSync(join(projectDir, 'README.md'), '# humanize\n')

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
const { hasPermissionsToUseTool } = await import('../../src/permissions/rules/permissionDoor.ts')
const { BashPermissionRequest } = await import('../../src/permissions/cards/bash/ShellPermissionRequest.tsx')
const { PowerShellPermissionRequest } = await import('../../src/permissions/cards/powershell/PowerShellPermissionRequest.tsx')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { PowerShellTool } = await import('../../src/tools/powershell/PowerShellTool.tsx')
const { POWERSHELL_TOOL_NAME } = await import('../../src/tools/kit/names/powershell.ts')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { mountOffscreen, painted, waitFor, KEY } = await import('../lib/settingsPopupHarness.ts')

let failures = 0
const HINT =
  'the choice row is SelectInputOption in src/screen/select/SelectInputOption.tsx: its ordinal keeps its cells, its label keeps the separator, and a value that cannot fit beside the label goes under it whole, the text input wrapped to its own box'

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${HINT}`}`)
  if (!ok) failures++
}

const ROWS = 40
const LABEL = "Yes, and don't ask again for commands starting with"
const LEAD = `2. ${LABEL}: `
const LAST_CHOICE = '3. No, and tell Mercury what to do differently (esc)'
const PREFIX = '.venv/bin/python -c "import humanize;print(humanize.__all__)"'
const COMMAND = `cd ${projectDir}; grep -n '^#' README.md; ${PREFIX}`
const LONGER_PREFIX = '.venv/bin/python -c "import humanize;print(humanize.__all__);print(humanize.naturalsize(123456789))"'
const LONGER_COMMAND = `cd ${projectDir}; grep -n '^#' README.md; ${LONGER_PREFIX}`
const SHORT_COMMAND = 'npm run build -- --watch=false'
const POWERSHELL_PREFIX = '.venv/Scripts/python.exe -c "import humanize;print(humanize.__all__)"'
const WIDTHS = [
  { columns: 120, leadOnOneLine: true },
  { columns: 80, leadOnOneLine: true },
  { columns: 64, leadOnOneLine: true },
  { columns: 63, leadOnOneLine: true },
  { columns: 50, leadOnOneLine: false },
]

const appState = () => ({ ...getDefaultAppState(), toolPermissionContext: { ...getEmptyToolPermissionContext(), mode: 'default' } })
const toolUseContext = { abortController: new AbortController(), getAppState: appState, setAppState() {}, options: { tools: [BashTool, PowerShellTool] }, messages: [] }
const assistantMessage = { message: { id: 'card-prefix-choice' } }

async function choices(kind: 'bash' | 'powershell', command: string, permissionResult: unknown, columns: number, focusPrefixChoice: boolean, retyped?: string): Promise<string[]> {
  const base = getDefaultAppState()
  const initialState = { ...base, toolPermissionContext: { ...base.toolPermissionContext, mode: 'default' } }
  const isPowerShell = kind === 'powershell'
  const card = React.createElement(isPowerShell ? PowerShellPermissionRequest : BashPermissionRequest, {
    toolUseConfirm: {
      tool: isPowerShell ? PowerShellTool : BashTool,
      input: { command },
      toolUseID: `card-prefix-choice-${kind}-${columns}-${focusPrefixChoice ? 'edit' : 'rest'}`,
      description: isPowerShell ? 'Run a PowerShell command' : 'Run a shell command',
      cwd: projectDir,
      assistantMessage,
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
  })
  const scene = await mountOffscreen(
    React.createElement(ThemeProvider, null, React.createElement(AppStateProvider, { initialState }, React.createElement(KeybindingSetup, null, card))),
    columns,
    ROWS,
  )
  try {
    await waitFor(() => scene.screen().includes('esc cancel'), 5000)
    if (focusPrefixChoice) {
      scene.push(KEY.down)
      await waitFor(() => scene.lines().some(line => line.includes('❯ 2.')), 1500)
    }
    if (retyped !== undefined) {
      for (let line = 0; line < 4; line++) {
        scene.push('\x15')
        await painted(120)
      }
      for (const key of retyped) {
        scene.push(key)
        await painted(60)
      }
    }
    await painted(1000)
    const rows = scene.lines().map(line => line.replace(/^│ {2}/, '').replace(/ *│$/, ''))
    const question = rows.indexOf('Do you want to proceed?')
    const bottom = rows.findIndex((row, at) => at > question && row.startsWith('╰'))
    return question === -1 || bottom === -1 ? rows : rows.slice(question + 1, bottom)
  } finally {
    scene.unmount()
  }
}

const withoutPointer = (row: string): string => row.replace(/^(?:❯ | {2})/, '')

function prefixChoice(rows: string[]): string[] {
  const at = rows.findIndex(row => withoutPointer(row).startsWith('2.'))
  const end = rows.findIndex(row => withoutPointer(row).startsWith('3.'))
  return at === -1 || end <= at ? [] : rows.slice(at, end).map(row => withoutPointer(row).trim())
}

const reads = (rows: string[]): string => prefixChoice(rows).join(' ')
const withoutSpaces = (text: string): string => text.replace(/\s/g, '')

try {
  const ask = await hasPermissionsToUseTool(BashTool, { command: COMMAND }, toolUseContext, assistantMessage, 'toolu_card_prefix_choice')
  for (const { columns, leadOnOneLine } of WIDTHS) {
    for (const focus of [false, true]) {
      const state = focus ? 'with the choice in focus for an edit' : 'at rest'
      const drawn = await choices('bash', COMMAND, ask, columns, focus)
      check(
        `${columns} columns, ${state}: the Bash card's prefix choice reads "${LEAD}" and then every character of the prefix`,
        reads(drawn) === `${LEAD}${PREFIX}`,
        JSON.stringify(drawn),
      )
      if (leadOnOneLine) {
        check(
          `${columns} columns, ${state}: its first row reads "${LEAD.trimEnd()}" whole`,
          (prefixChoice(drawn)[0] ?? '').startsWith(LEAD.trimEnd()),
          JSON.stringify(drawn),
        )
      }
    }
  }

  for (const [columns, command, prefix] of [[80, LONGER_COMMAND, LONGER_PREFIX], [22, COMMAND, PREFIX]] as const) {
    const cutAsk = await hasPermissionsToUseTool(BashTool, { command }, toolUseContext, assistantMessage, `toolu_card_prefix_choice_cut_${columns}`)
    for (const focus of [false, true]) {
      const cut = await choices('bash', command, cutAsk, columns, focus)
      check(
        `${columns} columns, ${focus ? 'with the choice in focus for an edit' : 'at rest'}: a prefix that has to break inside a word keeps every character on the card`,
        withoutSpaces(reads(cut)) === withoutSpaces(`${LEAD}${prefix}`),
        JSON.stringify(cut),
      )
    }
  }

  for (const columns of [65, 68, 72]) {
    const typed = await choices('bash', COMMAND, ask, columns, true, 'npm run build')
    check(
      `${columns} columns: with the prefix cleared (ctrl+u) and npm run build typed in its place, the choice reads "${LEAD}npm run build"`,
      reads(typed) === `${LEAD}npm run build`,
      JSON.stringify(typed),
    )
  }

  const shortAsk = await hasPermissionsToUseTool(BashTool, { command: SHORT_COMMAND }, toolUseContext, assistantMessage, 'toolu_card_prefix_choice_short')
  const shortAtRest = await choices('bash', SHORT_COMMAND, shortAsk, 120, false)
  check(
    '120 columns, at rest: a short prefix draws the three choices exactly as before, one line each',
    JSON.stringify(shortAtRest) === JSON.stringify(['❯ 1. Yes', `  ${LEAD}npm run build`, `  ${LAST_CHOICE}`]),
    JSON.stringify(shortAtRest),
  )
  const shortEditing = await choices('bash', SHORT_COMMAND, shortAsk, 120, true)
  check(
    '120 columns, with the choice in focus for an edit: a short prefix draws the three choices exactly as before, one line each',
    JSON.stringify(shortEditing) === JSON.stringify(['  1. Yes', `❯ ${LEAD}npm run build`, `  ${LAST_CHOICE}`]),
    JSON.stringify(shortEditing),
  )

  const twinReason = `\`${POWERSHELL_PREFIX}\` requires approval`
  const twinAsk = {
    behavior: 'ask',
    message: twinReason,
    decisionReason: { type: 'other', reason: twinReason },
    suggestions: [{ type: 'addRules', rules: [{ toolName: POWERSHELL_TOOL_NAME, ruleContent: POWERSHELL_PREFIX }], behavior: 'allow', destination: 'localSettings' }],
  }
  const twin = await choices('powershell', POWERSHELL_PREFIX, twinAsk, 120, false)
  check(
    `120 columns, at rest: the PowerShell card's prefix choice reads "${LEAD}" and then every character of the prefix`,
    reads(twin) === `${LEAD}${POWERSHELL_PREFIX}`,
    JSON.stringify(twin),
  )
} finally {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(failures ? `card prefix choice wraps whole: ${failures} FAILED` : 'card prefix choice wraps whole: ALL PASS')
process.exit(failures ? 1 : 0)
