import type { Command } from '../../commands.js'

const trace = {
  type: 'local-jsx',
  immediate: true,
  name: 'trace',
  description:
    'Open the Mercury invocation trace — recent tool calls, risk, and outcomes',
  // The invocation trace emitter is unconditional,
  // so the viewer is too — hidden without the stamp.
  isEnabled: () => true,
  load: () => import('./trace.js'),
} satisfies Command

export default trace
