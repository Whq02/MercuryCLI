import { useCallback, useState } from 'react'
import { useSetAppState } from '../../state/AppState.js'
import type { ToolUseConfirm } from './PermissionRequest.js'
import { useOptionAmendments } from './useOptionAmendments.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const AMENDABLE = ['yes', 'no'] as const

type ShellCardArgs = { toolUseConfirm: ToolUseConfirm; onDone: () => void; onReject: () => void }

export function useShellPermissionFeedback(arg0: ShellCardArgs): Unbuilt {
  return notBuilt('src/components/permissions/useShellPermissionFeedback.ts:10')
}
