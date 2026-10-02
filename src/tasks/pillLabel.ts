import { plural } from '../utils/stringUtils.js'
import type { BackgroundTaskState } from './types.js'


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
    case 'in_process_crewmate': {
      const crews = new Set(
        tasks.map(task => (task as { identity?: { crewName?: string } }).identity?.crewName),
      ).size
      return `${crews} ${plural(crews, 'crew')}`
    }
    case 'local_agent':
      return `${tasks.length} local ${plural(tasks.length, 'agent')}`
    case 'remote_agent':
      return `${DIAMOND_OPEN} ${tasks.length} cloud ${plural(tasks.length, 'session')}`
    case 'local_workflow':
      return `${tasks.length} background ${plural(tasks.length, 'workflow')}`
    case 'monitor_mcp':
      return `${tasks.length} ${plural(tasks.length, 'monitor')}`
    default:
      return `${tasks.length} background ${plural(tasks.length, 'task')}`
  }
}
