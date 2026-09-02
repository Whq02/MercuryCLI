import type { Command } from '../../commands.js'
import { tasteLoopEnabled } from '../../memdir/tasteLoop.js'

// `/meh <complaint>` — log a friction episode for the Taste Loop. Captures a
// redacted, bounded recent-session snapshot, classifies the friction, persists
// it, and (on a repeated pattern) promotes a candidate lesson recalled in future
// turns. Flag-gated ⇒ OFF (MERCURY_TASTE_LOOP=0) the command is absent
// ⇒ byte-identical. Implementation in ../taste/runTaste.ts (shared with /good).
export const meh: Command = {
  type: 'local',
  name: 'meh',
  description: 'Log what felt off about the last stretch — the Taste Loop classifies it and adapts future turns',
  argumentHint: '<what felt off>',
  isEnabled: () => tasteLoopEnabled(),
  get isHidden() {
    return !tasteLoopEnabled()
  },
  supportsNonInteractive: false,
  // The operator's own feedback line (the command-privacy law):
  // it never enters a model conversation, never starts a
  // turn, never bills a token — the same class as /note · /minerva ·
  // /remember.
  userPrivate: true,
  load: () => import('../taste/runTaste.js').then(m => ({ call: m.mehCall })),
}

export default meh
