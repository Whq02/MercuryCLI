import type { Command } from '../../commands.js'

const trace = {
  type: 'local-jsx',
  immediate: true,
  name: 'trace',
  description:
    'Open the Mercury invocation trace — recent tool calls, risk, and outcomes',
  isEnabled: () => true,
  load: () => import('./trace.js'),
} satisfies Command

export default trace
