import { getInitialSettings } from './settings/settings.js'

export function shouldIncludeGitInstructions(): boolean {
  return getInitialSettings().includeGitInstructions !== false
}
