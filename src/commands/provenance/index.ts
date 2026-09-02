import type { Command } from '../../commands.js'

const provenance = {
  type: 'local-jsx',
  immediate: true,
  name: 'provenance',
  description:
    'Show the system-prompt bill of materials — what the harness actually assembled, with sizes',
  // True-capture transparency surface; the recorder only runs on Mercury, so
  // the panel is stamp-only too (mirrors /substrate's gate).
  isEnabled: () => true,
  load: () => import('./provenance.js'),
} satisfies Command

export default provenance
