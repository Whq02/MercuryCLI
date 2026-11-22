import { featureReached } from '../../substrate/featureReached.js'
import { ReadStream } from 'node:tty'
import { useContext, useRef } from 'react'
import { useClaim, useLayoutClaim, usePublish } from '../../hooks/effects.js'
import { useStdin } from '../../ink.js'
import { InkInstanceContext } from '../../ink/components/InkInstanceContext.js'
import { type InputEvent, markInputConsumedThroughCurrentSeq } from '../../ink/events/input-event.js'
import { useSetAppState } from '../../state/AppState.js'
import { trySeedComposer } from '../../utils/cockpit/composerSeed.js'
import type { ToolUseConfirm } from './PermissionRequest.js'
import { startImmediate } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'

export function usePermissionRequestLogging(toolUseConfirm: ToolUseConfirm, screen?: 'ChangeSetPermissionRequest' | 'MediaPermissionRequest'): void {
  return notBuilt('src/components/permissions/hooks.ts:13')
}

export function useKeysHeldUntilFirstPaint(): void {
  const ink = useContext(InkInstanceContext)
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
