import { ReadStream } from 'node:tty'
import { useContext, useEffect, useLayoutEffect, useRef } from 'react'
import { InkInstanceContext } from '../../ink/components/InkInstanceContext.js'
import { type InputEvent, markInputConsumedThroughCurrentSeq } from '../../ink/events/input-event.js'
import useStdin from '../../ink/hooks/use-stdin.js'
import { useSetAppState } from '../../state/AppState.js'
import { trySeedComposer } from '../../utils/cockpit/composerSeed.js'
import type { ToolUseConfirm } from './PermissionRequest.js'

export function usePermissionRequestLogging(toolUseConfirm: ToolUseConfirm): void {
  const setAppState = useSetAppState()
  const loggedToolUseId = useRef<string | null>(null)
  useEffect(() => {
    if (loggedToolUseId.current === toolUseConfirm.toolUseID) return
    loggedToolUseId.current = toolUseConfirm.toolUseID
    setAppState(prev => ({
      ...prev,
      attribution: {
        ...prev.attribution,
        permissionPromptCount: prev.attribution.permissionPromptCount + 1,
      },
    }))
  }, [toolUseConfirm, setAppState])
}

export function useKeysHeldUntilFirstPaint(): void {
  const ink = useContext(InkInstanceContext)
  const { stdin, internal_eventEmitter } = useStdin()
  const painted = useRef(false)

  useLayoutEffect(() => {
    if (!ink) return undefined
    painted.current = false
    const typedAheadRead = (): void => {
      painted.current = true
    }
    const stop = ink.subscribeFrame(() => {
      stop()
      if (stdin instanceof ReadStream) setImmediate(() => setImmediate(typedAheadRead))
      else typedAheadRead()
    })
    ink.scheduleRender()
    return stop
  }, [ink, stdin])

  useEffect(() => {
    if (!ink) return undefined
    const hold = (event: InputEvent): void => {
      if (painted.current) return
      const { input, key } = event
      if (key.escape || key.ctrl || event.wheelStep) return
      if (trySeedComposer(input, key)) event.stopImmediatePropagation()
      else markInputConsumedThroughCurrentSeq()
    }
    internal_eventEmitter.prependListener('input', hold)
    return () => {
      internal_eventEmitter.removeListener('input', hold)
    }
  }, [ink, internal_eventEmitter])
}
