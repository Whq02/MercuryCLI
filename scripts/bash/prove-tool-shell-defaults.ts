#!/usr/bin/env bun
import { plugin } from 'bun'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

plugin({
  name: 'tool-shell-defaults-native-stub',
  setup(build) {
    build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
  },
})

const ROOT = resolve(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tool-shell-defaults-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.HOME = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.HOME, { recursive: true })
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let hint = ''
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
const state = await import('../../src/boot/process-state/processState.ts')
const owner = await import('../../src/platform/processes/subprocessEnv.ts') as {
  TOOL_SHELL_DEFAULTS?: Readonly<Record<string, string>>
  toolShellEnv?: (env: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv, platform?: string) => NodeJS.ProcessEnv
  withLoginExports?: (env: NodeJS.ProcessEnv, carried: NodeJS.ProcessEnv | undefined, scrubbed: readonly string[], platform?: string) => NodeJS.ProcessEnv
  subprocessEnv: (options?: { stripProviderCredentials?: boolean; platform?: string }) => NodeJS.ProcessEnv
}
const defaults = owner.TOOL_SHELL_DEFAULTS ?? {}
const compose = owner.toolShellEnv ?? ((env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}) => ({ ...env, ...overrides }))
const windows = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
const names = [...new Set([...Object.keys(defaults), ...Object.keys(windows), 'GH_PAGER', 'EDITOR', 'GIT_EDITOR', 'PAGER', 'CI', 'TERM'])]
for (const name of names) delete process.env[name]
state.setIsInteractive(true)
if (process.platform !== 'win32') process.env.SHELL = '/bin/bash'
const { exec, setCwd } = await import('../../src/platform/shell/shellExec.ts')
const { endEngineSession, resolveShellEngine } = await import('../../src/platform/shell/engineSession.ts')
const { quote } = await import('../../src/platform/shell/bash/shellQuote.ts')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
const { applyConfigEnvironmentVariables } = await import('../../src/platform/environment/settingsEnv.ts')
const probe = join(scratch, 'environment.cjs')
writeFileSync(probe, `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))))`)
setCwd(scratch)
async function readChild(): Promise<NodeJS.ProcessEnv> {
  const handle = await exec(quote([process.execPath, probe]), new AbortController().signal, 'bash', { timeout: 30_000, shouldAutoBackground: false })
  const result = await handle.result
  check('the environment probe exits normally', result.code === 0 && !result.interrupted, `rc=${result.code}`)
  try { return JSON.parse(result.stdout.trim()) as NodeJS.ProcessEnv } catch { check('the probe returned its JSON', false, JSON.stringify(result)); return {} }
}

try {
  console.log('defaults')
  hint = 'fix TOOL_SHELL_DEFAULTS and toolShellEnv in src/platform/processes/subprocessEnv.ts'
  check('one table owns pager, editor and package prompt defaults', defaults.GH_PAGER === 'cat' && defaults.EDITOR === 'true' && defaults.npm_config_yes === 'false')
  for (const platform of ['darwin', 'linux', 'win32']) {
    const input: NodeJS.ProcessEnv = { PATH: 'staged-path', UNRELATED: 'unchanged' }
    const child = compose(input, {}, platform)
    check(`${platform}: every table entry reaches an empty tool environment`, Object.entries(defaults).every(([key, value]) => child[key] === value))
    check(`${platform}: input and unrelated bytes stay untouched`, JSON.stringify(input) === JSON.stringify({ PATH: 'staged-path', UNRELATED: 'unchanged' }) && child.PATH === input.PATH && child.UNRELATED === input.UNRELATED)
    check(`${platform}: CI and TERM remain absent`, child.CI === undefined && child.TERM === undefined)
    check(`${platform}: UTF-8 defaults are Windows-only`, Object.entries(windows).every(([key, value]) => platform === 'win32' ? child[key] === value : child[key] === undefined))
  }
  check('an interactive non-tool child gets no tool defaults', owner.subprocessEnv().GH_PAGER === undefined && owner.subprocessEnv().EDITOR === undefined)

  hint = 'the table in src/platform/processes/subprocessEnv.ts (TOOL_SHELL_DEFAULTS, toolShellEnv) must reach the child through exec in src/platform/shell/shellExec.ts on this engine; resolveShellEngine in src/platform/shell/engineSession.ts decides the engine'
  const engines = process.platform === 'win32' ? ['brush'] : (resolveShellEngine('brush').engine === 'brush' ? ['system', 'brush'] : ['system'])
  for (const engine of engines) {
    await endEngineSession()
    process.env.MERCURY_SHELL_ENGINE = engine
    check(`${engine}: the requested road is available`, resolveShellEngine().engine === engine)
    const child = await readChild()
    check(`${engine}: pagers and editors are non-interactive on an interactive session`, child.GH_PAGER === 'cat' && child.EDITOR === 'true', JSON.stringify({ GH_PAGER: child.GH_PAGER, EDITOR: child.EDITOR }))
    check(`${engine}: the real shell inherits the entire table`, Object.entries(defaults).every(([key, value]) => child[key] === value), Object.entries(defaults).filter(([key, value]) => child[key] !== value).map(([key]) => key).join(', '))
  }

  console.log('refusals')
  hint = 'fix toolShellEnv (or withLoginExports) in src/platform/processes/subprocessEnv.ts: a value the user or the settings already set must win over a default, and Windows keys match case-insensitively'
  for (const platform of ['darwin', 'linux', 'win32']) {
    const table = platform === 'win32' ? { ...defaults, ...windows } : defaults
    for (const value of ['', 'operator value']) {
      const user = Object.fromEntries(Object.keys(table).map(key => [key, value]))
      const child = compose(user, {}, platform)
      check(`${platform}: all user-set keys survive (${JSON.stringify(value)})`, Object.keys(table).every(key => child[key] === value))
      const settings = Object.fromEntries(Object.keys(table).map(key => [key, `settings ${value}`]))
      const configured = compose(user, settings, platform)
      check(`${platform}: every explicit override survives`, Object.keys(table).every(key => configured[key] === settings[key]))
    }
    const unsetValue = compose({ PAGER: undefined, GIT_EDITOR: undefined }, {}, platform)
    check(`${platform}: undefined input entries count as absent and receive defaults`, unsetValue.PAGER === 'cat' && unsetValue.GIT_EDITOR === 'true', JSON.stringify({ PAGER: unsetValue.PAGER, GIT_EDITOR: unsetValue.GIT_EDITOR }))
    const packageUser = compose({ NPM_CONFIG_YES: 'false', pnpm_config_update_notifier: 'true' }, {}, platform)
    check(`${platform}: package config casing never shadows a user value`, packageUser.NPM_CONFIG_YES === 'false' && packageUser.npm_config_yes === undefined && packageUser.pnpm_config_update_notifier === 'true' && packageUser.PNPM_CONFIG_UPDATE_NOTIFIER === undefined, JSON.stringify({ NPM_CONFIG_YES: packageUser.NPM_CONFIG_YES, npm_config_yes: packageUser.npm_config_yes, pnpm_config_update_notifier: packageUser.pnpm_config_update_notifier, PNPM_CONFIG_UPDATE_NOTIFIER: packageUser.PNPM_CONFIG_UPDATE_NOTIFIER }))
    const dedupedPackage = compose({ NPM_CONFIG_YES: 'true', npm_config_yes: 'false' }, {}, platform)
    check(`${platform}: package config casing in input deduplicates to the latest key`, dedupedPackage.npm_config_yes === 'false' && dedupedPackage.NPM_CONFIG_YES === undefined, JSON.stringify({ NPM_CONFIG_YES: dedupedPackage.NPM_CONFIG_YES, npm_config_yes: dedupedPackage.npm_config_yes }))
    const exact = compose({ CI: 'operator-ci', TERM: 'operator-term' }, {}, platform)
    check(`${platform}: CI and TERM retain their exact values`, exact.CI === 'operator-ci' && exact.TERM === 'operator-term')
  }
  for (const platform of ['darwin', 'linux']) {
    const distinct = compose({ pager: 'lower-pager', git_editor: 'lower-editor' }, {}, platform)
    check(`${platform}: non-package POSIX keys remain case-sensitive`, distinct.pager === 'lower-pager' && distinct.PAGER === 'cat' && distinct.git_editor === 'lower-editor' && distinct.GIT_EDITOR === 'true')
  }
  const folded = compose({ pager: '', git_editor: 'custom editor', pythonutf8: '0' }, {}, 'win32')
  check('Windows: differently cased user keys are not shadowed', folded.pager === '' && folded.PAGER === undefined && folded.git_editor === 'custom editor' && folded.GIT_EDITOR === undefined && folded.pythonutf8 === '0' && folded.PYTHONUTF8 === undefined)
  const layered = compose({ PAGER: 'parent' }, { pager: 'settings' }, 'win32')
  check('Windows: an explicit override replaces the same key without a case twin', layered.pager === 'settings' && layered.PAGER === undefined)
  for (const platform of ['darwin', 'linux', 'win32']) {
    const child = compose({ PATH: 'staged-path' }, {}, platform)
    check(`${platform}: GCM_INTERACTIVE defaults to never on Windows only`, platform === 'win32' ? child.GCM_INTERACTIVE === 'never' : child.GCM_INTERACTIVE === undefined, String(child.GCM_INTERACTIVE))
    const gitBash = compose({ SSH_ASKPASS: '/mingw64/bin/git-askpass.exe', DISPLAY: 'needs-to-be-defined' }, {}, platform)
    check(
      `${platform}: Git for Windows desktop askpass is cleared on Windows only`,
      platform === 'win32'
        ? gitBash.SSH_ASKPASS === '' && gitBash.GIT_ASKPASS === '' && gitBash.DISPLAY === undefined && gitBash.GCM_INTERACTIVE === 'never'
        : gitBash.SSH_ASKPASS === '/mingw64/bin/git-askpass.exe' && gitBash.DISPLAY === 'needs-to-be-defined',
      JSON.stringify({ SSH_ASKPASS: gitBash.SSH_ASKPASS, GIT_ASKPASS: gitBash.GIT_ASKPASS, DISPLAY: gitBash.DISPLAY, GCM_INTERACTIVE: gitBash.GCM_INTERACTIVE }),
    )
  }
  const winAskpassVariants = compose(
    { ssh_askpass: 'C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe', GIT_ASKPASS: '/mingw64/libexec/git-core/git-gui--askpass', DISPLAY: ':0', gcm_interactive: 'always' },
    {},
    'win32',
  )
  check(
    'Windows: Git for Windows askpass variants yield to empty defaults while real DISPLAY and operator GCM_INTERACTIVE survive',
    winAskpassVariants.SSH_ASKPASS === '' && winAskpassVariants.ssh_askpass === undefined && winAskpassVariants.GIT_ASKPASS === '' && winAskpassVariants.DISPLAY === ':0' && winAskpassVariants.gcm_interactive === 'always' && winAskpassVariants.GCM_INTERACTIVE === undefined,
    JSON.stringify(winAskpassVariants),
  )
  const quotedDouble = compose({ SSH_ASKPASS: '"C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe"' }, {}, 'win32')
  check('Windows: double-quoted Git for Windows askpass yields to empty default', quotedDouble.SSH_ASKPASS === '', JSON.stringify({ SSH_ASKPASS: quotedDouble.SSH_ASKPASS }))
  const quotedSingle = compose({ SSH_ASKPASS: "'/mingw64/bin/git-askpass.exe'" }, {}, 'win32')
  check('Windows: single-quoted Git for Windows askpass yields to empty default', quotedSingle.SSH_ASKPASS === '', JSON.stringify({ SSH_ASKPASS: quotedSingle.SSH_ASKPASS }))
  const spacedAskpass = compose({ GIT_ASKPASS: 'C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe ' }, {}, 'win32')
  check('Windows: trailing-space Git for Windows askpass yields to empty default', spacedAskpass.GIT_ASKPASS === '', JSON.stringify({ GIT_ASKPASS: spacedAskpass.GIT_ASKPASS }))
  const customToolAskpass = compose({ SSH_ASKPASS: 'C:\\tools\\my-askpass.exe', GIT_ASKPASS: '"C:\\tools\\my-askpass.exe"' }, {}, 'win32')
  check(
    'Windows: operator askpass paths stay whether quoted or unquoted',
    customToolAskpass.SSH_ASKPASS === 'C:\\tools\\my-askpass.exe' && customToolAskpass.GIT_ASKPASS === '"C:\\tools\\my-askpass.exe"',
    JSON.stringify({ SSH_ASKPASS: customToolAskpass.SSH_ASKPASS, GIT_ASKPASS: customToolAskpass.GIT_ASKPASS }),
  )
  const explicitOverride = compose(
    { SSH_ASKPASS: '/mingw64/bin/git-askpass.exe' },
    { SSH_ASKPASS: '/mingw64/bin/git-askpass.exe' },
    'win32',
  )
  check('Windows: an explicit override of SSH_ASKPASS still wins', explicitOverride.SSH_ASKPASS === '/mingw64/bin/git-askpass.exe', String(explicitOverride.SSH_ASKPASS))
  if (owner.withLoginExports) {
    const loginMerged = owner.withLoginExports({ PATH: 'staged-path' }, { SSH_ASKPASS: '/mingw64/bin/git-askpass.exe', DISPLAY: 'needs-to-be-defined', EXTRA: 'kept' }, [], 'win32')
    check('Windows: login exports never re-introduce Git for Windows askpass or placeholder DISPLAY', loginMerged.SSH_ASKPASS === undefined && loginMerged.DISPLAY === undefined && loginMerged.EXTRA === 'kept', JSON.stringify(loginMerged))
  }
  hint = 'fix subprocessEnv in src/platform/processes/subprocessEnv.ts: on win32 it stamps the askpass and GCM defaults and clears Git for Windows askpass and the placeholder DISPLAY, and POSIX stays unchanged'
  const savedSubEnv = Object.fromEntries(['SSH_ASKPASS', 'GIT_ASKPASS', 'DISPLAY', 'GCM_INTERACTIVE', 'GIT_TERMINAL_PROMPT', 'PAGER', 'GIT_PAGER'].map(key => [key, process.env[key]]))
  try {
    for (const key of Object.keys(savedSubEnv)) delete process.env[key]
    state.setIsInteractive(false)
    const psHeadlessWin = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows headless subprocessEnv adds GIT_ASKPASS, SSH_ASKPASS and GCM_INTERACTIVE defaults',
      psHeadlessWin.GIT_TERMINAL_PROMPT === '0' && psHeadlessWin.GIT_ASKPASS === '' && psHeadlessWin.SSH_ASKPASS === '' && psHeadlessWin.GCM_INTERACTIVE === 'never',
      JSON.stringify({ GIT_TERMINAL_PROMPT: psHeadlessWin.GIT_TERMINAL_PROMPT, GIT_ASKPASS: psHeadlessWin.GIT_ASKPASS, SSH_ASKPASS: psHeadlessWin.SSH_ASKPASS, GCM_INTERACTIVE: psHeadlessWin.GCM_INTERACTIVE }),
    )
    const psHeadlessDarwin = owner.subprocessEnv({ platform: 'darwin' })
    check(
      'POSIX headless subprocessEnv stays unchanged',
      psHeadlessDarwin.GIT_TERMINAL_PROMPT === '0' && psHeadlessDarwin.GIT_ASKPASS === undefined && psHeadlessDarwin.SSH_ASKPASS === undefined && psHeadlessDarwin.GCM_INTERACTIVE === undefined,
      JSON.stringify({ GIT_TERMINAL_PROMPT: psHeadlessDarwin.GIT_TERMINAL_PROMPT, GIT_ASKPASS: psHeadlessDarwin.GIT_ASKPASS, SSH_ASKPASS: psHeadlessDarwin.SSH_ASKPASS, GCM_INTERACTIVE: psHeadlessDarwin.GCM_INTERACTIVE }),
    )
    process.env.SSH_ASKPASS = '/mingw64/bin/git-askpass.exe'
    process.env.DISPLAY = 'needs-to-be-defined'
    const gitBashHeadlessWin = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows headless subprocessEnv clears inherited Git for Windows askpass and placeholder DISPLAY',
      gitBashHeadlessWin.GIT_TERMINAL_PROMPT === '0' && gitBashHeadlessWin.SSH_ASKPASS === '' && gitBashHeadlessWin.GIT_ASKPASS === '' && gitBashHeadlessWin.GCM_INTERACTIVE === 'never' && gitBashHeadlessWin.DISPLAY === undefined,
      JSON.stringify({ GIT_TERMINAL_PROMPT: gitBashHeadlessWin.GIT_TERMINAL_PROMPT, SSH_ASKPASS: gitBashHeadlessWin.SSH_ASKPASS, GIT_ASKPASS: gitBashHeadlessWin.GIT_ASKPASS, GCM_INTERACTIVE: gitBashHeadlessWin.GCM_INTERACTIVE, DISPLAY: gitBashHeadlessWin.DISPLAY }),
    )
    const gitBashHeadlessLinux = owner.subprocessEnv({ platform: 'linux' })
    check(
      'POSIX headless subprocessEnv leaves inherited SSH_ASKPASS and DISPLAY untouched',
      gitBashHeadlessLinux.SSH_ASKPASS === '/mingw64/bin/git-askpass.exe' && gitBashHeadlessLinux.DISPLAY === 'needs-to-be-defined' && gitBashHeadlessLinux.GCM_INTERACTIVE === undefined,
      JSON.stringify({ SSH_ASKPASS: gitBashHeadlessLinux.SSH_ASKPASS, DISPLAY: gitBashHeadlessLinux.DISPLAY, GCM_INTERACTIVE: gitBashHeadlessLinux.GCM_INTERACTIVE }),
    )
    state.setIsInteractive(true)
    const gitBashInteractiveWin = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows interactive subprocessEnv clears inherited Git for Windows askpass and placeholder DISPLAY',
      gitBashInteractiveWin.SSH_ASKPASS === '' && gitBashInteractiveWin.GIT_ASKPASS === '' && gitBashInteractiveWin.GCM_INTERACTIVE === 'never' && gitBashInteractiveWin.DISPLAY === undefined,
      JSON.stringify({ SSH_ASKPASS: gitBashInteractiveWin.SSH_ASKPASS, GIT_ASKPASS: gitBashInteractiveWin.GIT_ASKPASS, GCM_INTERACTIVE: gitBashInteractiveWin.GCM_INTERACTIVE, DISPLAY: gitBashInteractiveWin.DISPLAY }),
    )
    delete process.env.SSH_ASKPASS
    delete process.env.DISPLAY
    check('Windows interactive subprocessEnv keeps the live env hot path when clean', owner.subprocessEnv({ platform: 'win32' }) === process.env)
    state.setIsInteractive(false)
    process.env.SSH_ASKPASS = 'operator-askpass'
    process.env.GCM_INTERACTIVE = 'always'
    process.env.DISPLAY = ':0'
    const operatorWin = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows headless subprocessEnv preserves explicit operator askpass, GCM_INTERACTIVE and DISPLAY',
      operatorWin.SSH_ASKPASS === 'operator-askpass' && operatorWin.GCM_INTERACTIVE === 'always' && operatorWin.DISPLAY === ':0' && operatorWin.GIT_ASKPASS === '',
      JSON.stringify({ SSH_ASKPASS: operatorWin.SSH_ASKPASS, GCM_INTERACTIVE: operatorWin.GCM_INTERACTIVE, DISPLAY: operatorWin.DISPLAY, GIT_ASKPASS: operatorWin.GIT_ASKPASS }),
    )
    const clearSubEnv = (): void => {
      for (const key of Object.keys(savedSubEnv)) delete process.env[key]
    }
    clearSubEnv()
    state.setIsInteractive(false)
    process.env.GIT_TERMINAL_PROMPT = '0'
    const presetPromptOnly = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows headless subprocessEnv with GIT_TERMINAL_PROMPT=0 pre-set still adds GIT_ASKPASS, SSH_ASKPASS and GCM_INTERACTIVE',
      presetPromptOnly.GIT_TERMINAL_PROMPT === '0' && presetPromptOnly.PAGER === 'cat' && presetPromptOnly.GIT_PAGER === 'cat' && presetPromptOnly.GIT_ASKPASS === '' && presetPromptOnly.SSH_ASKPASS === '' && presetPromptOnly.GCM_INTERACTIVE === 'never',
      JSON.stringify({ GIT_TERMINAL_PROMPT: presetPromptOnly.GIT_TERMINAL_PROMPT, GIT_ASKPASS: presetPromptOnly.GIT_ASKPASS, SSH_ASKPASS: presetPromptOnly.SSH_ASKPASS, GCM_INTERACTIVE: presetPromptOnly.GCM_INTERACTIVE }),
    )
    process.env.PAGER = 'less'
    process.env.GIT_PAGER = 'delta'
    const presetAllThree = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows headless subprocessEnv with GIT_TERMINAL_PROMPT=0, PAGER and GIT_PAGER all set still adds the three Windows git defaults',
      presetAllThree !== process.env && presetAllThree.GIT_TERMINAL_PROMPT === '0' && presetAllThree.PAGER === 'less' && presetAllThree.GIT_PAGER === 'delta' && presetAllThree.GIT_ASKPASS === '' && presetAllThree.SSH_ASKPASS === '' && presetAllThree.GCM_INTERACTIVE === 'never',
      JSON.stringify({ sameRef: presetAllThree === process.env, GIT_ASKPASS: presetAllThree.GIT_ASKPASS, SSH_ASKPASS: presetAllThree.SSH_ASKPASS, GCM_INTERACTIVE: presetAllThree.GCM_INTERACTIVE }),
    )
    process.env.GCM_INTERACTIVE = 'always'
    const presetWithOperatorGcm = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows headless subprocessEnv with GIT_TERMINAL_PROMPT=0 preserves operator GCM_INTERACTIVE=always while filling missing askpass defaults',
      presetWithOperatorGcm.GCM_INTERACTIVE === 'always' && presetWithOperatorGcm.GIT_ASKPASS === '' && presetWithOperatorGcm.SSH_ASKPASS === '',
      JSON.stringify({ GCM_INTERACTIVE: presetWithOperatorGcm.GCM_INTERACTIVE, GIT_ASKPASS: presetWithOperatorGcm.GIT_ASKPASS, SSH_ASKPASS: presetWithOperatorGcm.SSH_ASKPASS }),
    )
    clearSubEnv()
    process.env.GIT_TERMINAL_PROMPT = '1'
    process.env.PAGER = 'less -R'
    process.env.GIT_PAGER = 'delta'
    const promptEnabledAllSet = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows headless subprocessEnv with GIT_TERMINAL_PROMPT=1 keeps defaults off and preserves the hot path',
      promptEnabledAllSet === process.env && promptEnabledAllSet.GIT_ASKPASS === undefined && promptEnabledAllSet.SSH_ASKPASS === undefined && promptEnabledAllSet.GCM_INTERACTIVE === undefined,
      JSON.stringify({ sameRef: promptEnabledAllSet === process.env, GIT_ASKPASS: promptEnabledAllSet.GIT_ASKPASS, SSH_ASKPASS: promptEnabledAllSet.SSH_ASKPASS, GCM_INTERACTIVE: promptEnabledAllSet.GCM_INTERACTIVE }),
    )
    delete process.env.GIT_PAGER
    const promptEnabledPartial = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows headless subprocessEnv with GIT_TERMINAL_PROMPT=1 leaves Windows git defaults off when another stamp is owed',
      promptEnabledPartial.GIT_PAGER === 'cat' && promptEnabledPartial.GIT_ASKPASS === undefined && promptEnabledPartial.SSH_ASKPASS === undefined && promptEnabledPartial.GCM_INTERACTIVE === undefined,
      JSON.stringify({ GIT_PAGER: promptEnabledPartial.GIT_PAGER, GIT_ASKPASS: promptEnabledPartial.GIT_ASKPASS, SSH_ASKPASS: promptEnabledPartial.SSH_ASKPASS, GCM_INTERACTIVE: promptEnabledPartial.GCM_INTERACTIVE }),
    )
    clearSubEnv()
    state.setIsInteractive(true)
    process.env.SSH_ASKPASS = '"C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe"'
    const subDoubleQuoted = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows subprocessEnv drops double-quoted Git for Windows askpass',
      subDoubleQuoted.SSH_ASKPASS === '' && subDoubleQuoted.GIT_ASKPASS === '' && subDoubleQuoted.GCM_INTERACTIVE === 'never',
      JSON.stringify({ SSH_ASKPASS: subDoubleQuoted.SSH_ASKPASS, GIT_ASKPASS: subDoubleQuoted.GIT_ASKPASS, GCM_INTERACTIVE: subDoubleQuoted.GCM_INTERACTIVE }),
    )
    process.env.SSH_ASKPASS = "'/mingw64/bin/git-askpass.exe'"
    const subSingleQuoted = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows subprocessEnv drops single-quoted Git for Windows askpass',
      subSingleQuoted.SSH_ASKPASS === '' && subSingleQuoted.GIT_ASKPASS === '' && subSingleQuoted.GCM_INTERACTIVE === 'never',
      JSON.stringify({ SSH_ASKPASS: subSingleQuoted.SSH_ASKPASS, GIT_ASKPASS: subSingleQuoted.GIT_ASKPASS, GCM_INTERACTIVE: subSingleQuoted.GCM_INTERACTIVE }),
    )
    delete process.env.SSH_ASKPASS
    process.env.GIT_ASKPASS = 'C:\\Program Files\\Git\\mingw64\\bin\\git-askpass.exe '
    const subTrailingSpace = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows subprocessEnv drops Git for Windows askpass with trailing space',
      subTrailingSpace.GIT_ASKPASS === '' && subTrailingSpace.SSH_ASKPASS === '' && subTrailingSpace.GCM_INTERACTIVE === 'never',
      JSON.stringify({ GIT_ASKPASS: subTrailingSpace.GIT_ASKPASS, SSH_ASKPASS: subTrailingSpace.SSH_ASKPASS, GCM_INTERACTIVE: subTrailingSpace.GCM_INTERACTIVE }),
    )
    clearSubEnv()
    state.setIsInteractive(false)
    process.env.GIT_TERMINAL_PROMPT = '0'
    process.env.SSH_ASKPASS = 'C:\\tools\\my-askpass.exe'
    process.env.GIT_ASKPASS = '"C:\\tools\\my-askpass.exe"'
    const subCustomAskpass = owner.subprocessEnv({ platform: 'win32' })
    check(
      'Windows subprocessEnv keeps an operator askpass path whether quoted or unquoted',
      subCustomAskpass.SSH_ASKPASS === 'C:\\tools\\my-askpass.exe' && subCustomAskpass.GIT_ASKPASS === '"C:\\tools\\my-askpass.exe"' && subCustomAskpass.GCM_INTERACTIVE === 'never',
      JSON.stringify({ SSH_ASKPASS: subCustomAskpass.SSH_ASKPASS, GIT_ASKPASS: subCustomAskpass.GIT_ASKPASS, GCM_INTERACTIVE: subCustomAskpass.GCM_INTERACTIVE }),
    )
  } finally {
    state.setIsInteractive(true)
    for (const [key, value] of Object.entries(savedSubEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  hint = 'applyConfigEnvironmentVariables in src/platform/environment/settingsEnv.ts must apply the user, project and local settings environment layers, and the tool shell (src/platform/processes/subprocessEnv.ts toolShellEnv) must not override them, empty values included'
  state.setOriginalCwd(scratch)
  mkdirSync(join(scratch, '.mercury'), { recursive: true })
  const userLayer = { PAGER: 'user-pager', GIT_EDITOR: 'user-editor', GH_PAGER: 'user-gh-pager', NO_COLOR: 'user-colour', FORCE_COLOR: '0', CI: 'keep-ci', TERM: 'keep-term' }
  const projectLayer = { GIT_EDITOR: 'project-editor', GH_PAGER: 'project-gh-pager', NO_COLOR: 'project-colour' }
  const localLayer = { GH_PAGER: '', FORCE_COLOR: '0' }
  const expectedSettings = { ...userLayer, ...projectLayer, ...localLayer }
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'settings.json'), JSON.stringify({ environment: { values: userLayer } }))
  writeFileSync(join(scratch, '.mercury', 'settings.json'), JSON.stringify({ environment: { values: projectLayer } }))
  writeFileSync(join(scratch, '.mercury', 'settings.local.json'), JSON.stringify({ environment: { values: localLayer } }))
  resetSettingsCache()
  applyConfigEnvironmentVariables()
  check('the real settings loader merged user, project and local environment layers', Object.entries(expectedSettings).every(([key, value]) => process.env[key] === value), JSON.stringify(Object.fromEntries(Object.keys(expectedSettings).map(key => [key, process.env[key]]))))
  for (const engine of engines) {
    await endEngineSession()
    process.env.MERCURY_SHELL_ENGINE = engine
    const child = await readChild()
    check(`${engine}: user, project and local settings survive shell defaults, including empty values`, Object.entries(expectedSettings).every(([key, value]) => child[key] === value), JSON.stringify(Object.fromEntries(Object.keys(expectedSettings).map(key => [key, child[key]]))))
  }
} finally {
  await endEngineSession()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? 'PASS tool shell defaults and refusals' : `FAIL tool shell defaults and refusals (${failures})`)
process.exit(failures === 0 ? 0 : 1)
