
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

export const dispatcher = new Dispatcher()

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

export function isDebugRepaintsEnabled(): boolean {
  return false
}

type FiberLike = {
  type?: unknown
  elementType?: unknown
  return?: FiberLike | null
  _debugOwner?: FiberLike | null
}

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
      const head = text.length > 40 ? `${text.slice(0, 40)}…` : text
      throw new Error(
        `Text string "${head}" must be rendered inside a text component.`,
      )
    }
    return createTextNode(text)
  },

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
    container.onComputeLayout?.()
    if (process.env.NODE_ENV === 'test') {
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
  resolveEventTimeStamp: () => dispatcher.currentEvent?.timeStamp ?? -1.1,

  shouldAttemptEagerTransition: () => false,
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

dispatcher.discreteUpdates = <T,>(fn: () => T): T => {
  const previous = dispatcher.currentUpdatePriority
  dispatcher.currentUpdatePriority = DiscreteEventPriority
  try {
    return fn()
  } finally {
    dispatcher.currentUpdatePriority = previous
  }
}

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

export function flushPendingSyncWork(): void {
  reconciler.flushSyncWork()
}

export default reconciler
