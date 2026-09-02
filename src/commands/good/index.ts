import type { Command } from '../../commands.js'
import { tasteLoopEnabled } from '../../memdir/tasteLoop.js'

// `/good <praise>` — log a success episode for the Taste Loop. Same shape as
// /meh (capture → classify → persist → promote → recall) but for what worked, so
// good patterns are reinforced rather than only friction avoided. Flag-gated ⇒
// OFF the command is absent ⇒ byte-identical. Impl in ../taste/runTaste.ts.
export const good: Command = {
  type: 'local',
  name: 'good',
  description: 'Log what worked well in the last stretch — the Taste Loop reinforces it in future turns',
  argumentHint: '<what worked well>',
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
  load: () => import('../taste/runTaste.js').then(m => ({ call: m.goodCall })),
}

export default good
