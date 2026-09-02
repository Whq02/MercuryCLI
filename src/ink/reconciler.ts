// The react-reconciler host config: prop/tree/text/visibility/commit/
// priority planes plus commit instrumentation. Two exemptions are
// load-bearing for performance: `children` never lands as an attribute, and
// event-handler props live in the node's separate handler map — React
// allocates fresh identities every render, and an attribute write would
// dirty every node every frame and defeat the clean-subtree blit.

import { appendFileSync } from 'node:fs'
import { createContext } from 'react'
import createReconciler from 'react-reconciler'
import {
  DefaultEventPriority,
  DiscreteEventPriority,
  NoEventPriority,
} from 'react-reconciler/constants.js'
import {
  appendChildNode,
  clearLayoutNodeReferences,
  createNode,
  createTextNode,
  insertBeforeNode,
  markDirty,
  removeChildNode,
  setAttribute,
  setStyle,
  setTextNodeValue,
  setTextStyles,
  type DOMElement,
  type DOMNode,
  type DOMNodeAttribute,
  type ElementNames,
  type TextNode,
} from './dom.js'
import { EVENT_HANDLER_PROPS } from './events/event-handlers.js'
import { Dispatcher } from './events/dispatcher.js'
import applyStyles, { type Styles, type TextStyles } from './styles.js'

/** The shared event dispatcher singleton. */
export const dispatcher = new Dispatcher()

// ── Profiling counters (read once per frame by the frame loop) ────────────
let lastYogaMs = 0
let lastCommitMs = 0
let commitStartMark: number | null = null

export function recordLayoutMs(ms: number): void {
  lastYogaMs = ms
}
export function getLastYogaMs(): number {
  return lastYogaMs
}
export function markCommitStart(): void {
  commitStartMark = performance.now()
}
export function getLastCommitMs(): number {
  return lastCommitMs
}
export function resetProfileCounters(): void {
  lastYogaMs = 0
  lastCommitMs = 0
}

// ── Repaint debugging (owner-chain capture) ───────────────────────────────
// Always off: no debug-repaints knob is registered.
export function isDebugRepaintsEnabled(): boolean {
  return false
}

type FiberLike = {
  type?: unknown
  elementType?: unknown
  return?: FiberLike | null
  _debugOwner?: FiberLike | null
}

/** Component-name chain from a fiber handle: walk up preferring the debug
 *  owner link then the parent link, bounded to 50 steps, cycle-guarded,
 *  skipping host elements and collapsing immediate duplicates. */
export function getOwnerChain(fiber: unknown): string[] {
  const chain: string[] = []
  const seen = new Set<FiberLike>()
  let current = fiber as FiberLike | null | undefined
  for (let step = 0; step < 50 && current; step++) {
    if (seen.has(current)) break
    seen.add(current)
    const type = current.elementType ?? current.type
    if (typeof type === 'function') {
      const name =
        (type as { displayName?: string; name?: string }).displayName ??
        (type as { name?: string }).name
      if (name && chain[chain.length - 1] !== name) chain.push(name)
    }
    current = current._debugOwner ?? current.return
  }
  return chain
}

// ── Commit instrumentation (dormant: no registered knob arms it; the
// machinery stays for a future registered flag) ──────────────────────────
const COMMIT_LOG_PATH: string | undefined = undefined
let lastCommitEndMs = 0
let commitsThisSecond = 0
let maxGapThisSecond = 0
let secondWindowStart = 0
let instanceCreations = 0

function commitLog(line: string): void {
  if (!COMMIT_LOG_PATH) return
  try {
    appendFileSync(COMMIT_LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Instrumentation must never break rendering.
  }
}

function noteCommit(reconcileMs: number): void {
  if (!COMMIT_LOG_PATH) return
  const now = performance.now()
  const gap = lastCommitEndMs === 0 ? 0 : now - lastCommitEndMs
  lastCommitEndMs = now
  if (gap > 30 || reconcileMs > 20 || instanceCreations > 50) {
    commitLog(
      `commit gap=${gap.toFixed(1)}ms reconcile=${reconcileMs.toFixed(1)}ms creations=${instanceCreations}`,
    )
  }
  commitsThisSecond++
  if (gap > maxGapThisSecond) maxGapThisSecond = gap
  if (now - secondWindowStart >= 1000) {
    if (secondWindowStart !== 0) {
      commitLog(
        `second commits=${commitsThisSecond} maxGap=${maxGapThisSecond.toFixed(1)}ms`,
      )
    }
    secondWindowStart = now
    commitsThisSecond = 0
    maxGapThisSecond = 0
  }
}

export function noteSlowLayout(
  ms: number,
  counters: { visited: number; measured: number; cacheHits: number; live: number },
): void {
  if (!COMMIT_LOG_PATH || ms <= 20) return
  commitLog(
    `slow-layout ${ms.toFixed(1)}ms visited=${counters.visited} measured=${counters.measured} cacheHits=${counters.cacheHits} live=${counters.live}`,
  )
}

export function noteSlowPaint(ms: number): void {
  if (!COMMIT_LOG_PATH || ms <= 10) return
  commitLog(`slow-paint ${ms.toFixed(1)}ms`)
}

// ── The host config ───────────────────────────────────────────────────────

type Props = Record<string, unknown>
type HostContext = { isInsideText: boolean }

const OUTSIDE_TEXT: HostContext = { isInsideText: false }
const INSIDE_TEXT: HostContext = { isInsideText: true }

const TEXT_HOST_ELEMENTS = new Set(['ink-text', 'ink-virtual-text', 'ink-link'])

function applyProps(node: DOMElement, props: Props, initial: boolean): void {
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue
    if (key === 'style') {
      const style = (value ?? {}) as Styles
      setStyle(node, style)
      if (node.layoutNode) applyStyles(node.layoutNode, style, style)
      continue
    }
    if (key === 'textStyles') {
      if (initial) node.textStyles = value as TextStyles
      else setTextStyles(node, value as TextStyles)
      continue
    }
    if (EVENT_HANDLER_PROPS.has(key)) {
      ;(node._eventHandlers ??= {})[key] = value
      continue
    }
    setAttribute(node, key, value as DOMNodeAttribute)
  }
}

/** Key-level diff: removed keys surface as explicit undefined entries;
 *  changed keys compare by identity. */
function diffProps(oldProps: Props, newProps: Props): Props | null {
  let diff: Props | null = null
  for (const key of Object.keys(oldProps)) {
    if (key === 'children') continue
    if (!(key in newProps)) {
      ;(diff ??= {})[key] = undefined
    }
  }
  for (const [key, value] of Object.entries(newProps)) {
    if (key === 'children') continue
    if (oldProps[key] !== value) {
      ;(diff ??= {})[key] = value
    }
  }
  return diff
}

function detachInstance(node: DOMNode, root: DOMElement): void {
  if (node.nodeName === '#text') return
  const element = node as DOMElement
  // Order is part of the contract: unset the measure function, clear every
  // layout reference in the subtree, then free the layout subtree
  // recursively — no dangling reference into freed memory survives.
  const layout = element.layoutNode
  if (layout) {
    element.layoutNode?.unsetMeasureFunc()
    clearLayoutNodeReferences(element)
    layout.freeRecursive()
  }
  root.focusManager?.handleNodeRemoved(element, root)
}

function findRoot(node: DOMElement): DOMElement {
  let current: DOMElement = node
  while (current.parentNode) current = current.parentNode
  return current
}

const reconciler = createReconciler<
  ElementNames,
  Props,
  DOMElement,
  DOMElement,
  TextNode,
  DOMElement,
  DOMElement,
  DOMElement,
  DOMElement,
  HostContext,
  unknown,
  ReturnType<typeof setTimeout>,
  number,
  null
>({
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,

  getRootHostContext: () => OUTSIDE_TEXT,

  getChildHostContext: (parentHostContext, type) => {
    const parent = parentHostContext ?? OUTSIDE_TEXT
    const isInsideText = TEXT_HOST_ELEMENTS.has(type)
    if (isInsideText === parent.isInsideText) {
      // Identity stability matters to React.
      return parent
    }
    return isInsideText ? INSIDE_TEXT : OUTSIDE_TEXT
  },

  createInstance: (originalType, props, _root, hostContext, internalHandle) => {
    const context = hostContext ?? OUTSIDE_TEXT
    if (context.isInsideText && originalType === 'ink-box') {
      throw new Error('A box cannot be nested inside a text component.')
    }
    const type =
      originalType === 'ink-text' && context.isInsideText
        ? 'ink-virtual-text'
        : originalType
    const node = createNode(type)
    applyProps(node, props, true)
    if (isDebugRepaintsEnabled()) {
      node.debugOwnerChain = getOwnerChain(internalHandle)
    }
    instanceCreations++
    return node
  },

  createTextInstance: (text, _root, hostContext) => {
    if (!(hostContext ?? OUTSIDE_TEXT).isInsideText) {
      // Quote only a short head of the offending string: this message flows
      // into persisted crash reports, and rendered content must not ride
      // along wholesale — enough to locate the bug, no more.
      const head = text.length > 40 ? `${text.slice(0, 40)}…` : text
      throw new Error(
        `Text string "${head}" must be rendered inside a text component.`,
      )
    }
    return createTextNode(text)
  },

  // The host never claims to own text content, so every string child
  // becomes a real text node.
  shouldSetTextContent: () => false,

  appendInitialChild: appendChildNode,
  appendChild: appendChildNode,
  appendChildToContainer: appendChildNode,
  insertBefore: insertBeforeNode,
  insertInContainerBefore: insertBeforeNode,

  removeChild: (parent, child) => {
    const root = findRoot(parent)
    removeChildNode(parent, child)
    detachInstance(child, root)
  },
  removeChildFromContainer: (container, child) => {
    const root = findRoot(container)
    removeChildNode(container, child)
    detachInstance(child, root)
  },
  clearContainer: container => {
    const root = findRoot(container)
    for (const child of [...container.childNodes]) {
      removeChildNode(container, child)
      detachInstance(child, root)
    }
  },

  // Mount work is needed exactly when autoFocus is true.
  finalizeInitialChildren: (_instance, _type, props) => props.autoFocus === true,
  commitMount: instance => {
    findRoot(instance).focusManager?.handleAutoFocus(instance)
  },

  commitUpdate: (instance, _type, oldProps, newProps) => {
    const diff = diffProps(oldProps, newProps)
    if (!diff) return
    for (const [key, value] of Object.entries(diff)) {
      if (key === 'style') {
        const newStyle = (newProps.style ?? {}) as Styles
        setStyle(instance, newStyle)
        if (instance.layoutNode) {
          // The style diff applies with the FULL new style as resolution
          // context (border side flags must come from the resolved style).
          const styleDiff = diffStyle(
            (oldProps.style ?? {}) as Styles,
            newStyle,
          )
          if (styleDiff) applyStyles(instance.layoutNode, styleDiff, newStyle)
        }
        continue
      }
      if (key === 'textStyles') {
        setTextStyles(instance, (value ?? {}) as TextStyles)
        continue
      }
      if (EVENT_HANDLER_PROPS.has(key)) {
        ;(instance._eventHandlers ??= {})[key] = value
        continue
      }
      setAttribute(instance, key, value as DOMNodeAttribute)
    }
  },

  commitTextUpdate: (textInstance, _oldText, newText) => {
    setTextNodeValue(textInstance, newText)
  },

  hideInstance: instance => {
    // The flag lives beside the style object, not in it, so it survives
    // style updates.
    instance.isHidden = true
    if (instance.layoutNode) {
      applyStyles(instance.layoutNode, { display: 'none' })
    }
    markDirty(instance)
  },
  unhideInstance: instance => {
    instance.isHidden = false
    if (instance.layoutNode) {
      applyStyles(instance.layoutNode, { display: 'flex' })
    }
    markDirty(instance)
  },
  hideTextInstance: textInstance => {
    setTextNodeValue(textInstance, '')
  },
  unhideTextInstance: (textInstance, text) => {
    setTextNodeValue(textInstance, text)
  },

  prepareForCommit: () => {
    if (commitStartMark === null) markCommitStart()
    return null
  },

  resetAfterCommit: container => {
    if (commitStartMark !== null) {
      lastCommitMs = performance.now() - commitStartMark
      commitStartMark = null
    }
    noteCommit(lastCommitMs)
    instanceCreations = 0
    // Layout runs during React's commit phase so layout effects observe
    // fresh rects.
    container.onComputeLayout?.()
    if (process.env.NODE_ENV === 'test') {
      // React 19's effect double-invoke otherwise emits an empty frame for
      // a root that has previously rendered content.
      if (container.childNodes.length === 0 && container.hasRenderedContent) {
        return
      }
      if (container.childNodes.length > 0) container.hasRenderedContent = true
      container.onImmediateRender?.()
      return
    }
    container.onRender?.()
  },

  getPublicInstance: instance => instance as DOMElement,
  preparePortalMount: () => {},
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  detachDeletedInstance: () => {},

  setCurrentUpdatePriority: priority => {
    dispatcher.currentUpdatePriority = priority
  },
  getCurrentUpdatePriority: () => dispatcher.currentUpdatePriority,
  resolveUpdatePriority: () => {
    if (dispatcher.currentUpdatePriority !== NoEventPriority) {
      return dispatcher.currentUpdatePriority
    }
    const resolved = dispatcher.resolveEventPriority()
    return resolved === NoEventPriority ? DefaultEventPriority : resolved
  },
  resolveEventType: () => dispatcher.currentEvent?.type ?? null,
  // The no-event timestamp sentinel is exactly -1.1 (React compares it
  // against its own sentinel).
  resolveEventTimeStamp: () => dispatcher.currentEvent?.timeStamp ?? -1.1,

  shouldAttemptEagerTransition: () => false,
  // React's public Context and the reconciler's internal ReactContext are
  // the same runtime object under two type names, and ReactContext is
  // self-referential (its Consumer is itself), so no structural bridge can
  // satisfy it — this is the one place a forced cast is the honest option.
  HostTransitionContext: createContext<null>(
    null,
  ) as unknown as import('react-reconciler').ReactContext<null>,
  requestPostPaintCallback: () => {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  resetFormInstance: () => {},
  trackSchedulerEvent: () => {},
})

/** Style-key diff with removed keys as explicit undefined. */
function diffStyle(oldStyle: Styles, newStyle: Styles): Styles | null {
  let diff: Record<string, unknown> | null = null
  const oldRecord = oldStyle as Record<string, unknown>
  const newRecord = newStyle as Record<string, unknown>
  for (const key of Object.keys(oldRecord)) {
    if (!(key in newRecord)) (diff ??= {})[key] = undefined
  }
  for (const [key, value] of Object.entries(newRecord)) {
    if (oldRecord[key] !== value) (diff ??= {})[key] = value
  }
  return diff as Styles | null
}

// The reconciler's discrete-update entry point is wired onto the dispatcher
// after construction; this is what breaks the module cycle between the
// dispatcher and the reconciler.
dispatcher.discreteUpdates = <T,>(fn: () => T): T => {
  const previous = dispatcher.currentUpdatePriority
  dispatcher.currentUpdatePriority = DiscreteEventPriority
  try {
    return fn()
  } finally {
    dispatcher.currentUpdatePriority = previous
  }
}

// Under a development environment, attempt the devtools bridge; a
// missing-module failure prints an install pointer, anything else rethrows.
// Under production the whole branch is eliminated by the environment check.
if (process.env.NODE_ENV === 'development') {
  import('./devtools.js').catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
      console.warn(
        'ink devtools bridge missing — install react-devtools-core to enable it',
      )
      return
    }
    throw error
  })
}

/** Flush any scheduled sync-lane React work NOW. The latency-classed
 *  external-store paths (the streaming tail) call this after notifying so
 *  their commit cannot slip a frame window behind the paint throttle — the
 *  same treatment the input dispatch path gives keystrokes. */
export function flushPendingSyncWork(): void {
  reconciler.flushSyncWork()
}

export default reconciler
