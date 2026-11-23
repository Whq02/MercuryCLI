#!/usr/bin/env bun
import { mock } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const hostCwd = process.cwd()
const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const scratch = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'cgc-')))
const HOST = { project: path.join(scratch, 'proj'), outside: path.join(scratch, 'out'), home: path.join(scratch, 'home') }
const BOX = { project: 'C:\\src\\fl1012\\u25-m2\\P', outside: 'C:\\src\\fl1012\\t22-outside', home: 'C:\\src\\scratch-1012\\lead\\dc43\\decoy-home' }
for (const folder of [HOST.project, HOST.outside, HOST.home, path.join(scratch, 'config'), path.join(scratch, 'bin')]) mkdirSync(folder, { recursive: true })
writeFileSync(path.join(HOST.project, 'notes.txt'), 'notes\n')
writeFileSync(path.join(HOST.project, 'a.txt'), 'a\n')

process.env.MERCURY_CONFIG_DIR = path.join(scratch, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

if (hostPlatform.value !== 'win32') {
  const reader = path.join(scratch, 'bin', 'pwsh-ast.mjs')
  writeFileSync(
    reader,
    [
      "const encoded = process.argv[process.argv.indexOf('-EncodedCommand') + 1]",
      "const program = Buffer.from(encoded, 'base64').toString('utf16le')",
      "const command = Buffer.from(/^\\$c = '([^']*)'/.exec(program)[1], 'base64').toString('utf8')",
      "const element = word => (/^-[A-Za-z]/.test(word) ? { type: 'CommandParameterAst', text: word } : { type: 'StringConstantExpressionAst', text: word, value: word })",
      "const statements = command.split(';').map(part => part.trim()).filter(Boolean).map(text => ({ type: 'PipelineAst', text, elements: [{ type: 'CommandAst', text, redirections: [], elements: text.split(/\\s+/).map(element) }], nestedCommands: [], redirections: [], securityPatterns: {} }))",
      "process.stdout.write(JSON.stringify({ valid: true, statements, variables: [], errors: [], hasStopParsing: false, command }))",
    ].join('\n'),
  )
  writeFileSync(path.join(scratch, 'bin', 'pwsh'), `#!/bin/sh\nexec "${process.execPath}" "${reader}" "$@"\n`)
  chmodSync(path.join(scratch, 'bin', 'pwsh'), 0o755)
  process.env.PATH = `${path.join(scratch, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`
}

let home = HOST.home
mock.module('node:os', () => ({ ...os, homedir: () => home }))
if (hostPlatform.value !== 'win32') {
  const { posix, win32 } = path
  const drive = (word: string): boolean => /^[A-Za-z]:[\\/]/.test(word)
  mock.module('node:path', () => ({
    ...path,
    resolve: (...words: string[]) => (words.some(drive) ? win32 : posix).resolve(...words),
    dirname: (word: string) => (drive(word) ? win32 : posix).dirname(word),
    isAbsolute: (word: string) => (drive(word) ? win32 : posix).isAbsolute(word),
  }))
}
process.chdir(HOST.project)

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { getPlatform } = await import('../../src/platform/environment/platform.ts')
const { setCwdState, setOriginalCwd, setProjectRoot } = await import('../../src/boot/process-state/processState.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { getResolvedWorkingDirPaths } = await import('../../src/permissions/rules/filesystem.ts')
const { applyPermissionUpdates } = await import('../../src/permissions/rules/permissionUpdate.ts')
const { decideToolPermissionWithModes } = await import('../../src/permissions/rules/decision/wrapper.ts')
const { pinnedCommandAnalysis } = await import('../../src/permissions/rules/decision/commandAnalysis.ts')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { PowerShellTool } = await import('../../src/tools/powershell/PowerShellTool.tsx')
const { BashPermissionRequest } = await import('../../src/permissions/cards/bash/ShellPermissionRequest.tsx')
const { PowerShellPermissionRequest } = await import('../../src/permissions/cards/powershell/PowerShellPermissionRequest.tsx')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.tsx')
const { KEY, mountOffscreen, waitFor } = await import('../lib/settingsPopupHarness.ts')

type Mode = 'default' | 'implement' | 'flow'
type Decision = { behavior: string; message?: string; suggestions?: unknown[] }
type Asked = { decision: Decision; choices: string[]; repeat: string; handed: unknown[] | null }

const NO = '2. No, and tell Mercury what to do differently (esc)'
const MODE_WORDS: Record<Mode, string> = { default: 'Default', implement: 'Implement', flow: 'Flow' }
const WHERE =
  'a choice whose rules leave the same call asking, or that needs a mode switch its words do not name, must not reach the card: drop it where the ask is settled, askWithCoveringGrant under decideToolPermissionWithModes in src/permissions/rules/decision/wrapper.ts; the words of a choice that stays are generateShellSuggestionsLabel in src/permissions/cards/shellAskParts.tsx'

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — ${WHERE}`}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)

function stand(world: { project: string; home: string }, windows: boolean): void {
  home = world.home
  process.env.HOME = process.env.USERPROFILE = world.home
  Object.defineProperty(process, 'platform', windows ? { ...hostPlatform, value: 'win32' } : hostPlatform)
  if (windows) getPlatform.cache.set(undefined, 'windows')
  else getPlatform.cache.delete(undefined)
  setOriginalCwd(world.project)
  setProjectRoot(world.project)
  setCwdState(world.project)
  getResolvedWorkingDirPaths.clearCache()
}

async function ask(tool: typeof BashTool | typeof PowerShellTool, command: string, mode: Mode, askRules: string[] = []): Promise<Asked> {
  let rules: ReturnType<typeof getEmptyToolPermissionContext> = { ...getEmptyToolPermissionContext(), mode, alwaysAskRules: { userSettings: askRules } }
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: rules, tasks: {}, sessionHooks: new Map() }),
    setAppState() {},
    options: { tools: [BashTool, PowerShellTool] },
    messages: [],
  } as never
  const assistant = { message: { id: 'card-grant-covers' } } as never
  const decide = async (): Promise<Decision> => (await decideToolPermissionWithModes(tool as never, { command }, context, assistant, 'card-grant-covers')).decision as Decision
  const decision = await decide()
  if (decision.behavior !== 'ask') return { decision, choices: [], repeat: 'never asked', handed: null }

  const pinned = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', hostPlatform)
  let granted: unknown[] | null = null
  const base = getDefaultAppState()
  const scene = await mountOffscreen(
    React.createElement(
      ThemeProvider as never,
      null,
      React.createElement(
        AppStateProvider as never,
        { initialState: { ...base, toolPermissionContext: { ...base.toolPermissionContext, mode } } } as never,
        React.createElement(
          KeybindingSetup as never,
          null,
          React.createElement((tool === BashTool ? BashPermissionRequest : PowerShellPermissionRequest) as never, {
            toolUseConfirm: {
              tool,
              input: { command },
              toolUseID: 'card-grant-covers',
              description: 'Run a shell command',
              assistantMessage: assistant,
              permissionResult: decision,
              permissionPromptStartTimeMs: Date.now(),
              onUserInteraction() {},
              onAllow(_input: unknown, updates: unknown[]) {
                granted = updates
              },
              onReject() {},
              onAbort() {},
              recheckPermission: async () => {},
              toolUseContext: context,
            },
            toolUseContext: context,
            onDone() {},
            onReject() {},
            verbose: false,
          } as never),
        ),
      ),
    ),
    220,
    40,
  )
  const drawn = (): string[] => scene.lines().map(line => line.replace(/^[│\s]+|[│\s]+$/g, '')).filter(line => /^(❯ )?\d+\.\s/.test(line))
  await waitFor(() => drawn().some(line => line.includes('No, and tell Mercury')), 5000)
  const choices = drawn().map(line => line.replace(/^❯ /, ''))
  let repeat = 'no choice to take'
  if (choices.length === 3) {
    scene.push(KEY.down)
    await waitFor(() => drawn().some(line => line.startsWith('❯ 2.')), 5000)
    scene.push(KEY.enter)
    await waitFor(() => granted !== null, 5000)
  }
  scene.unmount()
  Object.defineProperty(process, 'platform', pinned)
  if (choices.length === 3) {
    if (granted === null) repeat = 'the choice was not taken'
    else {
      rules = applyPermissionUpdates(rules, granted as never)
      const again = await decide()
      repeat = again.behavior === 'allow' ? 'runs with no second card' : `asks again: ${again.message ?? again.behavior}`
    }
  }
  return { decision, choices, repeat, handed: granted }
}

const yesNoOnly = (asked: Asked): boolean => asked.decision.behavior === 'ask' && j(asked.choices) === j(['1. Yes', NO])
const shown = (asked: Asked): string => j({ behavior: asked.decision.behavior, choices: asked.choices, repeat: asked.repeat, suggestions: asked.decision.suggestions })

const BOX_COMMANDS = {
  homeWrite: 'cd ~ && echo x > u25-home-b.txt',
  outsideRedirect: 'echo out > /c/src/fl1012/t22-outside/out-u25b.txt',
  psOutside: `Set-Content -Path ${BOX.outside}\\out-u25.txt -Value out`,
  psTilde: 'Set-Content -Path ~\\u25-tilde.txt -Value y',
  psOutsidePlain: `Set-Content ${BOX.outside}\\out-u25.txt out`,
  psInside: 'Remove-Item notes.txt',
}

try {
  for (const command of [BOX_COMMANDS.psOutside, BOX_COMMANDS.psTilde, BOX_COMMANDS.psOutsidePlain, BOX_COMMANDS.psInside]) await pinnedCommandAnalysis.parsePowerShellCommand(command)

  section('§1 the Windows box: its folders, its home, its three cards (a pinned platform)')
  {
    stand(BOX, true)
    const parsed = await pinnedCommandAnalysis.parsePowerShellCommand(BOX_COMMANDS.psOutside)
    const classes = parsed.statements[0]?.commands[0]?.elementTypes
    check(
      "the PowerShell reading is the real parser's: the command's own class leads the argument classes",
      parsed.valid && j(classes) === j(['StringConstant', 'Parameter', 'StringConstant', 'Parameter', 'StringConstant']),
      `${j(classes)} ${j(parsed.errors)}; this row only says the stand-in pwsh of this proof was read`,
    )

    const homeWrite = await ask(BashTool, BOX_COMMANDS.homeWrite, 'default')
    check('(a) Default, Bash `cd ~ && echo x > file`: Yes and No only — no rule lifts a redirect after a cd', yesNoOnly(homeWrite), shown(homeWrite))

    for (const command of [BOX_COMMANDS.psOutside, BOX_COMMANDS.psTilde, BOX_COMMANDS.psOutsidePlain, BOX_COMMANDS.psInside]) {
      const write = await ask(PowerShellTool, command, 'default')
      check(`(b) Default, PowerShell \`${command}\`: Yes and No only — a folder rule alone never runs it again, and the card names no mode switch`, yesNoOnly(write), shown(write))
    }

    const implement = await ask(PowerShellTool, BOX_COMMANDS.psOutsidePlain, 'implement')
    check(
      `(b) Implement, PowerShell \`${BOX_COMMANDS.psOutsidePlain}\`: the choice names the folder the write goes to and never calls it this project`,
      implement.choices[1] === `2. Yes, and allow file edits in ${BOX.outside}`,
      shown(implement),
    )
    check(
      '(b) Implement: taking that choice hands over folder rules only, no mode switch, and repeating the command brings no second card',
      implement.repeat === 'runs with no second card' && implement.handed !== null && implement.handed.length > 0 && implement.handed.every(update => (update as { type?: string }).type === 'addRules'),
      `${shown(implement)} handed ${j(implement.handed)}`,
    )

    for (const mode of ['default', 'flow'] as const) {
      const redirect = await ask(BashTool, BOX_COMMANDS.outsideRedirect, mode)
      check(
        `(c) ${MODE_WORDS[mode]}, Bash \`${BOX_COMMANDS.outsideRedirect}\`: the choice names the folder the write goes to and never calls it this project`,
        redirect.choices[1] === `2. Yes, and allow file edits in ${BOX.outside}`,
        shown(redirect),
      )
      check(`(c) ${MODE_WORDS[mode]}: taking that choice and repeating the command brings no second card`, redirect.repeat === 'runs with no second card', shown(redirect))
    }
  }

  section("§2 this machine's own disk: the same three shapes, and every choice a Default card keeps")
  {
    stand(HOST, false)
    const homeWrite = await ask(BashTool, 'cd ~ && echo x > u25-home-b.txt', 'default')
    check('(a) Default, Bash `cd ~ && echo x > file`: Yes and No only', yesNoOnly(homeWrite), shown(homeWrite))

    const outsideFile = path.join(HOST.outside, 'out.txt')
    const redirect = await ask(BashTool, `echo out > ${outsideFile}`, 'default')
    check(
      '(c) Default, Bash redirect into a folder outside the project: the choice names that folder and never calls it this project',
      /^2\. Yes, and allow file edits in \S+\/$/.test(redirect.choices[1] ?? '') && (redirect.choices[1] ?? '').endsWith(`${path.basename(HOST.outside)}/`),
      shown(redirect),
    )
    check('(c) taking that choice and repeating the command brings no second card', redirect.repeat === 'runs with no second card', shown(redirect))

    const insideWrite = await ask(BashTool, 'echo x > made-here.txt', 'default')
    check(
      'a redirect into the project keeps "in this project" on its choice, and taking it ends the cards',
      /^2\. Yes, and allow file edits in \S+\/ in this project$/.test(insideWrite.choices[1] ?? '') && insideWrite.repeat === 'runs with no second card',
      shown(insideWrite),
    )

    const kept: string[] = []
    for (const command of [
      'rm notes.txt',
      `touch ${path.join(HOST.outside, 'new.txt')}`,
      'cp a.txt ~/copied.txt',
      'mkdir made',
      `cat ${path.join(HOST.outside, 'a.txt')}`,
      `cd ${HOST.outside} && ls`,
      ['git', 'push', 'origin', 'main'].join(' '),
      'sudo -n true',
      'wc -l *.txt',
    ]) {
      const asked = await ask(BashTool, command, 'default')
      const covered = asked.choices.length < 3 || asked.repeat === 'runs with no second card'
      if (asked.choices.length === 3) kept.push(command)
      check(`Default, Bash \`${command.replaceAll(scratch, '<scratch>')}\`: ${asked.choices.length === 3 ? 'its choice ends the cards' : 'Yes and No only'}`, asked.decision.behavior === 'ask' && covered, shown(asked))
    }
    check('the commands a rule can lift still carry their choice (a read outside, a cd outside, a push, sudo)', kept.length === 4, j(kept))

    for (const mode of ['default', 'flow'] as const) {
      const ownRule = await ask(BashTool, 'make build && npm run lint', mode, ['Bash(make *)'])
      check(`${MODE_WORDS[mode]}, Bash \`make build && npm run lint\` under the user's ask rule Bash(make *): Yes and No only — no rule for the other part ends that ask`, yesNoOnly(ownRule), shown(ownRule))
    }
  }
} finally {
  Object.defineProperty(process, 'platform', hostPlatform)
  getPlatform.cache.delete(undefined)
  process.chdir(hostCwd)
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS prove-card-grant-covers-the-ask' : `\nFAIL prove-card-grant-covers-the-ask: ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
