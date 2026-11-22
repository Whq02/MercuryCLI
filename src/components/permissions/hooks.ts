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
  return notBuilt('src/components/permissions/hooks.ts:30')
}
