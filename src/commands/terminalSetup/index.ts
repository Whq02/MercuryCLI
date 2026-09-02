import type { Command } from '../../types/command.js'
import { env } from '../../utils/env.js'

const DESCRIPTOR_NATIVE_TERMINALS = new Set(['ghostty', 'kitty', 'iTerm.app', 'WezTerm'])

const terminalSetup = {
  type: 'local-jsx',
  name: 'terminal-setup',
  description:
    env.terminal === 'Apple_Terminal'
      ? 'Enable an Option+Enter binding for newlines and switch to a visual bell'
      : 'Install a Shift+Enter binding for newlines',
  isHidden: env.terminal !== null && DESCRIPTOR_NATIVE_TERMINALS.has(env.terminal),
  load: () => import('./terminalSetup.js'),
} satisfies Command

export default terminalSetup
