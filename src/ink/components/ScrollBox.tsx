
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

function markUnstick(scroll: { stickyScroll?: boolean }): void {
  if (scroll.stickyScroll !== false) fluxMark('scroll:unstick')
}

export type ScrollBoxProps = PropsWithChildren<
  Omit<Styles, 'textWrap' | 'overflow' | 'overflowX' | 'overflowY'> & {
    readonly ref?: React.Ref<ScrollBoxHandle>
    readonly stickyScroll?: boolean
  }
>

export type ScrollBoxHandle = {
  scrollTo: (y: number) => void
  scrollToElement: (el: DOMElement, offset?: number) => void
  scrollBy: (dy: number) => void
  scrollToBottom: () => void
  getScrollTop: () => number
  getPendingDelta: () => number
  getScrollHeight: () => number
  getFreshScrollHeight: () => number
  getViewportHeight: () => number
  getViewportTop: () => number
  isSticky: () => boolean
  subscribe: (listener: () => void) => () => void
  setClampBounds: (min: number | undefined, max: number | undefined) => void
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
