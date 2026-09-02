import type { Command } from '../../commands.js'

// ============================================================================
// /auto-compact-window — descriptor for the auto-compact window setter.
// ----------------------------------------------------------------------------
// A thin, always-enabled command: bare invocation reports status, an argument
// parses/validates/persists. Text-in/text-out, so it works interactively and
// under -p/SDK alike; the body loads lazily on first use.
// ============================================================================

const autoCompactWindow: Command = {
  type: 'local',
  name: 'auto-compact-window',
  description:
    'View or set the auto-compact context window (auto, or 100k–1M tokens)',
  argumentHint: '[auto | <tokens>]',
  supportsNonInteractive: true,
  load: () => import('./applyAutoCompactWindow.js'),
}

export default autoCompactWindow
