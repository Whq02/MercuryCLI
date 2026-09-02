import { getInitialSettings } from '../settings/settings.js'

export function resolveDefaultShell(): 'bash' | 'powershell' {
  return getInitialSettings().defaultShell ?? 'bash'
}
