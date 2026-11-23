import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import chalk from 'chalk'
import type { LocalJSXCommandCall } from '../catalogue/command.js'
import { colorize } from '../../screen/renderer/colorize.js'
import { supportsHyperlinks } from '../../screen/renderer/terminal-session/capabilities.js'
import { maybeMarkProjectOnboardingComplete } from '../../boot/projectOnboarding.js'
import {
  backupTerminalPreferences,
  getTerminalPlistPath,
  markTerminalSetupComplete,
} from './appleTerminalBackup.js'
import { getGlobalConfig, saveGlobalConfig } from '../../platform/settings/config.js'
import { env } from '../../platform/environment/env.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { execFileNoThrow } from '../../platform/processes/execFileNoThrow.js'
import { createHyperlink } from '../../platform/text/hyperlink.js'
import { addItemToJSONCArray, safeParseJSONC } from '../../platform/storage/json.js'
import { logError } from '../../platform/logs/errorLog.js'
import { getTheme, type ThemeName } from '../../screen/theme/theme.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'
import { userConfigRoot, xdgAndRoamingConfigRoots } from '../../platform/host-os/files.js'

const NATIVE_TERMINALS: Record<string, string> = {
  ghostty: 'Ghostty',
  kitty: 'Kitty',
  'iTerm.app': 'iTerm2',
  WezTerm: 'WezTerm',
  WarpTerminal: 'Warp',
}

const VSCODE_FAMILY: Record<string, string> = {
  vscode: 'Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
}

function isSetupCapable(terminal: string): boolean {
  if (terminal === 'Apple_Terminal') return process.platform === 'darwin'
  return ['vscode', 'cursor', 'windsurf', 'alacritty', 'zed'].includes(terminal)
}

const ESC_CR = '\x1b\r'

function linkedPath(path: string): string {
  if (!supportsHyperlinks()) return path
  return createHyperlink(path, `file://${path}`)
}

function backupSuffix(): string {
  return `.${randomBytes(4).toString('hex')}.bak`
}

type Paint = {
  ok: (text: string) => string
  warn: (text: string) => string
  fail: (text: string) => string
}

function paintFor(theme: ThemeName): Paint {
  const roles = getTheme(theme)
  return {
    ok: text => colorize(text, roles.success, 'foreground'),
    warn: text => colorize(text, roles.warning, 'foreground'),
    fail: text => colorize(text, roles.error, 'foreground'),
  }
}


function isRemoteVscodeSession(): boolean {
  const askpass = hostEnv().VSCODE_GIT_ASKPASS_MAIN ?? ''
  const pathVar = hostEnv().PATH ?? ''
  const markers = ['.vscode-server', '.cursor-server', '.windsurf-server']
  return markers.some(marker => askpass.includes(marker) || pathVar.includes(marker))
}

type TerminalSetupResult = { message: string; installed: boolean }


const ALACRITTY_TABLE = `[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "\\u001b\\r"\n`


async function readExistingText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return null
    throw error
  }
}

async function backupExistingFile(path: string, paint: Paint): Promise<string | null> {
  const backupPath = `${path}${backupSuffix()}`
  try {
    await copyFile(path, backupPath)
    return null
  } catch {
    return paint.warn(`Could not back up ${path} to ${backupPath} — nothing was written.`)
  }
}

function isVscodeShiftEnterEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false
  const fields = new Map<string, unknown>(Object.entries(entry))
  return (
    fields.get('key') === 'shift+enter' &&
    fields.get('command') === 'workbench.action.terminal.sendSequence' &&
    fields.get('when') === 'terminalFocus'
  )
}

async function setupVscodeFamily(terminal: string, paint: Paint): Promise<TerminalSetupResult> {
  const folder = VSCODE_FAMILY[terminal] ?? 'Code'
  try {
    if (isRemoteVscodeSession()) {
      return {
        installed: false,
        message: paint.warn(
          [
            'Keybindings cannot be installed from a remote session — they belong on the local machine.',
            'To add the binding manually:',
            '1. Open the editor locally.',
            '2. Open the keyboard-shortcuts JSON via the command palette ("Preferences: Open Keyboard Shortcuts (JSON)").',
            '3. Add this entry (the file must be a JSON array):',
            '   { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\\u001b\\r" }, "when": "terminalFocus" }',
          ].join('\n'),
        ),
      }
    }

    const filePath = join(userConfigRoot(homedir()), folder, 'User', 'keybindings.json')
    await mkdir(dirname(filePath), { recursive: true })
    const raw = await readExistingText(filePath)
    const existed = raw !== null
    const content = raw ?? '[]'
    const parsed = safeParseJSONC(content)
    if (!Array.isArray(parsed)) {
      throw new Error(`Failed to install the ${folder} Shift+Enter binding`)
    }

    if (existed) {
      const backupError = await backupExistingFile(filePath, paint)
      if (backupError !== null) {
        return { installed: false, message: backupError }
      }
    }

    if (parsed.some(isVscodeShiftEnterEntry)) {
      return {
        installed: false,
        message: paint.warn(
          `A Shift+Enter terminal binding already exists in ${linkedPath(filePath)} — remove it first if you want it reinstalled.`,
        ),
      }
    }

    const updated = addItemToJSONCArray(content, {
      key: 'shift+enter',
      command: 'workbench.action.terminal.sendSequence',
      args: { text: ESC_CR },
      when: 'terminalFocus',
    })
    await writeFile(filePath, updated, 'utf8')
    return {
      installed: true,
      message: [
        paint.ok('Installed the Shift+Enter binding for newlines.'),
        chalk.dim(linkedPath(filePath)),
      ].join('\n'),
    }
  } catch (error) {
    logError(error)
    throw new Error(`Failed to install the ${folder} Shift+Enter binding`)
  }
}

async function readTerminalPref(key: string): Promise<string> {
  const res = await execFileNoThrow('defaults', ['read', 'com.apple.Terminal', key])
  const value = res.stdout.trim()
  if (res.code !== 0 || value === '') {
    throw new Error(`Could not read the Terminal preference '${key}'`)
  }
  return value
}

async function setTerminalProfileBool(
  profile: string,
  key: string,
  value: boolean,
): Promise<boolean> {
  const plistBuddy = '/usr/libexec/PlistBuddy'
  const plistPath = getTerminalPlistPath()
  const target = `:Window Settings:${profile}:${key}`
  const boolValue = value ? 'true' : 'false'
  const addRes = await execFileNoThrow(plistBuddy, [
    '-c',
    `Add '${target}' bool ${boolValue}`,
    plistPath,
  ])
  if (addRes.code === 0) return true
  const setRes = await execFileNoThrow(plistBuddy, [
    '-c',
    `Set '${target}' ${boolValue}`,
    plistPath,
  ])
  if (setRes.code === 0) return true
  logError(new Error(`Could not update ${key} for Terminal profile ${profile}`))
  return false
}

async function setupAppleTerminal(paint: Paint): Promise<string> {
  const backupPath = await backupTerminalPreferences()
  if (!backupPath) {
    throw new Error('Backing up the Terminal preferences failed — bailing out.')
  }
  try {
    const defaultProfile = await readTerminalPref('Default Window Settings')
    const startupProfile = await readTerminalPref('Startup Window Settings')
    const profiles =
      startupProfile !== defaultProfile ? [defaultProfile, startupProfile] : [defaultProfile]
    let allSet = true
    for (const profile of profiles) {
      const metaSet = await setTerminalProfileBool(profile, 'useOptionAsMetaKey', true)
      const bellSet = await setTerminalProfileBool(profile, 'Bell', false)
      if (!metaSet || !bellSet) allSet = false
    }
    if (!allSet) {
      throw new Error('No Terminal profile property could be updated')
    }
    await execFileNoThrow('killall', ['cfprefsd'])
    markTerminalSetupComplete()
    return [
      paint.ok('Configured Terminal:'),
      paint.ok(' - Option-as-Meta enabled'),
      paint.ok(" - Terminal's bell silenced"),
      chalk.dim('Option+Enter now inserts a newline.'),
      chalk.dim('Restart Terminal for the change to take effect.'),
    ].join('\n')
  } catch (error) {
    logError(error)
    if (!backupPath) {
      throw new Error('Terminal setup failed and no backup was available.')
    }
    const restored = await execFileNoThrow('defaults', ['import', 'com.apple.Terminal', backupPath])
    if (restored.code === 0) {
      markTerminalSetupComplete()
      throw new Error('Terminal setup failed; your preferences were restored from backup.')
    }
    throw new Error(
      `Terminal setup failed AND the restore failed — restore manually with: defaults import com.apple.Terminal ${backupPath}`,
    )
  }
}

async function setupAlacritty(paint: Paint): Promise<TerminalSetupResult> {
  try {
    const candidates = xdgAndRoamingConfigRoots().map(root =>
      join(root, 'alacritty', 'alacritty.toml'),
    )
    const firstCandidate = candidates[0]
    if (firstCandidate === undefined) {
      throw new Error('No Alacritty config path could be produced')
    }
    let target = firstCandidate
    let content = ''
    let existed = false
    for (const candidate of candidates) {
      const raw = await readExistingText(candidate)
      if (raw !== null) {
        target = candidate
        content = raw
        existed = true
        break
      }
    }
    if (!existed) {
      await mkdir(dirname(target), { recursive: true })
    }
    if (existed && content.includes('mods = "Shift"') && content.includes('key = "Return"')) {
      return {
        installed: false,
        message: paint.warn(
          `A Shift+Return binding already exists in ${linkedPath(target)} — remove it first if you want it reinstalled.`,
        ),
      }
    }
    if (existed) {
      const backupError = await backupExistingFile(target, paint)
      if (backupError !== null) {
        return { installed: false, message: backupError }
      }
    }
    const base = content !== '' && !content.endsWith('\n') ? `${content}\n` : content
    await writeFile(target, `${base}\n${ALACRITTY_TABLE}`, 'utf8')
    return {
      installed: true,
      message: [
        paint.ok('Installed the Shift+Enter binding for Alacritty.'),
        paint.ok('A restart of Alacritty may be needed.'),
        chalk.dim(linkedPath(target)),
      ].join('\n'),
    }
  } catch (error) {
    logError(error)
    throw new Error('Failed to install the Alacritty Shift+Enter binding')
  }
}

async function setupZed(paint: Paint): Promise<TerminalSetupResult> {
  try {
    const filePath = join(homedir(), '.config', 'zed', 'keymap.json')
    await mkdir(dirname(filePath), { recursive: true })
    const raw = await readExistingText(filePath)
    const existed = raw !== null
    const content = raw ?? '[]'
    if (existed && content.includes('shift-enter')) {
      return {
        installed: false,
        message: paint.warn(
          `A shift-enter binding already exists in ${linkedPath(filePath)} — remove it first if you want it reinstalled.`,
        ),
      }
    }
    if (existed) {
      const backupError = await backupExistingFile(filePath, paint)
      if (backupError !== null) {
        return { installed: false, message: backupError }
      }
    }
    const parsed = safeParseJSONC(content)
    if (!Array.isArray(parsed)) {
      throw new Error('Failed to install the Zed shift-enter binding')
    }
    const updated = [
      ...parsed,
      {
        context: 'Terminal',
        bindings: {
          'shift-enter': ['terminal::SendText', ESC_CR],
        },
      },
    ]
    await writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
    return {
      installed: true,
      message: [
        paint.ok('Installed the shift-enter binding for Zed.'),
        chalk.dim(linkedPath(filePath)),
      ].join('\n'),
    }
  } catch (error) {
    logError(error)
    throw new Error('Failed to install the Zed shift-enter binding')
  }
}

export async function setupTerminal(theme: ThemeName): Promise<string> {
  const terminal = env.terminal
  const paint = paintFor(theme)
  let result: TerminalSetupResult = { installed: false, message: '' }

  if (terminal === 'vscode' || terminal === 'cursor' || terminal === 'windsurf') {
    result = await setupVscodeFamily(terminal, paint)
  } else if (terminal === 'Apple_Terminal') {
    result = { installed: true, message: await setupAppleTerminal(paint) }
  } else if (terminal === 'alacritty') {
    result = await setupAlacritty(paint)
  } else if (terminal === 'zed') {
    result = await setupZed(paint)
  }

  const config = getGlobalConfig()
  if (
    result.installed &&
    (terminal === 'vscode' ||
      terminal === 'cursor' ||
      terminal === 'windsurf' ||
      terminal === 'alacritty' ||
      terminal === 'zed') &&
    config.shiftEnterKeyBindingInstalled !== true
  ) {
    saveGlobalConfig(current => ({ ...current, shiftEnterKeyBindingInstalled: true }))
  }
  if (result.installed && terminal === 'Apple_Terminal' && config.optionAsMetaKeyInstalled !== true) {
    saveGlobalConfig(current => ({ ...current, optionAsMetaKeyInstalled: true }))
  }
  maybeMarkProjectOnboardingComplete()
  return result.message
}

function unsupportedTerminalMessage(terminal: string | null): string {
  const name = terminal ?? 'your current terminal'
  const platformLine = process.platform === 'darwin' ? ' - Apple Terminal\n' : ''
  return [
    `/keysetup cannot run from ${name}. It installs a Shift+Enter newline binding into your terminal's configuration.`,
    chalk.dim('Backslash-then-return (\\ then Enter) already inserts a newline today.'),
    'Using tmux or screen?',
    ' 1. Leave the multiplexer.',
    ' 2. Run /keysetup directly in a supported terminal.',
    ' 3. Return — the settings persist.',
    'Supported terminals:',
    platformLine +
      ' - VSCode, Cursor, Windsurf, Zed\n - Alacritty',
    chalk.dim(
      'Ghostty, Kitty, iTerm2, WezTerm and Warp support Shift+Enter natively — no setup needed there.',
    ),
  ].join('\n')
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const terminal = env.terminal
  const nativeName =
    terminal !== null && Object.hasOwn(NATIVE_TERMINALS, terminal)
      ? NATIVE_TERMINALS[terminal]
      : undefined
  if (nativeName !== undefined) {
    onDone(
      `${nativeName} supports the chord natively — no configuration is needed; Shift+Enter inserts newlines.`,
    )
    return null
  }
  if (terminal === null || !isSetupCapable(terminal)) {
    onDone(unsupportedTerminalMessage(terminal))
    return null
  }
  try {
    const message = await setupTerminal(context.options.theme)
    onDone(message)
  } catch (error) {
    const paint = paintFor(context.options.theme)
    onDone(paint.fail(error instanceof Error ? error.message : String(error)))
  }
  return null
}

export function hasUsedBackslashReturn(): boolean {
  return getGlobalConfig().hasUsedBackslashReturn === true
}

export function markBackslashReturnUsed(): void {
  if (getGlobalConfig().hasUsedBackslashReturn === true) return
  saveGlobalConfig(current => ({ ...current, hasUsedBackslashReturn: true }))
}

export function shouldOfferTerminalSetup(): boolean {
  const terminal = env.terminal
  if (terminal === null || !isSetupCapable(terminal)) return false
  const config = getGlobalConfig()
  if (terminal === 'Apple_Terminal') {
    return config.optionAsMetaKeyInstalled !== true
  }
  return config.shiftEnterKeyBindingInstalled !== true
}
