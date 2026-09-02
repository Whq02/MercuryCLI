// A scroll viewport: an overflow-scroll outer element wrapping ONE
// grow-no-shrink content box. Scroll mutations BYPASS React — they mutate
// the element's scroll record, mark it dirty and reach the root's throttled
// scheduler directly through a microtask-coalesced request.

import React, {
  forwardRef,
  type PropsWithChildren,
  useCallback,
  useImperativeHandle,
  useReducer,
  useRef,
} from 'react'
import { markDirty, scheduleRenderFrom, type DOMElement } from '../dom.js'
import { markCommitStart } from '../reconciler.js'
import type { Styles } from '../styles.js'
import { markScrollActivity } from '../../bootstrap/state.js'
import { fluxMark } from '../../utils/flux/fluxProbe.js'

/** FLUX S6 observability: record the follow-intent BREAK (sticky true→false
 *  by user scroll) — probe-gated, off ⇒ no-op. The viewport-continuity law
 *  reads these marks at wheel time. */
function markUnstick(scroll: { stickyScroll?: boolean }): void {
  if (scroll.stickyScroll !== false) fluxMark('scroll:unstick')
}

export type ScrollBoxProps = PropsWithChildren<
  Omit<Styles, 'textWrap' | 'overflow' | 'overflowX' | 'overflowY'> & {
    readonly ref?: React.Ref<ScrollBoxHandle>
    /** Pin to the bottom as content grows. */
    readonly stickyScroll?: boolean
  }
>

export type ScrollBoxHandle = {
  /** Absolute scroll; clears stickiness, any pending delta and any anchor. */
  scrollTo: (y: number) => void
  /** One-shot anchor: the compose walk reads the element's FRESH top in the
   *  same layout pass that computes the content height. */
  scrollToElement: (el: DOMElement, offset?: number) => void
  /** Accumulates into the pending delta; the renderer drains it at a
   *  capped rate. Cancels an in-flight anchor seek. */
  scrollBy: (dy: number) => void
  /** Sets stickiness and forces a REACT render (stickiness is
   *  attribute-observed). */
  scrollToBottom: () => void
  getScrollTop: () => number
  /** The not-yet-drained delta — mount the union of committed and pending
   *  ranges, or drain frames find no children. */
  getPendingDelta: () => number
  /** Cached content height from the last compose. */
  getScrollHeight: () => number
  /** Read straight from the content box's layout node (for a layout effect
   *  after a commit that grew content). */
  getFreshScrollHeight: () => number
  getViewportHeight: () => number
  /** Absolute screen row of the first visible content line inside padding. */
  getViewportTop: () => number
  /** The stable "at bottom" signal that does not depend on layout values. */
  isSticky: () => boolean
  /** Fires for IMPERATIVE changes only — not for sticky updates the renderer
   *  performs during its own render phase. */
  subscribe: (listener: () => void) => () => void
  /** The render-time clamp span (the mounted children's coverage);
   *  undefined disables the clamp. */
  setClampBounds: (min: number | undefined, max: number | undefined) => void
  /** Silent position write for a render-phase owner keeping the viewport on
   *  the same content while its coordinate space rebuilds: no notify (the
   *  writer IS the render that pairs this value with the frame), no pending
   *  or stickiness mutation. */
  pinScrollTop: (y: number) => void
}

const ScrollBox = forwardRef<ScrollBoxHandle, ScrollBoxProps>(function ScrollBox(
  { children, stickyScroll, ...style },
  ref,
) {
  const nodeRef = useRef<DOMElement | null>(null)
  const contentRef = useRef<DOMElement | null>(null)
  const listeners = useRef(new Set<() => void>())
  const renderQueued = useRef(false)

  const notify = (): void => {
    for (const listener of listeners.current) listener()
  }

  // The DOM-mutation path: dirty, coalesced scheduler request, background
  // intervals told to skip, commit-start mark, subscribers notified.
  const mutate = (): void => {
    const node = nodeRef.current
    if (!node) return
    markDirty(node)
    if (!renderQueued.current) {
      renderQueued.current = true
      queueMicrotask(() => {
        renderQueued.current = false
        scheduleRenderFrom(nodeRef.current ?? undefined)
      })
    }
    markScrollActivity()
    markCommitStart()
    notify()
  }

  // Stickiness is attribute-observed, so scroll-to-bottom needs a React
  // render — the dispatch identity is stable, so the empty-deps handle may
  // close over it.
  const [, forceRender] = useReducer((n: number) => n + 1, 0)

  useImperativeHandle(
    ref,
    (): ScrollBoxHandle => ({
      scrollTo(y) {
        const node = nodeRef.current
        if (!node) return
        const scroll = (node.scroll ??= {})
        markUnstick(scroll)
        scroll.stickyScroll = false
        scroll.pendingScrollDelta = undefined
        scroll.scrollAnchor = undefined
        scroll.scrollTop = Math.max(0, Math.floor(y))
        mutate()
      },
      scrollToElement(el, offset = 0) {
        const node = nodeRef.current
        if (!node) return
        const scroll = (node.scroll ??= {})
        markUnstick(scroll)
        scroll.stickyScroll = false
        scroll.pendingScrollDelta = undefined
        scroll.scrollAnchor = { el, offset }
        mutate()
      },
      scrollBy(dy) {
        const node = nodeRef.current
        if (!node) return
        const scroll = (node.scroll ??= {})
        markUnstick(scroll)
        scroll.stickyScroll = false
        scroll.scrollAnchor = undefined
        scroll.pendingScrollDelta = (scroll.pendingScrollDelta ?? 0) + Math.floor(dy)
        mutate()
      },
      scrollToBottom() {
        const node = nodeRef.current
        if (!node) return
        const scroll = (node.scroll ??= {})
        scroll.pendingScrollDelta = undefined
        scroll.stickyScroll = true
        markDirty(node)
        notify()
        forceRender()
      },
      getScrollTop: () => nodeRef.current?.scroll?.scrollTop ?? 0,
      getPendingDelta: () => nodeRef.current?.scroll?.pendingScrollDelta ?? 0,
      getScrollHeight: () => nodeRef.current?.scroll?.scrollHeight ?? 0,
      getFreshScrollHeight: () => {
        const layout = contentRef.current?.layoutNode
        return layout ? Math.ceil(layout.getComputedHeight()) : 0
      },
      getViewportHeight: () => nodeRef.current?.scroll?.scrollViewportHeight ?? 0,
      getViewportTop: () => nodeRef.current?.scroll?.scrollViewportTop ?? 0,
      isSticky: () => {
        const node = nodeRef.current
        if (!node) return false
        return node.scroll?.stickyScroll ?? Boolean(node.attributes['stickyScroll'])
      },
      subscribe(listener) {
        listeners.current.add(listener)
        return () => {
          listeners.current.delete(listener)
        }
      },
      setClampBounds(min, max) {
        const node = nodeRef.current
        if (!node) return
        const scroll = (node.scroll ??= {})
        scroll.scrollClampMin = min
        scroll.scrollClampMax = max
      },
      pinScrollTop(y) {
        const node = nodeRef.current
        if (!node) return
        const scroll = (node.scroll ??= {})
        scroll.scrollTop = Math.max(0, Math.floor(y))
        markDirty(node)
        markScrollActivity()
      },
    }),
    // Empty by design: the closures capture only refs and imports, and
    // rebuilding would re-register the ref every render.
    [],
  )

  const attachNode = useCallback((node: DOMElement | null) => {
    nodeRef.current = node
    if (node) {
      const scroll = (node.scroll ??= {})
      if (scroll.scrollTop === undefined) scroll.scrollTop = 0
    }
  }, [])

  const attachContent = useCallback((node: DOMElement | null) => {
    contentRef.current = node
  }, [])

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
      ref={attachNode}
      style={outerStyle}
      {...(stickyScroll ? { stickyScroll: true } : {})}
    >
      <ink-box
        ref={attachContent}
        style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' }}
      >
        {children}
      </ink-box>
    </ink-box>
  )
})

export default ScrollBox
