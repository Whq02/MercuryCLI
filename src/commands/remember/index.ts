import type { Command } from '../../commands.js'
import { experienceCardsEnabled } from '../../memdir/experienceCards.js'


export const remember: Command = {
  type: 'local',
  name: 'remember',
  description: 'Bank a transferable lesson as an experience card — or `project: <rule>` to record a convention in the project instruction estate',
  argumentHint: '<a lesson worth keeping across sessions — or project: <a durable convention for this project>>',
  isEnabled: () => experienceCardsEnabled() && true,
  supportsNonInteractive: false,
  userPrivate: true,
  load: () => import('./remember.js'),
}

export default remember
