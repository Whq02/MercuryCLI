import { getInitialSettings } from './settings/settings.js'

/**
 * The one settings-aware git toggle, deliberately kept out of the git
 * module: that module sits inside an editor-extension dependency graph that
 * must stay free of the settings module (which transitively pulls a
 * forbidden HTTP library), and settings already depend on git through the
 * ignore-rules path, so the reverse edge would be a cycle.
 */
export function shouldIncludeGitInstructions(): boolean {
  // (includeGitInstructions in settings is the one switch —
  // no env override.)
  return getInitialSettings().includeGitInstructions !== false
}
