import type { Command } from '../../types/command.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getPlatform } from '../../utils/platform.js'

/** Sandboxing runs on macOS, Linux and WSL2 (WSL1 is refused at invocation,
 *  where the version can be probed asynchronously). */
function platformLooksSupported(): boolean {
  const platform = getPlatform()
  return platform === 'macos' || platform === 'linux' || platform === 'wsl'
}

/**
 * Registration: name `sandbox`, immediate, with the live composed
 * description and platform-keyed hiding, both getter-based so every read
 * re-evaluates.
 */
const sandboxToggle = {
  type: 'local-jsx',
  name: 'sandbox',
  argumentHint: 'exclude "command pattern"',
  immediate: true,
  get description() {
    const check = SandboxManager.checkDependencies()
    const enabled = SandboxManager.isSandboxingEnabled()
    const glyph = check.errors.length > 0 ? '⚠\uFE0E' : enabled ? '✓' : '◯'
    let phrase = 'Sandboxing disabled'
    if (enabled) {
      phrase = SandboxManager.isAutoAllowBashIfSandboxedEnabled()
        ? 'Sandboxing enabled (auto-allow)'
        : 'Sandboxing enabled'
      if (SandboxManager.areUnsandboxedCommandsAllowed()) {
        phrase += ', fallback allowed'
      }
    }
    const managed = SandboxManager.areSandboxSettingsLockedByPolicy() ? ' (managed)' : ''
    return `${glyph} ${phrase}${managed} — Enter opens the configuration`
  },
  get isHidden() {
    return !platformLooksSupported() || !SandboxManager.isPlatformInEnabledList()
  },
  load: () => import('./sandbox-toggle.js'),
} satisfies Command

export default sandboxToggle
