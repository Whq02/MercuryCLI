import type { ReactNode } from 'react'
import { Text } from '../themedRenderer.js'
import { useAppState, type AppState } from '../app-state/AppState.js'
import { getPillLabel } from '../../engine/tasks/pillLabel.js'
import { InteractiveRow } from '../widgets/InteractiveRow.js'
import { isManageableTask } from './taskStatus.js'

export function BackgroundTaskStatus({ tasksSelected, onOpenDialog }: { tasksSelected: boolean; onOpenDialog?: () => void }): ReactNode {
  const tasks = useAppState((state: AppState) => state.tasks)
  const manageable = Object.values(tasks ?? {}).filter(isManageableTask)
  if (manageable.length === 0) return null

  const label = getPillLabel(manageable)
  const body = (highlighted: boolean): ReactNode => (
    <Text wrap="truncate-end">
      <Text color="background" inverse={highlighted} dimColor={!highlighted}>
        {label}
      </Text>
    </Text>
  )
  if (!onOpenDialog) return body(false)

  return (
    <InteractiveRow
      id="footer:tasks:pill:summary"
      selected={tasksSelected}
      directActivate={true}
      onActivate={onOpenDialog}
    >
      {(hover: boolean) => body(tasksSelected || hover)}
    </InteractiveRow>
  )
}
