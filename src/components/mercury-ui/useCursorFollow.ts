import { useCallback, useContext, useRef } from 'react'
import { useSubscription, useTimer } from '../../hooks/effects.js'
import type { RefObject } from 'react'
import CursorDeclarationContext, { type CursorDeclaration, type CursorDeclarationSetter } from '../../ink/components/CursorDeclarationContext.js'
import { InkInstanceContext } from '../../ink/components/InkInstanceContext.js'
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { startTimeout, stopTimeout } from '../../utils/timers.js'
import { notBuilt } from '../../pi/holes.js'

export function useCursorFollow(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  viewport: { rows: number; width: number },
  options?: { restOnClear?: boolean },
): CursorDeclarationSetter {
  return notBuilt('src/components/mercury-ui/useCursorFollow.ts:9')
}
