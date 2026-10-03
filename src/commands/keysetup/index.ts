import type { Command } from '../../types/command.js'
import { env } from '../../utils/env.js'

const DESCRIPTOR_NATIVE_TERMINALS = new Set(['ghostty', 'kitty', 'iTerm.app', 'WezTerm'])

const keysetup = {
  type: 'local-jsx',
  name: 'keysetup',
  description:
    env.terminal === 'Apple_Terminal'
      ? "Make Option+Enter add a new line and silence Terminal's bell"
      : 'Install a Shift+Enter binding for newlines',
  isHidden: env.terminal !== null && DESCRIPTOR_NATIVE_TERMINALS.has(env.terminal),
  load: () => import('./keysetup.js'),
} satisfies Command

export default keysetup
