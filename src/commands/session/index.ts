import type { Command } from '../../types/command.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'

/**
 * Registration only — the rendering body is the low-residue sibling,
 * loaded lazily. Enabled only in remote mode; hidden via a getter so the
 * check re-runs on every read.
 */
const session = {
  type: 'local-jsx',
  name: 'session',
  aliases: ['remote'],
  description: 'Reach this session from another device — URL and QR',
  isEnabled: () => getIsRemoteMode(),
  get isHidden() {
    return !getIsRemoteMode()
  },
  load: () => import('./session.js'),
} satisfies Command

export default session
