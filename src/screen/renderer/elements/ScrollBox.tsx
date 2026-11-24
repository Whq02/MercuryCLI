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
import { useClaim } from '../../effects/effects.js'
import { WHEEL_ROWS_PER_NOTCH } from '../../widgets/composerFloor.js'
import { markDirty, scheduleRenderFrom, type DOMElement } from '../dom.js'
import { LayoutEdge } from '../layout/node.js'
import { markCommitStart } from '../reconciler.js'
import type { Styles } from '../styles.js'
import { markScrollActivity } from '../../../boot/process-state/processState.js'
import { fluxMark } from '../../../integrations/media-flux/fluxProbe.js'
import useStdin from '../bindings/use-stdin.js'
import type { InputEvent } from '../events/input-event.js'
import { elevatedSurfaceOwnsNode } from '../recessLayer.js'
import { ScreenInstanceContext } from './InkInstanceContext.js'
import { startMicrotask } from '../../../platform/async/timers.js'

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

export type ScrollBoxHandle = {
  scrollTo: (y: number) => void
  scrollToElement: (el: DOMElement, offset?: number) => void
  scrollBy: (dy: number) => void
  scrollToBottom: () => void
  setClampBounds: (min: number | undefined, max: number | undefined) => void
  pinScrollTop: (y: number) => void
  getScrollTop: () => number
  getPendingDelta: () => number
  getScrollHeight: () => number
  getFreshScrollHeight: () => number
  getViewportHeight: () => number
  getFreshViewportHeight: () => number
  getViewportTop: () => number
  getElementTop: (el: DOMElement) => number | undefined
  isSticky: () => boolean
  subscribe: (listener: () => void) => () => void
  subscribeLayout: (listener: () => void) => () => void
}

const INNER_STYLE: Styles = {
  flexDirection: 'column',
  width: '100%',
  flexGrow: 1,
  flexShrink: 0,
}

const ScrollBox = forwardRef<ScrollBoxHandle, Omit<ScrollBoxProps, 'ref'>>(
  function ScrollBox({ children, stickyScroll, restsAtTop, ...style }, ref) {
    const outerRef = useRef<DOMElement | null>(null)
    const innerRef = useRef<DOMElement | null>(null)
    const listenersRef = useRef(new Set<() => void>())
    const renderQueuedRef = useRef(false)
    const restsAtTopRef = useRef(restsAtTop)
    restsAtTopRef.current = restsAtTop
    const instance = useContext(ScreenInstanceContext)
    const instanceRef = useRef(instance)
    instanceRef.current = instance
    const [, forceRender] = useReducer((n: number) => n + 1, 0)
    const { internal_eventEmitter } = useStdin()

    if (restsAtTop && outerRef.current) {
      const scroll = (outerRef.current.scroll ??= {})
      if (scroll.lastStableAtBottom === undefined) {
        scroll.lastStableAtBottom = false
      }
    }

    const setOuterRef = useCallback((node: DOMElement | null) => {
      outerRef.current = node
      if (!node) return
      const scroll = (node.scroll ??= {})
      if (scroll.scrollTop === undefined) {
        scroll.scrollTop = 0
      }
      if (restsAtTopRef.current && scroll.lastStableAtBottom === undefined) {
        scroll.lastStableAtBottom = false
      }
    }, [])

    const handle = useMemo<ScrollBoxHandle>(() => {
      const notify = (): void => {
        for (const listener of listenersRef.current) {
          listener()
        }
      }

      const commitNormal = (node: DOMElement): void => {
        markDirty(node)
        if (!renderQueuedRef.current) {
          renderQueuedRef.current = true
          startMicrotask(() => {
            renderQueuedRef.current = false
            const current = outerRef.current
            if (current) scheduleRenderFrom(current)
          })
        }
        markScrollActivity()
        markCommitStart()
        notify()
      }

      return {
        scrollTo(y: number) {
          const node = outerRef.current
          if (!node) return
          const scroll = (node.scroll ??= {})
          markUnstick(scroll)
          scroll.scrollTop = Math.max(0, Math.floor(y))
          scroll.stickyScroll = false
          scroll.pendingScrollDelta = 0
          scroll.scrollAnchor = undefined
          commitNormal(node)
        },
        scrollToElement(el: DOMElement, offset = 0) {
          const node = outerRef.current
          if (!node) return
          const scroll = (node.scroll ??= {})
          markUnstick(scroll)
          scroll.stickyScroll = false
          scroll.pendingScrollDelta = 0
          scroll.scrollAnchor = { el, offset }
          commitNormal(node)
        },
        scrollBy(dy: number) {
          const node = outerRef.current
          if (!node) return
          const scroll = (node.scroll ??= {})
          markUnstick(scroll)
          scroll.stickyScroll = false
          scroll.scrollAnchor = undefined
          scroll.pendingScrollDelta = (scroll.pendingScrollDelta ?? 0) + Math.floor(dy)
          commitNormal(node)
        },
        scrollToBottom() {
          const node = outerRef.current
          if (!node) return
          const scroll = (node.scroll ??= {})
          scroll.pendingScrollDelta = 0
          scroll.stickyScroll = true
          markDirty(node)
          notify()
          forceRender()
        },
        setClampBounds(min: number | undefined, max: number | undefined) {
          const node = outerRef.current
          if (!node) return
          const scroll = (node.scroll ??= {})
          scroll.scrollClampMin = min
          scroll.scrollClampMax = max
        },
        pinScrollTop(y: number) {
          const node = outerRef.current
          if (!node) return
          const scroll = (node.scroll ??= {})
          scroll.scrollTop = Math.max(0, Math.floor(y))
          markDirty(node)
          markScrollActivity()
        },
        getScrollTop() {
          return outerRef.current?.scroll?.scrollTop ?? 0
        },
        getPendingDelta() {
          return outerRef.current?.scroll?.pendingScrollDelta ?? 0
        },
        getScrollHeight() {
          return outerRef.current?.scroll?.scrollHeight ?? 0
        },
        getFreshScrollHeight() {
          const layout = innerRef.current?.layoutNode
          if (!layout) return 0
          const height = layout.getComputedHeight()
          return Number.isFinite(height) ? Math.ceil(height) : 0
        },
        getViewportHeight() {
          return outerRef.current?.scroll?.scrollViewportHeight ?? 0
        },
        getFreshViewportHeight() {
          const node = outerRef.current
          const layout = node?.layoutNode
          if (!layout) return node?.scroll?.scrollViewportHeight ?? 0
          const height = layout.getComputedHeight()
          if (!Number.isFinite(height)) return node?.scroll?.scrollViewportHeight ?? 0
          const padTop = layout.getComputedPadding(LayoutEdge.Top) || 0
          const padBottom = layout.getComputedPadding(LayoutEdge.Bottom) || 0
          return Math.max(0, Math.floor(height) - padTop - padBottom)
        },
        getViewportTop() {
          return outerRef.current?.scroll?.scrollViewportTop ?? 0
        },
        getElementTop(el: DOMElement) {
          const root = innerRef.current
          if (!root) return undefined
          let top = 0
          let current: DOMElement | undefined = el
          while (current && current !== root) {
            const layout = current.layoutNode
            if (!layout) return undefined
            const y = layout.getComputedTop()
            if (!Number.isFinite(y)) return undefined
            top += y
            current = current.parentNode
          }
          return current === root ? top : undefined
        },
        isSticky() {
          const node = outerRef.current
          if (!node) return false
          if (node.scroll?.stickyScroll !== undefined) return node.scroll.stickyScroll
          return Boolean(node.attributes['stickyScroll'])
        },
        subscribe(listener: () => void) {
          listenersRef.current.add(listener)
          return () => {
            listenersRef.current.delete(listener)
          }
        },
        subscribeLayout(listener: () => void) {
          const current = instanceRef.current
          if (!current) return () => {}
          return current.subscribeLayout(listener)
        },
      }
    }, [])

    useImperativeHandle(ref, () => handle, [handle])

    useClaim(() => {
      const onWheel = (event: InputEvent): void => {
        const node = outerRef.current
        if (!node || !elevatedSurfaceOwnsNode(node)) return
        const viewport = node.scroll?.scrollViewportHeight ?? 0
        const content = node.scroll?.scrollHeight ?? 0
        if (viewport <= 0 || viewport >= content) return
        event.stopImmediatePropagation()
        handle.scrollBy(event.key.wheelUp ? -WHEEL_ROWS_PER_NOTCH : WHEEL_ROWS_PER_NOTCH)
      }
      internal_eventEmitter.on('wheel', onWheel)
      return () => {
        internal_eventEmitter.off('wheel', onWheel)
      }
    }, [internal_eventEmitter, handle])

    const outerStyle: Styles = {
      ...style,
      flexWrap: 'nowrap',
      flexDirection: style.flexDirection ?? 'row',
      flexGrow: style.flexGrow ?? 0,
      flexShrink: style.flexShrink ?? 1,
      overflowX: 'scroll',
      overflowY: 'scroll',
    }

    return (
      <ink-box
        ref={setOuterRef}
        style={outerStyle}
        {...(stickyScroll ? { stickyScroll: true } : {})}
      >
        <ink-box ref={innerRef} style={INNER_STYLE}>
          {children}
        </ink-box>
      </ink-box>
    )
  },
)

export default ScrollBox
