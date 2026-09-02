import type { Command } from '../../commands.js'

// /monitor — the fullscreen, arrow-navigable fleet command-center on the
// NavigablePanes master-detail framework. Honest data only (missions / agents /
// leases from the live fleet snapshot). A NEW surface alongside /fleet; the
// fullscreen NavigablePanes path is stamp-gated; accessible read-only (honest off-state when no team).
const monitor = {
  type: 'local-jsx',
  immediate: true,
  name: 'monitor',
  needsConcourse: true,
  description:
    'Fullscreen navigable fleet monitor — missions, agents, leases (master-detail, drill-in)',
  // Accessible whenever Mercury is on; MonitorView shows the honest 'not in a
  // team' off-state when there's no fleet (read-only surface, like /parity).
  isEnabled: () => true,
  load: () => import('./monitor.js'),
} satisfies Command

export default monitor
