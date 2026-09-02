import { getInitialSettings } from '../settings/settings.js'

/**
 * Which shell runs input-box `!` commands.
 *
 * One rung, then the floor:
 * settings.defaultShell if set, otherwise 'bash' — on every platform.
 * Windows deliberately gets no PowerShell auto-flip: operators with
 * bash-flavoured hooks would break the moment the default moved.
 */
export function resolveDefaultShell(): 'bash' | 'powershell' {
  return getInitialSettings().defaultShell ?? 'bash'
}
