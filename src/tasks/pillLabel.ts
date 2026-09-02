import { plural } from '../utils/stringUtils.js'
import type { BackgroundTaskState } from './types.js'

/**
 * The compact background-task pill label, shared by the footer pill and the
 * turn-duration transcript line so the two surfaces can never disagree.
 *
 * Precondition: a non-empty array — the all-one-kind test reads the first
 * element's kind; every caller filters first.
 */

/**
 * Remote-agent states are harness-delivered; no module in this tree
 * produces them. The two members read here are contract data with that
 * external producer (see the task-union notes in tasks/types.ts).
 */
type RemoteAgentFields = {
  isUltraplan?: boolean
  ultraplanPhase?: string
}

const DIAMOND_FILLED = '◆'
const DIAMOND_OPEN = '◇'

export function getPillLabel(tasks: BackgroundTaskState[]): string {
  const firstKind = (tasks[0] as { type: string }).type
  const allOneKind = tasks.every(task => (task as { type: string }).type === firstKind)
  if (!allOneKind) {
    return `${tasks.length} background ${plural(tasks.length, 'task')}`
  }
  switch (firstKind) {
    case 'local_bash': {
      const monitors = tasks.filter(task => (task as { kind?: string }).kind === 'monitor').length
      const shells = tasks.length - monitors
      const parts: string[] = []
      if (shells > 0) parts.push(`${shells} background ${plural(shells, 'command')}`)
      if (monitors > 0) parts.push(`${monitors} ${plural(monitors, 'monitor')}`)
      return parts.join(', ')
    }
    case 'in_process_teammate': {
      const teams = new Set(
        tasks.map(task => (task as { identity?: { teamName?: string } }).identity?.teamName),
      ).size
      return `${teams} ${plural(teams, 'team')}`
    }
    case 'local_agent':
      return `${tasks.length} local ${plural(tasks.length, 'agent')}`
    case 'remote_agent': {
      if (tasks.length === 1) {
        const remote = tasks[0] as RemoteAgentFields
        if (remote.isUltraplan) {
          switch (remote.ultraplanPhase) {
            case 'plan_ready':
              return `${DIAMOND_FILLED} plan ready`
            case 'needs_input':
              return `${DIAMOND_OPEN} needs your input`
            default:
              return `${DIAMOND_OPEN} ultraplan`
          }
        }
      }
      return `${DIAMOND_OPEN} ${tasks.length} cloud ${plural(tasks.length, 'session')}`
    }
    case 'local_workflow':
      return `${tasks.length} background ${plural(tasks.length, 'workflow')}`
    case 'monitor_mcp':
      return `${tasks.length} ${plural(tasks.length, 'monitor')}`
    case 'dream':
      return 'dreaming'
    default:
      return `${tasks.length} background ${plural(tasks.length, 'task')}`
  }
}

/**
 * Whether the pill shows the dimmed open-the-task-view affordance: only a
 * single remote-agent ultra-plan task with a defined phase does.
 */
export function pillNeedsCta(tasks: BackgroundTaskState[]): boolean {
  if (tasks.length !== 1) return false
  const task = tasks[0] as { type?: string } & RemoteAgentFields
  return (
    task.type === 'remote_agent' &&
    task.isUltraplan === true &&
    task.ultraplanPhase !== undefined
  )
}
