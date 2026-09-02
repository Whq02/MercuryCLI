import type { Command } from '../../commands.js'
import { repoSurfaceMapEnabled } from '../../utils/cockpit/repoSurfaceMap.js'

// /orient — fast onboarding: regenerate + print the auto-derived repo surface
// map on demand (the attachment injects it automatically only on the first
// turn in a repo with no orientation doc — MERCURY.md, AGENTS.md or a
// CLAUDE.md; the command works anywhere, any time).
const orient = {
  type: 'local',
  name: 'orient',
  // Fork + MERCURY_ONBOARDING (=0 kills the scan, the attachment, and this row).
  isEnabled: () => repoSurfaceMapEnabled(),
  description: 'Repo surface map — auto-derived orientation for this repository',
  supportsNonInteractive: true,
  load: () => import('./orient.js'),
} satisfies Command

export default orient
