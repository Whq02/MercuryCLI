import type { Command } from '../../commands.js'

// /policy — the Mercury governance posture (read-only). Distinct from the
// base /permissions rule editor, which is left untouched.
const policy = {
  type: 'local-jsx',
  immediate: true,
  name: 'policy',
  // Mercury-only surface — hidden on a bare-stamp build.
  isEnabled: () => true,
  description: 'Mercury governance posture — mode, MCP risk, kill switches, denials',
  load: () => import('./policy.js'),
} satisfies Command

export default policy
