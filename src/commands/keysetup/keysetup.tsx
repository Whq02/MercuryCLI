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
import { notBuilt } from '../../pi/holes.js'

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


export async function setupTerminal(theme: ThemeName): Promise<string> {
  return notBuilt('src/commands/keysetup/keysetup.tsx:330')
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

export const call: LocalJSXCommandCall = async (onDone, context) => notBuilt('src/commands/keysetup/keysetup.tsx:386')

export function hasUsedBackslashReturn(): boolean {
  return notBuilt('src/commands/keysetup/keysetup.tsx:411')
}

export function markBackslashReturnUsed(): void {
  return notBuilt('src/commands/keysetup/keysetup.tsx:415')
}

export function shouldOfferTerminalSetup(): boolean {
  return notBuilt('src/commands/keysetup/keysetup.tsx:420')
}
