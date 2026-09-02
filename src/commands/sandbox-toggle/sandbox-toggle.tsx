import * as React from 'react'
import { relative } from 'node:path'
import { SandboxSettings } from '../../components/sandbox/SandboxSettings.js'
import { colorize } from '../../ink/colorize.js'
import { addToExcludedCommands, SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getPlatform } from '../../utils/platform.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsFilePathForSource,
} from '../../utils/settings/settings.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getTheme } from '../../utils/theme.js'

/** Theme-driven colours, defaulting to the light theme when unset.
 *  The roles are `rgb(…)` strings, which chalk.hex cannot parse (it read the
 *  first digits as a short hex and painted dark grey) — the shared colouriser
 *  understands every role spelling. */
function themeColors(): { error: (text: string) => string; success: (text: string) => string } {
  const theme = getTheme(getGlobalConfig().theme ?? 'light')
  return {
    error: (text: string) => colorize(text, theme.error, 'foreground'),
    success: (text: string) => colorize(text, theme.success, 'foreground'),
  }
}

/**
 * `/sandbox` — the settings screen, or the `exclude` sub-command. The
 * context is ignored; `onDone` takes only a result string.
 */
export async function call(
  onDone: (result?: string) => void,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode | null> {
  const colors = themeColors()

  // Invocation refusals, each closing with an error-coloured result.
  if (!(await SandboxManager.isSupportedPlatform())) {
    onDone(
      colors.error(
        getPlatform() === 'wsl'
          ? 'Sandboxing requires WSL2 — WSL1 is not supported.'
          : 'Sandboxing is not supported on this platform. Supported platforms: macOS, Linux and WSL2.',
      ),
    )
    return null
  }
  if (!SandboxManager.isPlatformInEnabledList()) {
    onDone(
      colors.error(
        `Sandboxing is not enabled for ${getPlatform()} — the sandbox.enabledPlatforms setting excludes this platform.`,
      ),
    )
    return null
  }
  if (SandboxManager.areSandboxSettingsLockedByPolicy()) {
    onDone(
      colors.error(
        'Sandbox settings are locked by a higher-priority configuration and cannot be changed locally.',
      ),
    )
    return null
  }

  const trimmed = (args ?? '').trim()
  if (trimmed === '') {
    return <SandboxSettings depCheck={SandboxManager.checkDependencies()} onComplete={onDone} />
  }

  const firstToken = trimmed.split(/\s+/)[0]
  if (firstToken !== 'exclude') {
    onDone(
      colors.error(`Unknown sub-command "${firstToken}" — exclude is the only available sub-command.`),
    )
    return null
  }

  let pattern = trimmed.slice('exclude'.length + 1).trim()
  // Strip a single leading and a single trailing quote (single or double).
  pattern = pattern.replace(/^['"]/, '').replace(/['"]$/, '')
  if (pattern === '') {
    onDone(colors.error('Specify a command pattern to exclude, e.g. /sandbox exclude "npm run *"'))
    return null
  }

  const used = addToExcludedCommands(pattern)
  const absolutePath = getSettingsFilePathForSource('localSettings')
  const settingsPath =
    absolutePath !== undefined
      ? relative(process.cwd(), absolutePath)
      : getRelativeSettingsFilePathForSource('localSettings')
  onDone(colors.success(`Excluded "${used}" from sandboxing — saved to ${settingsPath}.`))
  return null
}
