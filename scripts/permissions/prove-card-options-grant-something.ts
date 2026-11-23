import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
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

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.ts')
setOriginalCwd(projectDir)
setProjectRoot(projectDir)
setCwdState(projectDir)

const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { getFilePermissionOptions } = await import('../../src/permissions/cards/file-dialog/permissionOptions.tsx')
const { bashToolUseOptions } = await import('../../src/permissions/cards/bash/shellAskOptions.tsx')
const { powershellToolUseOptions } = await import('../../src/permissions/cards/powershell/powershellAskOptions.tsx')
const { FileWritePermissionRequest } = await import('../../src/permissions/cards/file-write/FileWritePermissionRequest.tsx')
const { ComputerPermissionRequest } = await import('../../src/permissions/cards/computer/ComputerPermissionRequest.tsx')
const { BashPermissionRequest } = await import('../../src/permissions/cards/bash/ShellPermissionRequest.tsx')
const { FileWriteTool } = await import('../../src/tools/write/WriteTool.ts')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { ComputerTool } = await import('../../src/tools/computer/ComputerTool.ts')
const { AsksPart } = await import('../../src/engine/connector/daemon/asks.ts')
const { publishSessionAsks } = await import('../../src/engine/connector/seatProjections.ts')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { render } = await import('../../src/screen/themedRenderer.ts')
const { default: stripAnsi } = await import('strip-ansi')
const { waitFor } = await import('../lib/settingsPopupHarness.ts')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.ts')
const { parseForSecurity } = await import('../../src/permissions/rules/decision/commandAnalysis.ts')

let failures = 0
const HINT =
  'change getFilePermissionOptions in src/permissions/cards/file-dialog/permissionOptions.tsx, bashToolUseOptions in src/permissions/cards/bash/shellAskOptions.tsx, powershellToolUseOptions in src/permissions/cards/powershell/powershellAskOptions.tsx, shellPermissionHelpers in src/permissions/cards/shellAskParts.tsx, ComputerPermissionRequest in src/permissions/cards/computer/ComputerPermissionRequest.tsx, AsksPart in src/engine/connector/daemon/asks.ts, or PermissionDialog / BashPermissionRequest in src/permissions/cards/'

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
  await waitFor(() => stripAnsi(instance.lastFrame()).trim() !== '', 3000)
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

  const crewSessionId = 'crew-card-session'
  publishSessionAsks({
    schema: 1,
    sessionId: crewSessionId,
    asks: [
      {
        requestId: 'req-crew',
        toolUseId: 'tu-crew',
        toolName: 'Bash',
        input: { command: 'wc -l src/*.js' },
        cwd: projectDir,
        agentId: 'scout-1',
        askedAt: Date.now(),
      },
      {
        requestId: 'req-main',
        toolUseId: 'tu-main',
        toolName: 'Bash',
        input: { command: 'wc -l src/*.js' },
        cwd: projectDir,
        askedAt: Date.now(),
      },
    ],
  })
  const asksPart = new AsksPart({
    record: () => ({ sessionId: crewSessionId }),
    rows: () => [],
    facts: () => ({
      model: { effective: 'claude-sonnet-5-5', setting: null },
      work: [
        {
          id: 'task-scout',
          kind: 'agent',
          agentId: 'scout-1',
          agentType: 'mercury-scout',
          name: 'Count lines in src files',
          status: 'running',
          startTime: Date.now(),
        },
      ],
    }) as never,
    permissionMode: () => 'default',
    chainRpc: async () => ({ ok: true, outcome: 'applied' }),
    deliver: async () => ({ ok: true }) as never,
  })
  asksPart.readAsks()
  const crewConfirm = asksPart.asks().find(a => a.id === 'req-crew')!.confirm as { crewmate?: string }
  const mainConfirm = asksPart.asks().find(a => a.id === 'req-main')!.confirm as { crewmate?: string }
  check(
    'crewmate ask: AsksPart stamps the transcript crewmate line on the confirm and leaves main asks unset',
    crewConfirm.crewmate === '△ mercury-scout Count lines in src files' && mainConfirm.crewmate === undefined,
    JSON.stringify({ crew: crewConfirm.crewmate, main: mainConfirm.crewmate }),
  )

  const bashCrewFrame = await drawCard(
    React.createElement(BashPermissionRequest as never, {
      toolUseConfirm: {
        ...crewConfirm,
        tool: BashTool,
        description: 'Run a shell command',
        cwd: projectDir,
        permissionResult: { behavior: 'ask', message: 'Run a shell command' },
      },
      toolUseContext: {},
      onDone() {},
      onReject() {},
      verbose: false,
    } as never),
    'default',
  )
  const bashMainFrame = await drawCard(
    React.createElement(BashPermissionRequest as never, {
      toolUseConfirm: {
        ...mainConfirm,
        tool: BashTool,
        description: 'Run a shell command',
        cwd: projectDir,
        permissionResult: { behavior: 'ask', message: 'Run a shell command' },
      },
      toolUseContext: {},
      onDone() {},
      onReject() {},
      verbose: false,
    } as never),
    'default',
  )
  const folderRowIndex = bashCrewFrame.findIndex(r => r.startsWith('in '))
  const crewRowIndex = bashCrewFrame.findIndex(r => r === '△ mercury-scout Count lines in src files')
  check(
    'crewmate bash card: names the crewmate in transcript form right beside the folder line',
    folderRowIndex >= 0 && crewRowIndex === folderRowIndex + 1,
    JSON.stringify({ folderRowIndex, crewRowIndex, bashCrewFrame }),
  )
  check(
    'main bash card: carries no crewmate line and matches a main-agent card byte for byte',
    !bashMainFrame.some(r => r.includes('△')) &&
      bashCrewFrame.filter(r => r !== '△ mercury-scout Count lines in src files').join('\n') === bashMainFrame.join('\n'),
    JSON.stringify({ bashMainFrame }),
  )

  const fileCrewFrame = await drawCard(
    React.createElement(FileWritePermissionRequest as never, {
      toolUseConfirm: {
        tool: FileWriteTool,
        input: { file_path: outsideFile, content: 'x\n' },
        toolUseID: 'file-crew',
        description: 'Write file',
        assistantMessage: { message: { id: 'card-crew-file' } },
        permissionResult: { behavior: 'ask', message: 'Write file' },
        permissionPromptStartTimeMs: Date.now(),
        crewmate: '△ mercury-scout Count lines in src files',
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
    'default',
  )
  check(
    'crewmate file card: names the crewmate in transcript form on non-shell cards too',
    fileCrewFrame.includes('△ mercury-scout Count lines in src files'),
    JSON.stringify(fileCrewFrame),
  )

  {
    const flowState = { toolPermissionContext: ctxFor('flow'), tasks: {}, sessionHooks: new Map() }
    const flowCtx = {
      abortController: new AbortController(),
      getAppState: () => flowState,
      setAppState() {},
      options: { tools: [BashTool, FileWriteTool] },
      messages: [],
    } as never
    const flowAssistant = { message: { id: 'flow-item6' } } as never

    const cdRedirect = 'cd ~ && echo x > notes-from-the-test.txt'
    await parseForSecurity(cdRedirect)
    const cdAsk = (await decideToolPermissionWithModes(BashTool as never, { command: cdRedirect }, flowCtx, flowAssistant, 'flow-cd-write')).decision
    check(
      'flow outside-write compound command: asks and drops ineffective Read+Bash suggestions',
      cdAsk.behavior === 'ask' && (cdAsk.suggestions === undefined || cdAsk.suggestions.length === 0),
      JSON.stringify(cdAsk),
    )

    const cdCard = await drawCard(
      React.createElement(BashPermissionRequest as never, {
        toolUseConfirm: {
          tool: BashTool,
          input: { command: cdRedirect },
          toolUseID: 'flow-cd-write',
          description: 'Run a shell command',
          cwd: projectDir,
          assistantMessage: flowAssistant,
          permissionResult: cdAsk,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {},
          onAllow() {},
          onReject() {},
          onAbort() {},
          recheckPermission: async () => {},
          toolUseContext: flowCtx,
        },
        toolUseContext: flowCtx,
        onDone() {},
        onReject() {},
        verbose: false,
      } as never),
      'flow',
    )
    const cdNumbered = cdCard.filter(r => /^(❯ )?\d+\.\s/.test(r)).map(r => r.replace(/^❯ /, ''))
    check(
      'flow outside-write compound card: offers Yes and No only and never says allow reading',
      cdNumbered.length === 2 &&
        cdNumbered[0] === '1. Yes' &&
        cdNumbered[1]?.startsWith('2. No, and tell Mercury what to do differently') === true &&
        !cdCard.some(r => r.includes('allow reading')),
      JSON.stringify(cdNumbered),
    )

    const cpOutside = 'cp a.txt ~/outside.txt'
    await parseForSecurity(cpOutside)
    const cpAsk = (await decideToolPermissionWithModes(BashTool as never, { command: cpOutside }, flowCtx, flowAssistant, 'flow-cp-write')).decision
    check(
      'flow outside-write cp: drops ineffective project-dir Edit suggestion',
      cpAsk.behavior === 'ask' && (cpAsk.suggestions === undefined || cpAsk.suggestions.length === 0),
      JSON.stringify(cpAsk),
    )

    const pushCmd = 'git push origin main'
    await parseForSecurity(pushCmd)
    const pushAsk = (await decideToolPermissionWithModes(BashTool as never, { command: pushCmd }, flowCtx, flowAssistant, 'flow-push')).decision
    check(
      'flow git push: keeps its effective suggestion because it allows the command next time',
      pushAsk.behavior === 'ask' && Array.isArray(pushAsk.suggestions) && pushAsk.suggestions.length > 0,
      JSON.stringify(pushAsk),
    )

    const sudoCmd = 'sudo -n true'
    await parseForSecurity(sudoCmd)
    const sudoAsk = (await decideToolPermissionWithModes(BashTool as never, { command: sudoCmd }, flowCtx, flowAssistant, 'flow-sudo')).decision
    check(
      'flow sudo: keeps its effective suggestion because it allows the command next time',
      sudoAsk.behavior === 'ask' && Array.isArray(sudoAsk.suggestions) && sudoAsk.suggestions.length > 0,
      JSON.stringify(sudoAsk),
    )

    const pushSaved: unknown[] = []
    const pushCardLines = await drawCard(
      React.createElement(BashPermissionRequest as never, {
        toolUseConfirm: {
          tool: BashTool,
          input: { command: 'git push' },
          toolUseID: 'shell-words-push',
          description: 'Run a shell command',
          cwd: projectDir,
          assistantMessage: flowAssistant,
          permissionResult: pushAsk,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {},
          onAllow(_input: unknown, rules: unknown[]) {
            pushSaved.push(rules)
          },
          onReject() {},
          onAbort() {},
          recheckPermission: async () => {},
          toolUseContext: flowCtx,
        },
        toolUseContext: flowCtx,
        onDone() {},
        onReject() {},
        verbose: false,
      } as never),
      'flow',
    )
    const pushOption2 = pushCardLines.find(r => /^2\./.test(r)) ?? ''
    check(
      'shell card option 2 (wildcard): single space after 2. and with:, no trailing star',
      pushOption2 === "2. Yes, and don't ask again for commands starting with: git push",
      JSON.stringify(pushOption2),
    )

    const sudoCardLines = await drawCard(
      React.createElement(BashPermissionRequest as never, {
        toolUseConfirm: {
          tool: BashTool,
          input: { command: sudoCmd },
          toolUseID: 'shell-words-sudo',
          description: 'Run a shell command',
          cwd: projectDir,
          assistantMessage: flowAssistant,
          permissionResult: sudoAsk,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {},
          onAllow() {},
          onReject() {},
          onAbort() {},
          recheckPermission: async () => {},
          toolUseContext: flowCtx,
        },
        toolUseContext: flowCtx,
        onDone() {},
        onReject() {},
        verbose: false,
      } as never),
      'flow',
    )
    const sudoOption2 = sudoCardLines.find(r => /^2\./.test(r)) ?? ''
    check(
      'shell card option 2 (exact): single space after 2. and with:',
      sudoOption2 === "2. Yes, and don't ask again for commands starting with: sudo -n true",
      JSON.stringify(sudoOption2),
    )

    {
      const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
      const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
      const { mountOffscreen, KEY } = await import('../lib/settingsPopupHarness.ts')
      const savedRules: unknown[][] = []
      for (const [cmd, askResult] of [
        ['git push', pushAsk],
        [sudoCmd, sudoAsk],
      ] as const) {
        const base = getDefaultAppState()
        const initialState = { ...base, toolPermissionContext: { ...base.toolPermissionContext, mode: 'flow' as const } }
        let captured: unknown[] = []
        const scene = await mountOffscreen(
          React.createElement(
            ThemeProvider as never,
            null,
            React.createElement(
              AppStateProvider as never,
              { initialState } as never,
              React.createElement(
                KeybindingSetup as never,
                null,
                React.createElement(BashPermissionRequest as never, {
                  toolUseConfirm: {
                    tool: BashTool,
                    input: { command: cmd },
                    toolUseID: `save-${cmd}`,
                    description: 'Run a shell command',
                    cwd: projectDir,
                    assistantMessage: flowAssistant,
                    permissionResult: askResult,
                    permissionPromptStartTimeMs: Date.now(),
                    onUserInteraction() {},
                    onAllow(_input: unknown, rules: unknown[]) {
                      captured = rules
                    },
                    onReject() {},
                    onAbort() {},
                    recheckPermission: async () => {},
                    toolUseContext: flowCtx,
                  },
                  toolUseContext: flowCtx,
                  onDone() {},
                  onReject() {},
                  verbose: false,
                } as never),
              ),
            ),
          ),
          100,
          40,
        )
        await new Promise(resolve => setTimeout(resolve, 120))
        scene.push(KEY.down)
        await new Promise(resolve => setTimeout(resolve, 100))
        scene.push(KEY.enter)
        await new Promise(resolve => setTimeout(resolve, 100))
        scene.unmount()
        savedRules.push(captured)
      }
      const pushRule = (savedRules[0]?.[0] as { rules?: Array<{ ruleContent?: string }> } | undefined)?.rules?.[0]?.ruleContent
      const sudoRule = (savedRules[1]?.[0] as { rules?: Array<{ ruleContent?: string }> } | undefined)?.rules?.[0]?.ruleContent
      check(
        'shell card option 2 save: git push still saves Bash(git push *) and sudo still saves exact rule',
        pushRule === 'git push *' && sudoRule === 'sudo -n true',
        JSON.stringify({ pushRule, sudoRule }),
      )
    }
    void pushSaved
  }

  {
    const { homedir } = await import('node:os')
    const words = (node: unknown): string => {
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(words).join('')
      if (node !== null && typeof node === 'object' && 'props' in node) return words((node as { props: { children?: unknown } }).props.children)
      return ''
    }
    const projDocs = join(projectDir, 'docs')
    const outsideDocs = join(outsideDir, 'docs')
    mkdirSync(projDocs, { recursive: true })
    mkdirSync(outsideDocs, { recursive: true })
    const outsideDocsFile = join(outsideDocs, 'SESSIONS.md')
    const fromHome = relative(homedir(), outsideDocs)
    const outsideShown = fromHome.startsWith('..') || isAbsolute(fromHome) ? `${outsideDocs}${sep}` : `~/${fromHome.split(sep).join('/')}/`
    const outsideReadOpts = getFilePermissionOptions({
      filePath: outsideDocsFile,
      toolPermissionContext: ctxFor('default'),
      operationType: 'read',
    }).map(o => words(o.label))
    check(
      'outside-read option 2: names full folder path (not ambiguous docs/)',
      outsideReadOpts[1] === `Yes, allow reading from ${outsideShown} for this session`,
      JSON.stringify(outsideReadOpts[1]),
    )

    const outsideWriteOpts = getFilePermissionOptions({
      filePath: outsideDocsFile,
      toolPermissionContext: ctxFor('default'),
      operationType: 'write',
    }).map(o => words(o.label))
    check(
      'outside-write option 2: names full folder path (not ambiguous docs/)',
      outsideWriteOpts[1] === `Yes, allow all edits in ${outsideShown} for this session (shift+tab)`,
      JSON.stringify(outsideWriteOpts[1]),
    )

    const underHomeFile = join(homedir(), 'mercury-outside-probe', 'docs', 'SESSIONS.md')
    const homeReadOpts = getFilePermissionOptions({
      filePath: underHomeFile,
      toolPermissionContext: ctxFor('default'),
      operationType: 'read',
    }).map(o => words(o.label))
    check(
      'outside-read under home: uses ~ prefix with full folder path',
      homeReadOpts[1] === 'Yes, allow reading from ~/mercury-outside-probe/docs/ for this session',
      JSON.stringify(homeReadOpts[1]),
    )

    const winReadOpts = getFilePermissionOptions({
      filePath: 'C:\\src\\mrc2-3bdb\\docs\\SESSIONS.md',
      toolPermissionContext: ctxFor('default'),
      operationType: 'read',
    }).map(o => words(o.label))
    check(
      'outside-read Windows path: names full C:\\src\\mrc2-3bdb\\docs\\ folder',
      winReadOpts[1] === 'Yes, allow reading from C:\\src\\mrc2-3bdb\\docs\\ for this session',
      JSON.stringify(winReadOpts[1]),
    )
  }
} finally {
  process.chdir(originalCwd)
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(failures ? `Card options grant something: ${failures} FAILED` : 'Card options grant something: ALL PASS')
process.exit(failures ? 1 : 0)
