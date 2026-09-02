import type { Command } from '../../commands.js'
import { tasteLoopEnabled } from '../../memdir/tasteLoop.js'

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
  userPrivate: true,
  load: () => import('../taste/runTaste.js').then(m => ({ call: m.mehCall })),
}

export default meh
