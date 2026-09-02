import type { Command } from '../../commands.js'


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
