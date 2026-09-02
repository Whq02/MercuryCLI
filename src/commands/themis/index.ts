import type { Command } from '../../commands.js'
import { themisActive } from '../../substrate/themis/level.js'

// ============================================================================
// commands/themis/index.ts — `/themis`: the THEMIS tracked change mission
// The optional run-discipline front door for
// SUBSTANTIAL work: track a bounded multi-file change against amendable
// criteria/paths/checks; expected work stays quiet; unexpected paths get ONE
// warning each (warn records, enforce refuses with directions); completion
// demands implementing changes + FRESH verify-evidence per criterion and
// writes one compact receipt. Ordinary untracked editing is untouched.
// Level-gated: MERCURY_THEMIS off ⇒ the command is absent ⇒ byte-identical.
// ============================================================================

// The /mission spelling belongs to the standing-mission command
// (commands/mission); this surface is THEMIS-branded throughout.
export const themis: Command = {
  type: 'local',
  name: 'themis',
  description: 'Track a bounded change mission: criteria, expected paths, drift warnings, evidence-gated completion (THEMIS)',
  argumentHint: '[start <title> | crit <text> :: <paths> :: <checks> | add <path> | inspected <path> | done | drop <why>]',
  isEnabled: () => themisActive(),
  supportsNonInteractive: true,
  load: () => import('./themis.js'),
}

export default themis
