import type { Command } from '../../commands.js'

// /team — the discoverable deep link into the canonical Team Center
// The BackgroundTasksDialog IS the team surface —
// teammate rows with real lifecycle phases, inspect (↵), message/follow-up
// (m), foreground (f), stop (x) — so /team routes there rather than growing
// a competing dashboard. Bare /team = the roster list; /team <taskId> drills
// into one member's detail card (same grammar as /tasks).
const team = {
  type: 'local-jsx',
  name: 'team',
  description: 'Team Center — your teammates, their phases, and handoffs',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('../tasks/tasks.js'),
} satisfies Command

export default team
