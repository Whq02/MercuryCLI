import { useRef, useSyncExternalStore } from 'react'
import { useLoad } from '../effects/effects.js'
import { currentSurfaceRoute, subscribeSurfaceRoute, surfaceRouteVersion } from '../routes/surfaceRoute.js'
import type { AppState } from '../app-state/AppState.js'
import { enterCrewmateView, exitCrewmateView } from '../../crew/crewmates/crewmateView.js'
import {
  consumeCommandDispatch,
  consumeHelmActivation,
  getHelmVersion,
  setHelmFocus,
  subscribeHelmFocus,
} from '../cockpit/helmFocus.js'
import { openFilesMenu } from '../cockpit/filesMenu.js'
import type { ComposerSubmit } from './useComposerSubmit.js'

export function useComposerHelm({
  submit,
  setAppState,
}: {
  submit: ComposerSubmit
  setAppState: (f: (prev: AppState) => AppState) => void
}) {
  const helmVersion = useSyncExternalStore(
    subscribeHelmFocus,
    getHelmVersion,
    getHelmVersion,
  )
  const routeVersion = useSyncExternalStore(
    subscribeSurfaceRoute,
    surfaceRouteVersion,
    surfaceRouteVersion,
  )
  void routeVersion
  const surfaceCovered = currentSurfaceRoute().kind !== 'repl'
  const submitRef = useRef(submit)
  submitRef.current = submit
  useLoad(() => {
    const activation = consumeHelmActivation()
    const dispatch = consumeCommandDispatch()
    if (activation !== null) {
      switch (activation.type) {
        case 'crewmate':
          enterCrewmateView(activation.id, setAppState)
          setHelmFocus('prompt')
          break
        case 'main':
          exitCrewmateView(setAppState)
          setHelmFocus('prompt')
          break
        case 'command':
          setHelmFocus('prompt')
          void submitRef.current(activation.command, { fromKeybinding: true })
          break
        case 'files':
          setHelmFocus('prompt')
          openFilesMenu()
          break
      }
    }
    if (dispatch !== null) {
      void submitRef.current(dispatch, { fromKeybinding: true })
    }
  }, [helmVersion])
  return { surfaceCovered, submitRef }
}
