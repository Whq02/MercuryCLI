import { appendFileSync } from 'node:fs'
import { createContext } from 'react'
import createReconciler, { type ReactContext } from 'react-reconciler'
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
import { passedOver } from '../../platform/errors/passedOver.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export const dispatcher = new Dispatcher()

let lastYogaMs = 0
let lastCommitMs = 0
let commitStartMark = 0

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
  } catch (error) {
    passedOver(error)
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


type Props = Record<string, unknown>
type HostContext = { isInsideText: boolean }

const OUTSIDE_TEXT: HostContext = { isInsideText: false }
const INSIDE_TEXT: HostContext = { isInsideText: true }

const TEXT_HOST_ELEMENTS = new Set(['ink-text', 'ink-virtual-text', 'ink-link'])

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

function findRoot(node: DOMElement): DOMElement {
  let current: DOMElement = node
  while (current.parentNode) current = current.parentNode
  return current
}

function setHandlerOrAttribute(node: DOMElement, key: string, value: unknown): void {
  if (EVENT_HANDLER_PROPS.has(key)) {
    node._eventHandlers ??= {}
    node._eventHandlers[key] = value
    return
  }
  setAttribute(node, key, value as DOMNodeAttribute)
}

function applyInitialProp(node: DOMElement, key: string, value: unknown): void {
  if (key === 'children') return
  if (key === 'style') {
    const style = (value as Styles | undefined) ?? {}
    setStyle(node, style)
    if (node.layoutNode) applyStyles(node.layoutNode, style, style)
    return
  }
  if (key === 'textStyles') {
    node.textStyles = value as TextStyles
    return
  }
  setHandlerOrAttribute(node, key, value)
}

function applyChangedProp(node: DOMElement, key: string, value: unknown, oldProps: Props): void {
  if (key === 'style') {
    const style = (value as Styles | undefined) ?? {}
    setStyle(node, style)
    if (!node.layoutNode) return
    const change = diffStyle((oldProps['style'] as Styles | undefined) ?? {}, style)
    if (!change) return
    applyStyles(node.layoutNode, change, style)
    if (node.isHidden) applyStyles(node.layoutNode, { display: 'none' })
    return
  }
  if (key === 'textStyles') {
    setTextStyles(node, (value as TextStyles | undefined) ?? {})
    return
  }
  setHandlerOrAttribute(node, key, value)
}

function removeHostChild(parent: DOMElement, child: DOMNode): void {
  const root = findRoot(parent)
  removeChildNode(parent, child)
  if (child.nodeName === '#text') return
  const layoutNode = child.layoutNode
  if (layoutNode) {
    layoutNode.unsetMeasureFunc()
    clearLayoutNodeReferences(child)
    layoutNode.freeRecursive()
  }
  root.focusManager?.handleNodeRemoved(child, root)
}

function isReconcilerContext(context: object): context is ReactContext<null> {
  return Object.hasOwn(context, '_currentValue')
}

function createTransitionContext(): ReactContext<null> {
  const context = createContext(null)
  if (!isReconcilerContext(context)) throw new TypeError('React made a context that holds no current value')
  return context
}

const reconciler = createReconciler<
  ElementNames,
  Props,
  DOMElement,
  DOMElement,
  TextNode,
  never,
  never,
  never,
  DOMElement,
  HostContext,
  never,
  NodeJS.Timeout,
  -1,
  null
>({
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  scheduleTimeout: startTimeout,
  cancelTimeout: stopTimeout,
  noTimeout: -1,
  NotPendingTransition: null,
  HostTransitionContext: createTransitionContext(),
  getRootHostContext: () => OUTSIDE_TEXT,
  getChildHostContext(parentHostContext, type) {
    const isInsideText = TEXT_HOST_ELEMENTS.has(type)
    if (parentHostContext.isInsideText === isInsideText) return parentHostContext
    return isInsideText ? INSIDE_TEXT : OUTSIDE_TEXT
  },
  shouldSetTextContent: () => false,
  createInstance(originalType, newProps, _root, hostContext) {
    if (hostContext.isInsideText && originalType === 'ink-box') {
      throw new Error('A box cannot be nested inside a text component.')
    }
    const node = createNode(hostContext.isInsideText && originalType === 'ink-text' ? 'ink-virtual-text' : originalType)
    for (const [key, value] of Object.entries(newProps)) applyInitialProp(node, key, value)
    instanceCreations++
    return node
  },
  createTextInstance(text, _root, hostContext) {
    if (!hostContext.isInsideText) {
      const head = text.length > 40 ? `${text.slice(0, 40)}…` : text
      throw new Error(`Text string "${head}" must be rendered inside a text component.`)
    }
    return createTextNode(text)
  },
  appendInitialChild: appendChildNode,
  finalizeInitialChildren: (_node, _type, props) => props['autoFocus'] === true,
  commitMount(node) {
    findRoot(node).focusManager?.handleAutoFocus(node)
  },
  getPublicInstance: (instance: DOMElement) => instance,
  prepareForCommit() {
    if (commitStartMark === 0) markCommitStart()
    return null
  },
  resetAfterCommit(container) {
    if (commitStartMark !== 0) {
      lastCommitMs = performance.now() - commitStartMark
      commitStartMark = 0
    }
    noteCommit(lastCommitMs)
    instanceCreations = 0
    container.onComputeLayout?.()
    if (process.env.NODE_ENV !== 'test') {
      container.onRender?.()
      return
    }
    if (container.childNodes.length === 0 && container.hasRenderedContent) return
    if (container.childNodes.length > 0) container.hasRenderedContent = true
    container.onImmediateRender?.()
  },
  preparePortalMount() {},
  appendChild: appendChildNode,
  appendChildToContainer: appendChildNode,
  insertBefore: insertBeforeNode,
  insertInContainerBefore: insertBeforeNode,
  removeChild: removeHostChild,
  removeChildFromContainer: removeHostChild,
  clearContainer(container) {
    for (const child of [...container.childNodes]) removeHostChild(container, child)
  },
  resetTextContent() {},
  commitTextUpdate(node, _oldText, newText) {
    setTextNodeValue(node, newText)
  },
  commitUpdate(node, _type, oldProps, newProps) {
    const changed = diffProps(oldProps, newProps)
    if (!changed) return
    for (const [key, value] of Object.entries(changed)) applyChangedProp(node, key, value, oldProps)
  },
  hideInstance(node) {
    node.isHidden = true
    if (node.layoutNode) applyStyles(node.layoutNode, { display: 'none' })
    markDirty(node)
  },
  unhideInstance(node) {
    node.isHidden = false
    if (node.layoutNode) applyStyles(node.layoutNode, { display: node.style.display === 'none' ? 'none' : 'flex' })
    markDirty(node)
  },
  hideTextInstance(node) {
    setTextNodeValue(node, '')
  },
  unhideTextInstance(node, text) {
    setTextNodeValue(node, text)
  },
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope: () => null,
  detachDeletedInstance() {},
  setCurrentUpdatePriority(priority) {
    dispatcher.currentUpdatePriority = priority
  },
  getCurrentUpdatePriority: () => dispatcher.currentUpdatePriority,
  resolveUpdatePriority() {
    if (dispatcher.currentUpdatePriority !== NoEventPriority) return dispatcher.currentUpdatePriority
    const resolved = dispatcher.resolveEventPriority()
    return resolved === NoEventPriority ? DefaultEventPriority : resolved
  },
  resolveEventType: () => dispatcher.currentEvent?.type ?? null,
  resolveEventTimeStamp: () => dispatcher.currentEvent?.timeStamp ?? -1.1,
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent() {},
  resetFormInstance() {},
  requestPostPaintCallback() {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady: () => null,
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

export function flushPendingSyncWork(): void {
  reconciler.flushSyncWork()
}

export default reconciler
