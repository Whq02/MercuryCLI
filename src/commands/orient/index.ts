import type { Command } from '../../commands.js'
import { repoSurfaceMapEnabled } from '../../utils/cockpit/repoSurfaceMap.js'

const orient = {
  type: 'local',
  name: 'orient',
  isEnabled: () => repoSurfaceMapEnabled(),
  description: 'Repo surface map — auto-derived orientation for this repository',
  supportsNonInteractive: true,
  load: () => import('./orient.js'),
} satisfies Command

export default orient
