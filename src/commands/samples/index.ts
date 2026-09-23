import type { Command } from '../../commands.js'
import { samplesEnabled } from '../../services/samples/contracts.js'

export const SAMPLES_OFF_SENTENCE =
  "/samples is off — MERCURY_SAMPLES=1 turns it on (the Boot Menu's Samples row saves it for new sessions)"

const samples = {
  type: 'local-jsx',
  name: 'samples',
  immediate: true,
  description: 'Samples — the pages the model drew for you in this session; Enter opens one in your browser',
  isEnabled: () => samplesEnabled(),
  load: () => import('./samples.js'),
} satisfies Command

export default samples
