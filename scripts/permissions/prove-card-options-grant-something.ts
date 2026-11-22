import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import * as React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const originalCwd = process.cwd()
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'card-grant-')))
const projectDir = join(sandbox, 'proj')
const outsideDir = join(sandbox, 'outside')
const configDir = join(sandbox, 'home')
mkdirSync(projectDir, { recursive: true })
mkdirSync(outsideDir, { recursive: true })
mkdirSync(configDir, { recursive: true })

process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.chdir(projectDir)

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(projectDir)
setProjectRoot(projectDir)
setCwdState(projectDir)

const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getFilePermissionOptions } = await import('../../src/components/permissions/FilePermissionDialog/permissionOptions.tsx')
const { bashToolUseOptions } = await import('../../src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx')
const { powershellToolUseOptions } = await import('../../src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.tsx')
const { FileWritePermissionRequest } = await import('../../src/components/permissions/FileWritePermissionRequest/FileWritePermissionRequest.tsx')
const { ComputerPermissionRequest } = await import('../../src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx')
const { FileWriteTool } = await import('../../src/tools/FileWriteTool/FileWriteTool.ts')
const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { render } = await import('../../src/ink.ts')
const { default: stripAnsi } = await import('strip-ansi')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

let failures = 0
const HINT =
  'change getFilePermissionOptions in src/components/permissions/FilePermissionDialog/permissionOptions.tsx, bashToolUseOptions in src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx, powershellToolUseOptions in src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.tsx, shellPermissionHelpers in src/components/permissions/shellPermissionHelpers.tsx, and ComputerPermissionRequest in src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx so no card offers an option whose grant is empty'

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail} — ` : ''}${HINT}`}`)
  if (!ok) failures++
}

function ctxFor(mode: 'default' | 'implement' | 'flow' | 'sovereign' | 'dontAsk') {
  return { ...getEmptyToolPermissionContext(), mode }
}

async function drawCard(node: React.ReactElement, mode: 'default' | 'flow'): Promise<string[]> {
  const stream = new PassThrough()
  stream.resume()
  Object.assign(stream, { columns: 100, rows: 40 })
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() {
      return this
    },
    setEncoding() {
      return this
    },
    read() {
      return null
    },
    unref() {
      return this
    },
    ref() {
      return this
    },
    pause() {
      return this
    },
    resume() {
      return this
    },
  })
  const base = getDefaultAppState()
  const initialState = {
    ...base,
    toolPermissionContext: { ...base.toolPermissionContext, mode },
  }
  const instance = await render(
    React.createElement(AppStateProvider as never, { initialState } as never, node as never),
    { stdout: stream as never, stdin: stdin as never, patchConsole: false },
  )
  await new Promise(resolve => setTimeout(resolve, 120))
  const lines = stripAnsi(instance.lastFrame())
    .split('\n')
    .map(line => line.replace(/^[│\s]+|[│\s]+$/g, ''))
  instance.unmount()
  return lines
}

try {
  const mercuryMd = join(projectDir, 'MERCURY.md')
  const envFile = join(projectDir, '.env')
  const outsideFile = join(outsideDir, 'notes.txt')
  const configFile = join(projectDir, '.mercury', 'settings.json')

  const flowMercuryWrite = getFilePermissionOptions({
    filePath: mercuryMd,
    toolPermissionContext: ctxFor('flow'),
    operationType: 'write',
  })
  check(
    'file card: MERCURY.md write in Flow offers Yes and No only (no empty-grant option 2)',
    JSON.stringify(flowMercuryWrite.map(o => o.value)) === JSON.stringify(['accept-once', 'reject']),
    JSON.stringify(flowMercuryWrite.map(o => o.value)),
  )

  const implementMercuryWrite = getFilePermissionOptions({
    filePath: mercuryMd,
    toolPermissionContext: ctxFor('implement'),
    operationType: 'write',
  })
  check(
    'file card: MERCURY.md write in Implement offers Yes and No only',
    JSON.stringify(implementMercuryWrite.map(o => o.value)) === JSON.stringify(['accept-once', 'reject']),
    JSON.stringify(implementMercuryWrite.map(o => o.value)),
  )

  const flowEnvRead = getFilePermissionOptions({
    filePath: envFile,
    toolPermissionContext: ctxFor('flow'),
    operationType: 'read',
  })
  check(
    'file card: project-internal .env read in Flow offers Yes and No only',
    JSON.stringify(flowEnvRead.map(o => o.value)) === JSON.stringify(['accept-once', 'reject']),
    JSON.stringify(flowEnvRead.map(o => o.value)),
  )

  const nullPathDefault = getFilePermissionOptions({
    filePath: null,
    toolPermissionContext: ctxFor('default'),
    operationType: 'write',
  })
  check(
    'file card: null path offers Yes and No only',
    JSON.stringify(nullPathDefault.map(o => o.value)) === JSON.stringify(['accept-once', 'reject']),
    JSON.stringify(nullPathDefault.map(o => o.value)),
  )

  const rootFlowWrite = getFilePermissionOptions({
    filePath: '/rootfile.txt',
    toolPermissionContext: ctxFor('flow'),
    operationType: 'write',
  })
  check(
    'file card: filesystem root path in Flow offers Yes and No only when directory rule is empty',
    JSON.stringify(rootFlowWrite.map(o => o.value)) === JSON.stringify(['accept-once', 'reject']),
    JSON.stringify(rootFlowWrite.map(o => o.value)),
  )

  const defaultMercuryWrite = getFilePermissionOptions({
    filePath: mercuryMd,
    toolPermissionContext: ctxFor('default'),
    operationType: 'write',
  })
  check(
    'file card: MERCURY.md write in Default still offers option 2 (switches session to implement mode)',
    JSON.stringify(defaultMercuryWrite.map(o => o.value)) === JSON.stringify(['accept-once', 'accept-session', 'reject']),
    JSON.stringify(defaultMercuryWrite.map(o => o.value)),
  )

  const flowOutsideWrite = getFilePermissionOptions({
    filePath: outsideFile,
    toolPermissionContext: ctxFor('flow'),
    operationType: 'write',
  })
  check(
    'file card: outside-project write in Flow still offers option 2 (grants directory rule)',
    JSON.stringify(flowOutsideWrite.map(o => o.value)) === JSON.stringify(['accept-once', 'accept-session', 'reject']),
    JSON.stringify(flowOutsideWrite.map(o => o.value)),
  )

  const flowConfigWrite = getFilePermissionOptions({
    filePath: configFile,
    toolPermissionContext: ctxFor('flow'),
    operationType: 'write',
  })
  check(
    'file card: project config-home write in Flow still offers option 2 (grants config-home rule)',
    JSON.stringify(flowConfigWrite.map(o => o.value)) === JSON.stringify(['accept-once', 'accept-session', 'reject']),
    JSON.stringify(flowConfigWrite.map(o => o.value)),
  )

  const renderedFlowCard = await drawCard(
    React.createElement(FileWritePermissionRequest as never, {
      toolUseConfirm: {
        tool: FileWriteTool,
        input: { file_path: mercuryMd, content: '# flow probe\n' },
        toolUseID: 'flow-mercury',
        description: 'Write MERCURY.md',
        assistantMessage: { message: { id: 'card-grant' } },
        permissionResult: {
          behavior: 'ask',
          message: `Permission to write ${mercuryMd} is required: this file steers every later session.`,
          decisionReason: { type: 'safetyCheck', reason: `Permission to write ${mercuryMd} is required: this file steers every later session.` },
          suggestions: [],
        },
        permissionPromptStartTimeMs: Date.now(),
        onUserInteraction() {},
        onAllow() {},
        onReject() {},
        onAbort() {},
        recheckPermission: async () => {},
        toolUseContext: { readFileState: new Map() },
      },
      toolUseContext: { readFileState: new Map() },
      onDone() {},
      onReject() {},
      verbose: false,
    } as never),
    'flow',
  )
  const numbered = renderedFlowCard.filter(r => /^(❯ )?\d+\.\s/.test(r)).map(r => r.replace(/^❯ /, ''))
  check(
    'rendered card: MERCURY.md write in Flow closes up numbering to 1. Yes and 2. No',
    numbered.length === 2 &&
      numbered[0] === '1. Yes' &&
      numbered[1]?.startsWith('2. No, and tell Mercury what to do differently') === true &&
      !renderedFlowCard.some(r => r.includes('Yes, allow all edits')),
    JSON.stringify(numbered),
  )

  const emptyBashRules = bashToolUseOptions({
    suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'localSettings' }],
    onAcceptFeedbackChange() {},
    onRejectFeedbackChange() {},
    editablePrefix: 'echo *',
    onEditablePrefixChange() {},
  })
  check(
    'bash card: empty addRules suggestion offers Yes and No only',
    JSON.stringify(emptyBashRules.map(o => o.value)) === JSON.stringify(['yes', 'no']),
    JSON.stringify(emptyBashRules.map(o => o.value)),
  )

  const blankBashRule = bashToolUseOptions({
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: '   ' }], behavior: 'allow', destination: 'localSettings' }],
    onAcceptFeedbackChange() {},
    onRejectFeedbackChange() {},
    editablePrefix: '   ',
    onEditablePrefixChange() {},
  })
  check(
    'bash card: blank ruleContent suggestion offers Yes and No only',
    JSON.stringify(blankBashRule.map(o => o.value)) === JSON.stringify(['yes', 'no']),
    JSON.stringify(blankBashRule.map(o => o.value)),
  )

  const emptyPsRules = powershellToolUseOptions({
    suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'localSettings' }],
    onAcceptFeedbackChange() {},
    onRejectFeedbackChange() {},
    editablePrefix: 'Get-Process *',
    onEditablePrefixChange() {},
  })
  check(
    'powershell card: empty addRules suggestion offers Yes and No only',
    JSON.stringify(emptyPsRules.map(o => o.value)) === JSON.stringify(['yes', 'no']),
    JSON.stringify(emptyPsRules.map(o => o.value)),
  )

  const validBashRules = bashToolUseOptions({
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push *' }], behavior: 'allow', destination: 'localSettings' }],
    onAcceptFeedbackChange() {},
    onRejectFeedbackChange() {},
    editablePrefix: 'git push *',
    onEditablePrefixChange() {},
  })
  check(
    'bash card: non-empty suggestion still offers option 2',
    JSON.stringify(validBashRules.map(o => o.value)) === JSON.stringify(['yes', 'yes-edited-prefix', 'no']),
    JSON.stringify(validBashRules.map(o => o.value)),
  )

  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ guardrails: { disableSovereignMode: true } }))
  resetSettingsCache()
  const renderedComputerCard = await drawCard(
    React.createElement(ComputerPermissionRequest as never, {
      toolUseConfirm: {
        tool: ComputerTool,
        input: { action: 'read', clipboard: true },
        toolUseID: 'computer-disabled-sov',
        description: 'Read clipboard',
        assistantMessage: { message: { id: 'card-grant-computer' } },
        permissionResult: { behavior: 'ask', message: 'Read clipboard' },
        permissionPromptStartTimeMs: Date.now(),
        onUserInteraction() {},
        onAllow() {},
        onReject() {},
        onAbort() {},
        recheckPermission: async () => {},
        toolUseContext: {},
      },
      toolUseContext: {},
      onDone() {},
      onReject() {},
      verbose: false,
    } as never),
    'default',
  )
  const computerNumbered = renderedComputerCard.filter(r => /^(❯ )?\d+\.\s/.test(r)).map(r => r.replace(/^❯ /, ''))
  check(
    'computer card: when sovereign mode is disabled by policy, sovereign option is omitted',
    computerNumbered.length === 2 &&
      computerNumbered[0] === '1. Yes' &&
      computerNumbered[1]?.startsWith('2. No, and tell Mercury') === true &&
      !renderedComputerCard.some(r => r.includes('Enable sovereign mode')),
    JSON.stringify(computerNumbered),
  )
} finally {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(failures ? `Card options grant something: ${failures} FAILED` : 'Card options grant something: ALL PASS')
process.exit(failures ? 1 : 0)
