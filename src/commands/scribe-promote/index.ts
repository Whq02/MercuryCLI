import type { Command } from '../../commands.js'

// ============================================================================
// commands/scribe-promote/index.ts — `/scribe-promote`: ratify staged scribe
// candidates into root memory.
// ----------------------------------------------------------------------------
// Closes the severed RATIFY half of the scribe-note loop. Scribe Mode stages
// COMPACT session notes into the recall-excluded `scribe/` scope (the
// RememberLesson `scope:'scribe'` route); promoteScribeCandidate (the proven,
// non-clobbering, secret-refusing ratify path) had ZERO runtime callers, so a
// staged note could be written but NEVER ratified in-session. /scribe-promote
// lists the staged candidates and ratifies the selected one (the `p` key) via
// that proven path — the sibling of /cards for the scribe scope.
//
// The scribe scope is a Mercury concept; mirrors /cards. The command is
// non-ant only.
// ============================================================================

const command = {
  type: 'local-jsx',
  name: 'scribe-promote',
  description: 'Ratify staged scribe candidates into root memory',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./scribe-promote.js'),
} satisfies Command

export default command
