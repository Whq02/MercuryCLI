import { useRef } from 'react'
import type { AppState } from '../app-state/AppState.js'
import { isCrewmateTask } from '../../engine/tasks/local-agent/crewmateTask.js'
import { useComposerCrewmate, useViewedCrewmate } from '../tasks/useCrewmateView.js'

export function useComposerCrewmateRefs(viewedTask: AppState['tasks'][string] | undefined) {
  const composerCrewmate = useComposerCrewmate()
  const composerCrewmateRef = useRef(composerCrewmate)
  composerCrewmateRef.current = composerCrewmate
  const viewedCrewmate = useViewedCrewmate()
  const viewedCrewmateRef = useRef(viewedCrewmate)
  viewedCrewmateRef.current = viewedCrewmate
  const commandCrewmate = viewedCrewmate ?? composerCrewmate
  const commandCrewmateRef = useRef(commandCrewmate)
  commandCrewmateRef.current = commandCrewmate
  const viewedCrewmateName =
    composerCrewmate?.name ??
    (viewedTask !== undefined && isCrewmateTask(viewedTask)
      ? viewedTask.description !== ''
        ? viewedTask.description
        : viewedTask.agentType
      : undefined)
  return { composerCrewmateRef, viewedCrewmateRef, commandCrewmateRef, viewedCrewmateName }
}
