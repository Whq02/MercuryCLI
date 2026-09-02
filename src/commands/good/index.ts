import type { Command } from '../../commands.js'
import { tasteLoopEnabled } from '../../memdir/tasteLoop.js'

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
  userPrivate: true,
  load: () => import('../taste/runTaste.js').then(m => ({ call: m.goodCall })),
}

export default good
