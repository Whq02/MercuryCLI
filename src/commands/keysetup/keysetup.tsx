import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import chalk from 'chalk'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { colorize } from '../../ink/colorize.js'
import { supportsHyperlinks } from '../../ink/session/capabilities.js'
import { maybeMarkProjectOnboardingComplete } from '../../projectOnboardingState.js'
import {
  backupTerminalPreferences,
  getTerminalPlistPath,
  markTerminalSetupComplete,
} from '../../utils/appleTerminalBackup.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'
import { getErrnoCode } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { createHyperlink } from '../../utils/hyperlink.js'
import { addItemToJSONCArray, safeParseJSONC } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { getTheme, type ThemeName } from '../../utils/theme.js'
import { hostEnv } from '../../utils/hostEnv.js'
import { userConfigRoot, xdgAndRoamingConfigRoots } from '../../utils/platform/files.js'

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

async function backupExistingFile(
  path: string,
  paint: Paint,
): Promise<{ ok: true; backupPath: string } | { ok: false; message: string }> {
  const backupPath = `${path}${backupSuffix()}`
  try {
    await copyFile(path, backupPath)
    return { ok: true, backupPath }
  } catch (error) {
    logError(error)
    return {
      ok: false,
      message: paint.fail(`Could not back up ${linkedPath(path)} — nothing was written.`),
    }
  }
}

function hasVscodeShiftEnterBinding(entries: unknown[]): boolean {
  return entries.some(item => {
    if (item === null || typeof item !== 'object') return false
    const record = item as { key?: unknown; command?: unknown }
    return (
      typeof record.key === 'string' &&
      record.key.toLowerCase() === 'shift+enter' &&
      record.command === 'workbench.action.terminal.sendSequence'
    )
  })
}

async function setupVscodeFamily(terminal: string, paint: Paint): Promise<TerminalSetupResult> {
  const productDir = VSCODE_FAMILY[terminal]
  if (!productDir) {
    return { installed: false, message: unsupportedTerminalMessage(terminal) }
  }
  const binding = {
    key: 'shift+enter',
    command: 'workbench.action.terminal.sendSequence',
    args: { text: ESC_CR },
    when: 'terminalFocus',
  }
  if (isRemoteVscodeSession()) {
    return {
      installed: false,
      message: [
        paint.warn(
          'Keybindings cannot be installed from a remote session — they belong on the local machine.',
        ),
        'To add the binding manually:',
        '1. Open the editor locally.',
        '2. Open the keyboard-shortcuts JSON via the command palette ("Preferences: Open Keyboard Shortcuts (JSON)").',
        '3. Add this entry (the file must be a JSON array):',
        '{ "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\\u001b\\r" }, "when": "terminalFocus" }',
      ].join('\n'),
    }
  }

  const filePath = join(userConfigRoot(homedir()), productDir, 'User', 'keybindings.json')
  const existing = await readExistingText(filePath)
  if (existing !== null) {
    const parsed = safeParseJSONC(existing)
    if (!Array.isArray(parsed)) {
      throw new Error(`Failed to install the ${productDir} Shift+Enter binding`)
    }
    if (hasVscodeShiftEnterBinding(parsed)) {
      return {
        installed: true,
        message: paint.ok(
          `A Shift+Enter terminal binding already exists in ${linkedPath(filePath)} — remove it first if you want it reinstalled.`,
        ),
      }
    }
    const backup = await backupExistingFile(filePath, paint)
    if (!backup.ok) {
      return { installed: false, message: backup.message }
    }
    const updated = addItemToJSONCArray(existing, binding)
    await writeFile(filePath, updated, 'utf8')
    return {
      installed: true,
      message: paint.ok('Installed the Shift+Enter binding for newlines.'),
    }
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify([binding], null, 2) + '\n', 'utf8')
  return {
    installed: true,
    message: paint.ok('Installed the Shift+Enter binding for newlines.'),
  }
}

function hasZedShiftEnterBinding(entries: unknown[]): boolean {
  return entries.some(item => {
    if (item === null || typeof item !== 'object') return false
    const record = item as { context?: unknown; bindings?: unknown }
    if (typeof record.context !== 'string' || !record.context.includes('Terminal')) return false
    if (record.bindings === null || typeof record.bindings !== 'object') return false
    const bindings = record.bindings as Record<string, unknown>
    return Object.hasOwn(bindings, 'shift-enter')
  })
}

async function setupZed(paint: Paint): Promise<TerminalSetupResult> {
  const roots = xdgAndRoamingConfigRoots()
  const baseRoot = roots[0] ?? join(homedir(), '.config')
  const filePath = join(baseRoot, 'zed', 'keymap.json')
  const binding = {
    context: 'Terminal',
    bindings: {
      'shift-enter': ['terminal::SendText', ESC_CR],
    },
  }

  const existing = await readExistingText(filePath)
  if (existing !== null) {
    const parsed = safeParseJSONC(existing)
    if (!Array.isArray(parsed)) {
      throw new Error('Failed to install the Zed shift-enter binding')
    }
    if (hasZedShiftEnterBinding(parsed)) {
      return {
        installed: true,
        message: paint.ok(
          `A shift-enter binding already exists in ${linkedPath(filePath)} — remove it first if you want it reinstalled.`,
        ),
      }
    }
    const backup = await backupExistingFile(filePath, paint)
    if (!backup.ok) {
      return { installed: false, message: backup.message }
    }
    const updated = addItemToJSONCArray(existing, binding)
    await writeFile(filePath, updated, 'utf8')
    return {
      installed: true,
      message: paint.ok('Installed the shift-enter binding for Zed.'),
    }
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify([binding], null, 2) + '\n', 'utf8')
  return {
    installed: true,
    message: paint.ok('Installed the shift-enter binding for Zed.'),
  }
}

async function setupAlacritty(paint: Paint): Promise<TerminalSetupResult> {
  const roots = xdgAndRoamingConfigRoots()
  const baseRoot = roots[0] ?? join(homedir(), '.config')
  const filePath = join(baseRoot, 'alacritty', 'alacritty.toml')
  const existing = await readExistingText(filePath)
  if (existing !== null) {
    if (
      existing.includes('key = "Return"') &&
      existing.includes('mods = "Shift"') &&
      existing.includes('\\u001b\\r')
    ) {
      return {
        installed: true,
        message: paint.ok(
          `A Shift+Return binding already exists in ${linkedPath(filePath)} — remove it first if you want it reinstalled.`,
        ),
      }
    }
    const backup = await backupExistingFile(filePath, paint)
    if (!backup.ok) {
      return { installed: false, message: backup.message }
    }
    const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    await writeFile(filePath, `${existing}${separator}${ALACRITTY_TABLE}`, 'utf8')
    return {
      installed: true,
      message: paint.ok(
        'Installed the Shift+Enter binding for Alacritty.\nA restart of Alacritty may be needed.',
      ),
    }
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, ALACRITTY_TABLE, 'utf8')
  return {
    installed: true,
    message: paint.ok(
      'Installed the Shift+Enter binding for Alacritty.\nA restart of Alacritty may be needed.',
    ),
  }
}

async function plistSetBool(
  plistPath: string,
  profile: string,
  property: string,
  value: boolean,
): Promise<void> {
  const plistBuddy = '/usr/libexec/PlistBuddy'
  const keyPath = `:"Window Settings":"${profile}":${property}`
  const boolStr = value ? 'true' : 'false'
  const setRes = await execFileNoThrow(plistBuddy, ['-c', `Set ${keyPath} ${boolStr}`, plistPath])
  if (setRes.code === 0) return
  const addRes = await execFileNoThrow(plistBuddy, ['-c', `Add ${keyPath} bool ${boolStr}`, plistPath])
  if (addRes.code === 0) return
  throw new Error(
    addRes.stderr.trim() ||
      setRes.stderr.trim() ||
      `Could not update ${property} for Terminal profile ${profile}`,
  )
}

async function setupAppleTerminal(paint: Paint): Promise<TerminalSetupResult> {
  const backupPath = await backupTerminalPreferences()
  if (!backupPath) {
    throw new Error('Backing up the Terminal preferences failed — bailing out.')
  }
  const plistPath = getTerminalPlistPath()
  try {
    const defaultRes = await execFileNoThrow('defaults', [
      'read',
      'com.apple.Terminal',
      'Default Window Settings',
    ])
    const startupRes = await execFileNoThrow('defaults', [
      'read',
      'com.apple.Terminal',
      'Startup Window Settings',
    ])
    const profileSet = new Set<string>()
    if (defaultRes.code === 0 && defaultRes.stdout.trim()) profileSet.add(defaultRes.stdout.trim())
    if (startupRes.code === 0 && startupRes.stdout.trim()) profileSet.add(startupRes.stdout.trim())
    if (profileSet.size === 0) profileSet.add('Basic')

    const profiles = [...profileSet]
    for (const profile of profiles) {
      await plistSetBool(plistPath, profile, 'useOptionAsMetaKey', true)
      await plistSetBool(plistPath, profile, 'Bell', false)
    }

    await execFileNoThrow('killall', ['cfprefsd'])
    markTerminalSetupComplete()
    return {
      installed: true,
      message: paint.ok(
        [
          'Configured Terminal:',
          '- Option-as-Meta enabled',
          "- Terminal's bell silenced",
          'Option+Enter now inserts a newline.',
          'Restart Terminal for the change to take effect.',
        ].join('\n'),
      ),
    }
  } catch {
    const restored = await execFileNoThrow('defaults', ['import', 'com.apple.Terminal', backupPath])
    if (restored.code === 0) {
      await execFileNoThrow('killall', ['cfprefsd'])
      markTerminalSetupComplete()
      throw new Error('Terminal setup failed; your preferences were restored from backup.')
    }
    throw new Error(
      `Terminal setup failed AND the restore failed — restore manually with: defaults import com.apple.Terminal ${backupPath}`,
    )
  }
}

export async function setupTerminal(theme: ThemeName): Promise<string> {
  const terminal = env.terminal
  const paint = paintFor(theme)
  if (terminal === null || !isSetupCapable(terminal)) {
    return unsupportedTerminalMessage(terminal)
  }

  let result: TerminalSetupResult
  if (terminal === 'Apple_Terminal') {
    result = await setupAppleTerminal(paint)
    if (result.installed) {
      saveGlobalConfig(current => ({ ...current, optionAsMetaKeyInstalled: true }))
      maybeMarkProjectOnboardingComplete()
    }
    return result.message
  }

  if (Object.hasOwn(VSCODE_FAMILY, terminal)) {
    result = await setupVscodeFamily(terminal, paint)
  } else if (terminal === 'zed') {
    result = await setupZed(paint)
  } else if (terminal === 'alacritty') {
    result = await setupAlacritty(paint)
  } else {
    return unsupportedTerminalMessage(terminal)
  }

  if (result.installed) {
    saveGlobalConfig(current => ({ ...current, shiftEnterKeyBindingInstalled: true }))
    maybeMarkProjectOnboardingComplete()
  }
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
  if (terminal !== null && Object.hasOwn(NATIVE_TERMINALS, terminal)) {
    onDone(
      `${NATIVE_TERMINALS[terminal]} supports the chord natively — no configuration is needed; Shift+Enter inserts newlines.`,
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
    logError(error)
    const paint = paintFor(context.options.theme)
    onDone(paint.fail(error instanceof Error ? error.message : String(error)))
  }
  return null
}

export function hasUsedBackslashReturn(): boolean {
  return Boolean(getGlobalConfig().hasUsedBackslashReturn)
}

export function markBackslashReturnUsed(): void {
  if (getGlobalConfig().hasUsedBackslashReturn) return
  saveGlobalConfig(current => ({ ...current, hasUsedBackslashReturn: true }))
}

export function shouldOfferTerminalSetup(): boolean {
  const terminal = env.terminal
  if (terminal === null || !isSetupCapable(terminal)) return false
  const config = getGlobalConfig()
  if (terminal === 'Apple_Terminal') {
    return !config.optionAsMetaKeyInstalled
  }
  if (Object.hasOwn(VSCODE_FAMILY, terminal) && isRemoteVscodeSession()) {
    return false
  }
  return !config.shiftEnterKeyBindingInstalled
}
