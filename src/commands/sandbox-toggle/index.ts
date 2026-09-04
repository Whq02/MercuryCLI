import type { Command } from '../../types/command.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getPlatform } from '../../utils/platform.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'

function platformLooksSupported(): boolean {
  const platform = getPlatform()
  return platform === 'macos' || platform === 'linux' || platform === 'wsl'
}

const sandboxToggle = {
  type: 'local-jsx',
  name: 'sandbox',
  argumentHint: 'exclude "command pattern"',
  immediate: true,
  description: 'Sandboxing — Enter opens the configuration',
  currentValue: () => {
    const check = SandboxManager.checkDependencies()
    const enabled = SandboxManager.isSandboxingEnabled()
    const glyph = check.errors.length > 0 ? GLYPH.warn : enabled ? '✓' : '◯'
    let phrase = enabled ? 'enabled' : 'disabled'
    if (enabled) {
      if (SandboxManager.isAutoAllowBashIfSandboxedEnabled()) phrase += ' · auto-allow'
      if (SandboxManager.areUnsandboxedCommandsAllowed()) phrase += ' · fallback'
    }
    const managed = SandboxManager.areSandboxSettingsLockedByPolicy() ? ' · managed' : ''
    return `${glyph} ${phrase}${managed}`
  },
  get isHidden() {
    return !platformLooksSupported() || !SandboxManager.isPlatformInEnabledList()
  },
  load: () => import('./sandbox-toggle.js'),
} satisfies Command

export default sandboxToggle
