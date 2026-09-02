/**
 * Dependency-free enumerations shared by the settings schema and the config
 * tool. This module must import nothing — it sits below everything else to
 * avoid import cycles. The strings appear in settings files.
 */

export const NOTIFICATION_CHANNELS = [
  'auto',
  'iterm2',
  'iterm2_with_bell',
  'terminal_bell',
  'kitty',
  'ghostty',
  'notifications_disabled',
] as const

// A deprecated third mode is excluded here and auto-migrated to 'normal' by
// the migration layer.
export const EDITOR_MODES = ['normal', 'vim'] as const

// Respectively: choose based on context (the default), terminal-multiplexer
// teammates, and teammates running inside the same process.
export const TEAMMATE_MODES = ['auto', 'tmux', 'in-process'] as const
