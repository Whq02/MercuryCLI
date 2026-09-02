// ============================================================================
//  src/commands/terminalSetup/terminalSetup.tsx — the /terminal-setup body:
//  per-terminal Shift+Enter / Option-as-Meta installers, backups, and
//  result text.
// ============================================================================
import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import chalk from 'chalk'
import React from 'react'
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
import { isFsInaccessible } from '../../utils/errors.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { createHyperlink } from '../../utils/hyperlink.js'
import { addItemToJSONCArray, safeParseJSONC } from '../../utils/json.js'
import { logError } from '../../utils/log.js'
import { getTheme, type ThemeName } from '../../utils/theme.js'

// The BODY's native map — five entries; the descriptor's map has four. The
// divergence is observable (Warp is listed but refuses) and preserved.
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

/** ESC then CR — the escape sequence every editor binding writes. */
const ESC_CR = '\x1b\r'

/** OSC 8 (BEL-terminated) hyperlink when supported; the plain path
 *  otherwise. The visible text is always the clean path. */
function linkedPath(path: string): string {
  if (!supportsHyperlinks()) return path
  return createHyperlink(path, `file://${path}`)
}

function backupSuffix(): string {
  return `.${randomBytes(4).toString('hex')}.bak`
}

/** Result-text tints ride the theme's status roles — the fixed spine
 *  (success · warning · error) through the shared colouriser — never the
 *  terminal's named ANSI palette. */
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

// ── VSCode family ──────────────────────────────────────────────────────────

function isRemoteVscodeSession(): boolean {
  // The askpass helper path is the more reliable signal; PATH substrings are
  // matched without a separator so Windows works.
  const askpass = process.env.VSCODE_GIT_ASKPASS_MAIN ?? ''
  const pathVar = process.env.PATH ?? ''
  const markers = ['.vscode-server', '.cursor-server', '.windsurf-server']
  return markers.some(marker => askpass.includes(marker) || pathVar.includes(marker))
}

async function installVscodeFamily(terminal: string, paint: Paint): Promise<string> {
  const editorDir = VSCODE_FAMILY[terminal]!
  try {
    if (isRemoteVscodeSession()) {
      return paint.warn(
        [
          'Keybindings cannot be installed from a remote session — they belong on the local machine.',
          'To add the binding manually:',
          '1. Open the editor locally.',
          '2. Open the keyboard-shortcuts JSON via the command palette ("Preferences: Open Keyboard Shortcuts (JSON)").',
          '3. Add this entry (the file must be a JSON array):',
          '   { "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\\u001b\\r" }, "when": "terminalFocus" }',
        ].join('\n'),
      )
    }
    const home = homedir()
    const userDir =
      process.platform === 'win32'
        ? join(home, 'AppData', 'Roaming', editorDir, 'User')
        : process.platform === 'darwin'
          ? join(home, 'Library', 'Application Support', editorDir, 'User')
          : join(home, '.config', editorDir, 'User')
    // The create happens BEFORE the read.
    await mkdir(userDir, { recursive: true })
    const filePath = join(userDir, 'keybindings.json')
    let content = '[]'
    let existed = false
    try {
      content = await readFile(filePath, 'utf8')
      existed = true
    } catch (error) {
      if (!isFsInaccessible(error)) throw error
      // Missing/permission-class: default to an empty array.
    }
    const parsed = safeParseJSONC(content)
    const entries = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
    // Backup BEFORE duplicate detection — an idempotent re-run still writes
    // a backup file (the observed order, preserved).
    if (existed) {
      const backupPath = `${filePath}${backupSuffix()}`
      try {
        await copyFile(filePath, backupPath)
      } catch {
        return paint.warn(
          `Could not back up ${filePath} to ${backupPath} — nothing was written.`,
        )
      }
    }
    const duplicate = entries.some(
      entry =>
        entry.key === 'shift+enter' &&
        entry.command === 'workbench.action.terminal.sendSequence' &&
        entry.when === 'terminalFocus',
    )
    if (duplicate) {
      return paint.warn(
        `A Shift+Enter terminal binding already exists in ${linkedPath(filePath)} — remove it first if you want it reinstalled.`,
      )
    }
    // A structural JSONC array insert — comments and formatting preserved,
    // never a re-serialize.
    const updated = addItemToJSONCArray(content, {
      key: 'shift+enter',
      command: 'workbench.action.terminal.sendSequence',
      args: { text: ESC_CR },
      when: 'terminalFocus',
    })
    await writeFile(filePath, updated, 'utf8')
    return [
      paint.ok(`Installed the Shift+Enter binding for newlines.`),
      chalk.dim(linkedPath(filePath)),
    ].join('\n')
  } catch (error) {
    logError(error)
    throw new Error(`Failed to install the ${editorDir} Shift+Enter binding`)
  }
}

// ── Apple Terminal ─────────────────────────────────────────────────────────

async function readTerminalDefault(key: string): Promise<string> {
  const result = await execFileNoThrow('defaults', ['read', 'com.apple.Terminal', key])
  if (result.code !== 0 || result.stdout.trim() === '') {
    throw new Error(`Could not read the Terminal preference '${key}'`)
  }
  return result.stdout.trim()
}

/** Add first, Set on non-zero (the key usually already exists). Profile
 *  names are single-quoted inside the command so spaces work. */
async function setProfileProperty(
  profile: string,
  key: string,
  value: 'true' | 'false',
): Promise<boolean> {
  const plist = getTerminalPlistPath()
  const target = `:Window Settings:${profile}:${key}`
  const add = await execFileNoThrow('/usr/libexec/PlistBuddy', [
    '-c',
    `Add '${target}' bool ${value}`,
    plist,
  ])
  if (add.code === 0) return true
  const set = await execFileNoThrow('/usr/libexec/PlistBuddy', [
    '-c',
    `Set '${target}' ${value}`,
    plist,
  ])
  if (set.code === 0) return true
  logError(new Error(`Could not update ${key} for Terminal profile ${profile}`))
  return false
}

async function installAppleTerminal(paint: Paint): Promise<string> {
  const backupPath = await backupTerminalPreferences()
  if (backupPath === null) {
    throw new Error('Backing up the Terminal preferences failed — bailing out.')
  }
  try {
    const defaultProfile = await readTerminalDefault('Default Window Settings')
    const startupProfile = await readTerminalDefault('Startup Window Settings')
    const profiles = [defaultProfile]
    if (startupProfile !== defaultProfile) profiles.push(startupProfile)
    let anyUpdated = false
    for (const profile of profiles) {
      const optionUpdated = await setProfileProperty(profile, 'useOptionAsMetaKey', 'true')
      const bellUpdated = await setProfileProperty(profile, 'Bell', 'false')
      if (optionUpdated || bellUpdated) anyUpdated = true
    }
    if (!anyUpdated) {
      throw new Error('No Terminal profile property could be updated')
    }
    await execFileNoThrow('killall', ['cfprefsd'])
    markTerminalSetupComplete()
    return [
      paint.ok('Configured Terminal:'),
      paint.ok(' - Option-as-Meta enabled'),
      paint.ok(' - Switched to a visual bell'),
      chalk.dim('Option+Enter now inserts a newline.'),
      chalk.dim('Restart Terminal for the change to take effect.'),
    ].join('\n')
  } catch (error) {
    logError(error)
    const restore = await execFileNoThrow('defaults', [
      'import',
      'com.apple.Terminal',
      backupPath,
    ])
    if (restore.code === 0) {
      throw new Error('Terminal setup failed; your preferences were restored from backup.')
    }
    if (backupPath) {
      throw new Error(
        `Terminal setup failed AND the restore failed — restore manually with: defaults import com.apple.Terminal ${backupPath}`,
      )
    }
    throw new Error('Terminal setup failed and no backup was available.')
  }
}

// ── Alacritty ──────────────────────────────────────────────────────────────

const ALACRITTY_TABLE = `[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "\\u001b\\r"\n`

async function installAlacritty(paint: Paint): Promise<string> {
  try {
    const candidates: string[] = []
    if (process.env.XDG_CONFIG_HOME) {
      candidates.push(join(process.env.XDG_CONFIG_HOME, 'alacritty', 'alacritty.toml'))
    } else {
      candidates.push(join(homedir(), '.config', 'alacritty', 'alacritty.toml'))
    }
    if (process.platform === 'win32' && process.env.APPDATA) {
      candidates.push(join(process.env.APPDATA, 'alacritty', 'alacritty.toml'))
    }
    if (candidates.length === 0) throw new Error('No Alacritty config path could be produced')
    let target: string | null = null
    let content = ''
    let existed = false
    for (const candidate of candidates) {
      try {
        // This probe loop sits OUTSIDE the installer's outer guard: a
        // non-inaccessible read error escapes UNWRAPPED (unlike the VSCode
        // and Zed reads) — the asymmetry is deliberate and preserved.
        content = await readFile(candidate, 'utf8')
        target = candidate
        existed = true
        break
      } catch (error) {
        if (!isFsInaccessible(error)) throw error
      }
    }
    if (target === null) {
      target = candidates[0]!
      await mkdir(dirname(target), { recursive: true })
    }
    // Textual duplicate detection — imprecise by design: two unrelated
    // bindings, one with the Shift mods line and one with the Return key
    // line, false-positive. Preserved.
    if (existed && content.includes('mods = "Shift"') && content.includes('key = "Return"')) {
      return paint.warn(
        `A Shift+Return binding already exists in ${linkedPath(target)} — remove it first if you want it reinstalled.`,
      )
    }
    if (existed) {
      const backupPath = `${target}${backupSuffix()}`
      try {
        await copyFile(target, backupPath)
      } catch {
        return paint.warn(
          `Could not back up ${target} to ${backupPath} — nothing was written.`,
        )
      }
    }
    // When existing content is non-empty and does not end in a newline, add
    // one; then UNCONDITIONALLY a newline, the table, a final newline. On a
    // fresh file the result therefore STARTS with a blank line.
    let updated = content
    if (updated !== '' && !updated.endsWith('\n')) updated += '\n'
    updated += `\n${ALACRITTY_TABLE}`
    await writeFile(target, updated, 'utf8')
    return [
      paint.ok('Installed the Shift+Enter binding for Alacritty.'),
      paint.ok('A restart of Alacritty may be needed.'),
      chalk.dim(linkedPath(target)),
    ].join('\n')
  } catch (error) {
    logError(error)
    throw new Error('Failed to install the Alacritty Shift+Enter binding')
  }
}

// ── Zed ────────────────────────────────────────────────────────────────────

async function installZed(paint: Paint): Promise<string> {
  try {
    const filePath = join(homedir(), '.config', 'zed', 'keymap.json')
    await mkdir(dirname(filePath), { recursive: true })
    let content = '[]'
    let existed = false
    try {
      content = await readFile(filePath, 'utf8')
      existed = true
    } catch (error) {
      if (!isFsInaccessible(error)) throw error
    }
    // Textual duplicate detection: the string anywhere (comments included).
    if (existed && content.includes('shift-enter')) {
      return paint.warn(
        `A shift-enter binding already exists in ${linkedPath(filePath)} — remove it first if you want it reinstalled.`,
      )
    }
    if (existed) {
      const backupPath = `${filePath}${backupSuffix()}`
      try {
        await copyFile(filePath, backupPath)
      } catch {
        return paint.warn(
          `Could not back up ${filePath} to ${backupPath} — nothing was written.`,
        )
      }
    }
    // A parse failure OR non-array silently degrades to an empty array — a
    // malformed keymap is REPLACED (deliberate; differs from the VSCode
    // path, mitigated only by the backup above).
    const parsed = safeParseJSONC(content)
    const entries = Array.isArray(parsed) ? (parsed as unknown[]) : []
    entries.push({
      context: 'Terminal',
      bindings: { 'shift-enter': ['terminal::SendText', ESC_CR] },
    })
    await writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    return [
      paint.ok('Installed the shift-enter binding for Zed.'),
      chalk.dim(linkedPath(filePath)),
    ].join('\n')
  } catch (error) {
    logError(error)
    throw new Error('Failed to install the Zed shift-enter binding')
  }
}

// ── the dispatch + post-install state ──────────────────────────────────────

/**
 * The installer switch: one arm per setup-capable terminal, an explicit
 * no-op arm for an unidentified terminal, and NO default arm — an
 * identified-but-unsupported terminal yields the empty string while the
 * config write and the onboarding mark still run (the write itself no-ops
 * because neither branch's terminal test matches).
 */
export async function setupTerminal(theme: ThemeName): Promise<string> {
  const paint = paintFor(theme)
  const terminal = env.terminal
  let result = ''
  switch (terminal) {
    case 'vscode':
    case 'cursor':
    case 'windsurf':
      result = await installVscodeFamily(terminal, paint)
      break
    case 'Apple_Terminal':
      result = await installAppleTerminal(paint)
      break
    case 'alacritty':
      result = await installAlacritty(paint)
      break
    case 'zed':
      result = await installZed(paint)
      break
    case null:
      // Unidentified: explicit no-op.
      break
  }
  // Post-install state, ALWAYS applied (even on a warning result),
  // idempotently.
  const config = getGlobalConfig()
  if (
    ['vscode', 'cursor', 'windsurf', 'alacritty', 'zed'].includes(terminal ?? '') &&
    config.shiftEnterKeyBindingInstalled !== true
  ) {
    saveGlobalConfig(current => ({ ...current, shiftEnterKeyBindingInstalled: true }))
  }
  if (terminal === 'Apple_Terminal' && config.optionAsMetaKeyInstalled !== true) {
    saveGlobalConfig(current => ({ ...current, optionAsMetaKeyInstalled: true }))
  }
  maybeMarkProjectOnboardingComplete()
  return result
}

function unsupportedTerminalMessage(terminal: string | null): string {
  const name = terminal ?? 'your current terminal'
  // win32 contributes NO row: there is no Windows Terminal installer arm,
  // so the refusal used to name Windows Terminal under "Supported
  // terminals" two lines after refusing to run from it (TASK-017
  // supplement, SURVIVED — three lenses filed it independently).
  const platformLine = process.platform === 'darwin' ? ' - Apple Terminal\n' : ''
  return [
    `/terminal-setup cannot run from ${name}. It installs a Shift+Enter newline binding into your terminal's configuration.`,
    // ONE rendered backslash (CI-03's second half): the doubled artefact
    // taught `\\ then Enter`, and two backslashes read as a UNC prefix to
    // the continuation test — typing them SUBMITS the draft instead of
    // inserting the newline this line promises.
    chalk.dim('Backslash-then-return (\\ then Enter) already inserts a newline today.'),
    'Using tmux or screen?',
    ' 1. Leave the multiplexer.',
    ' 2. Run /terminal-setup directly in a supported terminal.',
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
  if (terminal && NATIVE_TERMINALS[terminal]) {
    onDone(
      `${NATIVE_TERMINALS[terminal]} supports the chord natively — no configuration is needed; Shift+Enter inserts newlines.`,
    )
    return null
  }
  if (!terminal || !isSetupCapable(terminal)) {
    onDone(unsupportedTerminalMessage(terminal))
    return null
  }
  try {
    const result = await setupTerminal(context.options.theme)
    onDone(result)
  } catch (error) {
    onDone(
      paintFor(context.options.theme).fail(
        error instanceof Error ? error.message : String(error),
      ),
    )
  }
  return null
}

// ── exported helpers used elsewhere ────────────────────────────────────────
// The three stored-state keys are contract data, compared strictly to true.

export function isShiftEnterKeyBindingInstalled(): boolean {
  return getGlobalConfig().shiftEnterKeyBindingInstalled === true
}

export function hasUsedBackslashReturn(): boolean {
  return getGlobalConfig().hasUsedBackslashReturn === true
}

/** Idempotent one-way setter. */
export function markBackslashReturnUsed(): void {
  if (getGlobalConfig().hasUsedBackslashReturn === true) return
  saveGlobalConfig(current => ({ ...current, hasUsedBackslashReturn: true }))
}

/** Whether the onboarding flow should offer terminal setup: a
 *  setup-capable terminal whose binding is not yet installed. */
export function shouldOfferTerminalSetup(): boolean {
  const terminal = env.terminal
  if (!terminal || !isSetupCapable(terminal)) return false
  if (terminal === 'Apple_Terminal') {
    return getGlobalConfig().optionAsMetaKeyInstalled !== true
  }
  return getGlobalConfig().shiftEnterKeyBindingInstalled !== true
}

/** The display name of the current native terminal, or null. */
export function getNativeCSIuTerminalDisplayName(): string | null {
  const terminal = env.terminal
  if (!terminal) return null
  return NATIVE_TERMINALS[terminal] ?? null
}
