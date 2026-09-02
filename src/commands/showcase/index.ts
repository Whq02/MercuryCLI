import type { Command } from '../../commands.js'
import { devSurfacesEnabled } from '../effectiveCatalogue.js'

// /showcase — the chrome-component specimen gallery (illustrative props for
// render/design work). DEVELOPMENT ONLY: behind the ONE
// dev boundary — unarmed it is absent from the effective roster and every
// projection; MERCURY_DEV_SURFACES=1 arms it for design sessions.
const command = {
  type: 'local-jsx',
  name: 'showcase',
  description: 'Dev fixture — gallery of chrome-component design specimens (MERCURY_DEV_SURFACES)',
  devOnly: true,
  isEnabled: () => devSurfacesEnabled(),
  load: () => import('./showcase.js'),
} satisfies Command

export default command
