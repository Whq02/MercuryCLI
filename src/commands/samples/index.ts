import type { Command } from '../../commands.js'
import { samplesEnabled } from '../../services/samples/contracts.js'

const samples = {
  type: 'local-jsx',
  name: 'samples',
  immediate: true,
  description: 'Samples — the pages the model drew for you in this session; Enter opens one in your browser',
  isEnabled: () => samplesEnabled(),
  load: () => import('./samples.js'),
} satisfies Command

export default samples
