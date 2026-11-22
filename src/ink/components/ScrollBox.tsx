import React, {
  forwardRef,
  type PropsWithChildren,
  useCallback,
  useContext,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
} from 'react'
import { useClaim } from '../../hooks/effects.js'
import { WHEEL_ROWS_PER_NOTCH } from '../../components/mercury-ui/composerFloor.js'
import { markDirty, scheduleRenderFrom, type DOMElement } from '../dom.js'
import { LayoutEdge } from '../layout/node.js'
import { markCommitStart } from '../reconciler.js'
import type { Styles } from '../styles.js'
import { markScrollActivity } from '../../bootstrap/state.js'
import { fluxMark } from '../../utils/flux/fluxProbe.js'
import useStdin from '../hooks/use-stdin.js'
import type { InputEvent } from '../events/input-event.js'
import { elevatedSurfaceOwnsNode } from '../recessLayer.js'
import { InkInstanceContext } from './InkInstanceContext.js'
import { startMicrotask } from '../../utils/timers.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

function markUnstick(scroll: { stickyScroll?: boolean }): void {
  if (scroll.stickyScroll !== false) fluxMark('scroll:unstick')
}

export type ScrollBoxProps = PropsWithChildren<
  Omit<Styles, 'textWrap' | 'overflow' | 'overflowX' | 'overflowY'> & {
    readonly ref?: React.Ref<ScrollBoxHandle>
    readonly stickyScroll?: boolean
    readonly restsAtTop?: boolean
  }
>

export type ScrollBoxHandle = Unbuilt

const ScrollBox: Unbuilt = unbuilt('src/ink/components/ScrollBox.tsx:58')

export default ScrollBox
