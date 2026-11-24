import type { BackgroundTaskState } from './taskState.js'
import { plural } from '../../platform/text/strings.js'
import { DIAMOND_OPEN } from '../../screen/theme/rowGlyphs.js'

export function getPillLabel(tasks: BackgroundTaskState[]): string {
  const firstType: string | undefined = tasks[0]?.type
  if (!firstType || !tasks.every(task => task.type === firstType)) {
    return `${tasks.length} ${plural(tasks.length, 'background task')}`
  }

  switch (firstType) {
    case 'local_bash': {
      let monitors = 0
      for (const task of tasks) {
        if (task.type === 'local_bash' && task.kind === 'monitor') {
          monitors++
        }
      }
      const shells = tasks.length - monitors
      const parts: string[] = []
      if (shells > 0) parts.push(`${shells} ${plural(shells, 'background command')}`)
      if (monitors > 0) parts.push(`${monitors} ${plural(monitors, 'monitor')}`)
      return parts.join(', ')
    }
    case 'local_agent':
      return `${tasks.length} ${plural(tasks.length, 'local crewmate')}`
    case 'remote_agent':
      return `${DIAMOND_OPEN} ${tasks.length} ${plural(tasks.length, 'cloud session')}`
    case 'monitor_mcp':
      return `${tasks.length} ${plural(tasks.length, 'monitor')}`
    default:
      return `${tasks.length} ${plural(tasks.length, 'background task')}`
  }
}
