import { getInitialSettings } from '../platform/settings/settings.js'

export function shouldIncludeGitInstructions(): boolean {
  return getInitialSettings().briefs?.git !== false
}
