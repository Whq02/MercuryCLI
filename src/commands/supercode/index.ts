import type { Command } from '../../commands.js'

// /supercode — the honest supercode MODE surface (max effort + standing
// dynamic-orchestration, session-only; Mercury pins max). Mounts
// SupercodeModeView; the LIVE flip is `/effort supercode` (effort.tsx's
// applier). Mirrors the /mode command shape.
const command = {
  type: 'local-jsx',
  name: 'supercode',
  description: 'Supercode mode — max effort + standing dynamic-orchestration (session-only; an explicit /effort level clears it)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./supercode.js'),
} satisfies Command

export default command
