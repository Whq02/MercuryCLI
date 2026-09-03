import type { Command } from '../../commands.js'

// /team — the discoverable deep link into the crew board on /tasks.
// The BackgroundTasksDialog IS that board — named-agent rows with real
// lifecycle phases, inspect (↵), message/follow-up (m), foreground (f),
// stop (x) — so /team routes there rather than growing a competing
// dashboard. Bare /team = the roster list; /team <taskId> drills into one
// agent's detail card (same grammar as /tasks).
const team = {
  type: 'local-jsx',
  name: 'team',
  description: 'Crew board — the named agents, their phases and handoffs (on /tasks)',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../tasks/tasks.js'),
} satisfies Command

export default team
