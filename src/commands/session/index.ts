import type { Command } from '../../types/command.js'
import { getIsRemoteMode } from '../../bootstrap/state.js'

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
