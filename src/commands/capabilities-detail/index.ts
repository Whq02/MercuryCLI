import type { Command } from '../../commands.js'

// /capabilities-detail — the rich, honest-read capability inspector. Where
// /capabilities mounts the CapabilityManagerView (the flip/manage surface),
// this surfaces the FULL per-item model the data layer already carries (MCP
// transport/approval/env/admission/legacy-deprecation, skill risk/scope/
// approval, extension version/source/declared servers) across MCP / Skills /
// Extensions tabs. Read-only.
const command = {
  type: 'local-jsx',
  name: 'capabilities-detail',
  description: 'Capability inspector — MCP / skills / extensions detail (honest read)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./capabilities-detail.js'),
} satisfies Command

export default command
