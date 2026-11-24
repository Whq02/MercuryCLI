import { featureReached } from '../../platform/substrate/featureReached.js'
import { ReadStream } from 'node:tty'
import { useContext, useRef } from 'react'
import { useClaim, useLayoutClaim, usePublish } from '../../screen/effects/effects.js'
import { useStdin } from '../../screen/themedRenderer.js'
import { ScreenInstanceContext } from '../../screen/renderer/elements/InkInstanceContext.js'
import { type InputEvent, markInputConsumedThroughCurrentSeq } from '../../screen/renderer/events/input-event.js'
import { trySeedComposer } from '../../screen/cockpit/composerSeed.js'
import type { ToolUseConfirm } from './PermissionRequest.js'
import { startImmediate } from '../../platform/async/timers.js'

export function usePermissionRequestLogging(toolUseConfirm: ToolUseConfirm, screen?: 'ChangeSetPermissionRequest' | 'MediaPermissionRequest'): void {
  const lastLoggedId = useRef<string | null>(null)

  usePublish(() => {
    if (lastLoggedId.current === toolUseConfirm.toolUseID) return
    lastLoggedId.current = toolUseConfirm.toolUseID
    if (screen) featureReached('screen', screen)
  }, [toolUseConfirm.toolUseID, screen])
}

export function useKeysHeldUntilFirstPaint(): void {
  const ink = useContext(ScreenInstanceContext)
  const { stdin, internal_eventEmitter } = useStdin()
  const painted = useRef(false)

  useLayoutClaim(() => {
    if (!ink) return undefined
    painted.current = false
    const typedAheadRead = (): void => {
      painted.current = true
    }
    const stop = ink.subscribeFrame(() => {
      stop()
      if (stdin instanceof ReadStream) startImmediate(() => startImmediate(typedAheadRead))
      else typedAheadRead()
    })
    ink.scheduleRender()
    return stop
  }, [ink, stdin])

  useClaim(() => {
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
