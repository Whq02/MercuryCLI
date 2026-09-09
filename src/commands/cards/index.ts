import type { Command } from '../../commands.js'
import { experienceCardsEnabled } from '../../memdir/experienceCards.js'


const command = {
  type: 'local-jsx',
  name: 'cards',
  description: 'Browse + promote experience-card memory (candidate → approved)',
  isEnabled: () => experienceCardsEnabled(),
  isHidden: false,
  load: () => import('./cards.js'),
} satisfies Command

export default command
