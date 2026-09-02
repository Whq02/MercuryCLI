// ============================================================================
//  src/commands/terminalSetup/index.ts — the /terminal-setup descriptor.
//  Its native map has FOUR entries; the body's has five (Warp) — the
//  divergence is observable (in Warp the command is listed but refuses)
//  and is preserved deliberately.
// ============================================================================
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
