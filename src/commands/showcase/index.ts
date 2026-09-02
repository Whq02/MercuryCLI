import type { Command } from '../../commands.js'
import { devSurfacesEnabled } from '../effectiveCatalogue.js'

const command = {
  type: 'local-jsx',
  name: 'showcase',
  description: 'Dev fixture — gallery of chrome-component design specimens (MERCURY_DEV_SURFACES)',
  devOnly: true,
  isEnabled: () => devSurfacesEnabled(),
  load: () => import('./showcase.js'),
} satisfies Command

export default command
