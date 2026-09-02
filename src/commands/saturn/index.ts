import type { Command } from '../../commands.js'

// /saturn — the scheduler screen (the operator's fork-v word: "/ becomes
// /saturn"). The scheduler screen's board over the session records' own schedule
// facts + the box tier, mounted in-chat at a bounded height; the Boot
// face's row opens the same component as a face layer. The old estate's
// door and every alias died with the rename — no compat spellings.
const command = {
  type: 'local-jsx',
  name: 'saturn',
  description: 'Schedules — next fire · held fires · pause/run-now (Saturn)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./saturn.js'),
} satisfies Command

export default command
