import { getInitialSettings } from '../settings/settings.js'

export function resolveDefaultShell(): 'bash' | 'powershell' {
  return getInitialSettings().shell?.kind ?? 'bash'
}
