import type { CanUseToolFn, Tool, ToolUseContext } from '../../kit/tool.js'
import { DENIAL_WORKAROUND_GUIDANCE } from '../../../engine/message-shapes/rejectionText.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { suggestionForExactCommand } from '../../../permissions/rules/shellRuleMatching.js'
import { ruleSentence } from '../../../permissions/rules/ruleReason.js'
import type { PermissionDecision, ToolPermissionContext } from '../../../permissions/rules/permissions.js'
import type {
  DesktopApplication,
  DesktopBounds,
  DesktopDriver,
  DesktopModifier,
  DesktopPoint,
  DesktopTree,
  DesktopTreeElement,
  DesktopTreeLimits,
} from '../../../integrations/desktop/driver.js'
import { type DesktopJudgedApp, screenOf } from '../../../integrations/desktop/desktopSession.js'
import { challengeGranted, grantChallenge, settleChallenge } from '../../../integrations/desktop/computerGrant.js'
import { postureBypassesAsks } from '../../../permissions/rules/decision/engine.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { COMPUTER_TOOL_NAME } from '../../../integrations/desktop/toolName.js'
import type { AssistantMessage, Message } from '../../../engine/message-shapes/message.js'
import { type KeyChord, appSwitchChord, isAppSwitchChord, isKeyChordRefusal, parseKeyChord } from '../keyChord.js'
import { type ScreenMap, resolveTreeRef } from '../screenMap.js'
import {
  type ScreenFacts,
  candidateWords,
  clippedWords,
  nearestOnScreen,
  pageContentNote,
  targetElement,
  targetPoint,
  targetWords,
  withOrdinal,
} from '../fastRoad.js'
import {
  CAPTCHA_ASK_UNAVAILABLE,
  CAPTCHA_OPERATOR_COMPLETES,
  CAPTCHA_QUESTION,
  type CaptchaSight,
  captchaNote,
  titleSight,
  treeSight,
} from '../captcha.js'
import {
  type Input,
  MODIFIER_KEYS,
  POINT_ACTIONS,
  TREE_DEPTH_CAP,
  TREE_DEPTH_DEFAULT,
  TREE_LIMIT_CAP,
  TREE_LIMIT_DEFAULT,
  typesKeys,
} from './schema.js'
import { actDetail, faultText, pixelWordsOf, pointWords } from './act.js'
import { interruptedText } from './words.js'
import { framePixel, ruleFor } from './shot.js'

export interface ActPlan {
  point: DesktopPoint | null
  target: DesktopPoint | null
  chord: KeyChord | null
  modifiers: DesktopModifier[]
  beforeTree?: DesktopTree
  observe?: DesktopBounds
  captcha?: CaptchaSight
  element?: DesktopTreeElement
  scrolled?: 'action' | 'wheel'
  clipped?: Array<{ field: 'point' | 'target'; element: DesktopTreeElement; words: string; label: string }>
  screens?: ScreenFacts
  aimed?: string
  returned?: string
}

async function backFromOwnTerminal(driver: DesktopDriver, judged: DesktopJudgedApp, front: DesktopApplication, signal: AbortSignal): Promise<DesktopApplication | null> {
  if (driver.findApplication === undefined || driver.activateApplication === undefined) return null
  const own = await driver.ownTerminalApplication(front)
  if (!own.ok || own.value === null || own.value.identity !== front.identity) return null
  const target = await driver.findApplication(judged.name)
  if (!target.ok || target.value.identity !== judged.identity) return null
  const activated = await driver.activateApplication(target.value, signal)
  if (!activated.ok) return null
  const after = await driver.frontmostApplication()
  return after.ok && after.value.identity === judged.identity ? after.value : null
}

export async function frontAfterCard(driver: DesktopDriver, checked: { app: DesktopJudgedApp; asked: boolean } | null, front: DesktopApplication, signal: AbortSignal): Promise<{ front: DesktopApplication; returned: string } | null> {
  if (checked === null || !checked.asked || checked.app.identity === front.identity) return null
  const back = await backFromOwnTerminal(driver, checked.app, front, signal)
  return back === null ? null : { front: back, returned: `${checked.app.name} brought back in front (the terminal that asked had taken it)` }
}

const AIMED_ACTS = new Set(['click', 'doubleClick', 'rightClick', 'move', 'drag', 'file'])

export async function settleActPoints(driver: DesktopDriver, input: Input, plan: ActPlan, front: DesktopApplication, signal: AbortSignal, map: ScreenMap | null): Promise<string | null> {
  if (input.action === 'scroll') {
    if (plan.point === null || plan.screens === undefined) return null
    const moved = nearestOnScreen(plan.screens, plan.point, front.bounds)
    if (moved !== null) {
      plan.point = moved
      plan.aimed = `wheeled at ${pointWords(moved)}, the nearest point of the window on the screen (the target lies past the screen's edge)`
    }
    return null
  }
  if (!AIMED_ACTS.has(input.action) || driver.clickablePoint === undefined) return null
  const ends: Array<{ field: 'point' | 'target'; element: DesktopTreeElement; label: string }> = []
  if (plan.element && plan.point !== null && (input.target !== undefined || input.ref !== undefined)) ends.push({ field: 'point', element: plan.element, label: 'its' })
  if (input.action === 'drag' && input.toTarget !== undefined && plan.beforeTree) {
    const other = targetElement(plan.beforeTree, input.toTarget, map)
    if (!('refusal' in other)) ends.push({ field: 'target', element: other, label: `${targetWords(input.toTarget)}'s` })
  }
  for (const end of ends) {
    const frame = end.element.frame
    if (!frame) continue
    const answer = await driver.clickablePoint(front, withOrdinal(plan.beforeTree ?? { elements: [end.element], truncated: false, reason: null }, end.element), signal)
    if (!answer.ok) {
      if (answer.error.kind === 'aborted') return interruptedText(input.action)
      continue
    }
    const point = answer.value.point
    if (point === null) continue
    const inside = point.x >= frame.x && point.x <= frame.x + frame.width && point.y >= frame.y && point.y <= frame.y + frame.height
    if (!inside) continue
    const centre = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
    if (Math.abs(point.x - centre.x) < 1 && Math.abs(point.y - centre.y) < 1) continue
    plan[end.field] = point
    if (end.field === 'point') plan.observe = { x: point.x - 24, y: point.y - 24, width: 48, height: 48 }
    plan.aimed = `aimed at ${end.label} clickable point (${answer.value.road === 'hit-test' ? 'the middle of the run of its frame that hits it' : "the window's own"}, inside the part on view)`
  }
  return null
}

const UNSCROLLED = 'the pane has no scroll action and the wheel moved nothing'

const stillClipped = (where: string, road: string, still: string, moved: boolean): string => {
  const now = still.replace(' — scroll it into view first', '')
  const advice = still.includes("display's edge") ? 'move or resize the window so the target lies on the screen, or scroll the page further, then re-issue' : 'it may be collapsed or covered: take a screenshot'
  return `${where}; it was scrolled (${road}) and ${!moved && now === where ? 'did not move' : `is still clipped: ${now}`} — ${advice}`
}

const sameFrame = (a: DesktopBounds | null, b: DesktopBounds | null): boolean => JSON.stringify(a) === JSON.stringify(b)
const EDGE_REACH_PT = 2
const usableRowFrame = (row: DesktopTreeElement): boolean => row.frame !== null && [row.frame.x, row.frame.y, row.frame.width, row.frame.height].every(Number.isFinite) && row.frame.width > 0 && row.frame.height > 0

async function scrollIntoView(driver: DesktopDriver, front: DesktopApplication, tree: DesktopTree, element: DesktopTreeElement, clipped: string, signal: AbortSignal, screens: ScreenFacts | undefined): Promise<{ element: DesktopTreeElement; road: 'action' | 'wheel' } | { refusal: string; aborted?: boolean }> {
  const where = clipped.replace(' — scroll it into view first', '')
  if (driver.scrollToVisible === undefined) return { refusal: `${where} — scroll it into view first (this desktop driver cannot scroll an element into view)` }
  const source = (element as { sourceIndices?: number[] }).sourceIndices?.[0]
  const answer = await driver.scrollToVisible(front, withOrdinal(tree, source === undefined ? element : tree.elements[source] ?? element), signal)
  if (!answer.ok) return answer.error.kind === 'aborted' ? { refusal: interruptedText('scroll'), aborted: true } : { refusal: `${where}; scrolling it into view failed: ${answer.error.note}` }
  const receipt = answer.value
  const wheeledNothing = receipt.road === 'wheel' && receipt.note === null && sameFrame(receipt.frame, element.frame)
  if (!receipt.scrolled || receipt.road === null || wheeledNothing) return { refusal: `${where}; it did not scroll into view (${receipt.note ?? UNSCROLLED}) — it may be collapsed or covered: take a screenshot` }
  if (receipt.frame === null) return { refusal: `${where}; it was scrolled (${receipt.road}) but its frame could not be read afterwards — take a screenshot and use its pixels` }
  const { offscreen: _before, ...rest } = element
  const moved: DesktopTreeElement = { ...rest, frame: receipt.frame }
  const still = clippedWords(tree, moved, front.bounds, screens)
  if (still !== null) return { refusal: stillClipped(where, receipt.road, still, !sameFrame(element.frame, receipt.frame)) }
  return { element: moved, road: receipt.road }
}

export async function scrollClippedEnds(driver: DesktopDriver, input: Input, plan: ActPlan, front: DesktopApplication, signal: AbortSignal, map: ScreenMap | null): Promise<string | null> {
  const ends = plan.clipped ?? []
  if (ends.length === 0 || plan.beforeTree === undefined) return null
  let tree = plan.beforeTree
  const scrolledEnds: string[] = []
  for (const end of ends) {
    const scrolled = await scrollIntoView(driver, front, tree, end.element, end.words, signal, plan.screens)
    if ('refusal' in scrolled) return scrolled.aborted ? scrolled.refusal : `${input.action} refused: ${end.label}: ${scrolled.refusal}${scrolledEnds.length ? ` (${scrolledEnds.join(', ')} was scrolled into view first)` : ''}`
    plan.scrolled = scrolled.road
    scrolledEnds.push(end.label)
    const fresh = await driver.accessibilityTree(front, { depth: TREE_DEPTH_CAP, count: TREE_LIMIT_CAP, scope: 'window' }, signal)
    if (fresh.ok) tree = fresh.value
    let settled: DesktopTreeElement | undefined = scrolled.element
    if (fresh.ok) {
      const same = tree.elements.filter(row => row.role === scrolled.element.role && row.title === scrolled.element.title && row.value === scrolled.element.value && usableRowFrame(row))
      const centre = (row: DesktopTreeElement) => ({ x: row.frame!.x + row.frame!.width / 2, y: row.frame!.y + row.frame!.height / 2 })
      const wanted = centre(scrolled.element)
      const reach = { x: scrolled.element.frame!.width / 2 + EDGE_REACH_PT, y: scrolled.element.frame!.height / 2 + EDGE_REACH_PT }
      const near = same.filter(row => Math.abs(centre(row).x - wanted.x) <= reach.x && Math.abs(centre(row).y - wanted.y) <= reach.y)
      settled = near.find(row => sameFrame(row.frame, scrolled.element.frame)) ?? near.sort((a, b) => Math.hypot(centre(a).x - wanted.x, centre(a).y - wanted.y) - Math.hypot(centre(b).x - wanted.x, centre(b).y - wanted.y))[0]
      if (settled === undefined) return `${input.action} refused: ${end.label}: ${end.words.replace(' — scroll it into view first', '')}; it was scrolled (${scrolled.road}) but it is not where the window's tree shows it afterwards — take a screenshot and use its pixels`
      const still = clippedWords(tree, settled, front.bounds, plan.screens)
      if (still !== null) return `${input.action} refused: ${end.label}: ${stillClipped(end.words.replace(' — scroll it into view first', ''), scrolled.road, still, !sameFrame(end.element.frame, settled.frame))}`
    }
    const frame = settled.frame!
    plan[end.field] = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
    if (end.field === 'point') { plan.element = settled; plan.observe = frame }
  }
  plan.beforeTree = tree
  if (input.action === 'drag') {
    if (input.target === undefined || input.toTarget === undefined) return `drag refused: ${scrolledEnds.join(' and ')} was scrolled into view, so the drag's pixel end is stale — take a screenshot and re-issue, or name both ends as targets`
    for (const [selector, field] of [[input.target, 'point'], [input.toTarget, 'target']] as const) {
      const point = targetPoint(tree, selector, map)
      if ('refusal' in point) return `drag refused after the scroll: ${point.refusal}`
      const element = targetElement(tree, selector, map)
      const still = 'refusal' in element ? null : clippedWords(tree, element, front.bounds, plan.screens)
      if (still !== null) return `drag refused: the two ends are not in view together after scrolling (${targetWords(selector)}: ${still.replace(' — scroll it into view first', '')}) — scroll first or drag in steps`
      plan[field] = point
      if (field === 'point' && !('refusal' in element)) { plan.element = element; if (element.frame) plan.observe = element.frame }
    }
  }
  return null
}

export function planOf(owner: OwnerKey, context: ToolUseContext, input: Input, sameMessage: ReadonlySet<string> = new Set()): ActPlan | { refusal: string } {
  const map = screenOf(owner)
  const messages: readonly Message[] = context.messages ?? []
  let point: DesktopPoint | null = null
  let target: DesktopPoint | null = null
  if (POINT_ACTIONS.has(input.action)) {
    if (input.target === undefined && input.ref === undefined) {
      const framed = framePixel(map, messages, input.x!, input.y!, sameMessage)
      if (!framed.ok) return { refusal: `${input.action} refused: ${framed.text}` }
      point = framed.point
    }
    if (input.action === 'drag' && input.toTarget === undefined) {
      const end = framePixel(map, messages, input.toX!, input.toY!, sameMessage)
      if (!end.ok) return { refusal: `drag refused: ${end.text}` }
      target = end.point
    }
  }
  let chord: KeyChord | null = null
  if (input.action === 'key' || input.action === 'hold') {
    const parsed = parseKeyChord(input.key ?? '')
    if (isKeyChordRefusal(parsed)) return { refusal: `${input.action} refused: ${parsed.reason}` }
    chord = parsed
  }
  const modifiers = (input.modifiers ?? []).map(modifier => MODIFIER_KEYS[modifier])
  return { point, target, chord, modifiers, ...(point ? { observe: { x: point.x - 24, y: point.y - 24, width: 48, height: 48 } } : {}) }
}

export async function resolveActTargets(driver: DesktopDriver, input: Input, front: DesktopApplication, plan: ActPlan, signal: AbortSignal, owner: OwnerKey, map: ScreenMap | null): Promise<string | null> {
  if (plan.chord !== null && isAppSwitchChord(plan.chord)) return null
  const titled = titleSight(front.title ?? '')
  plan.captcha = titled
  const fullReach = input.ref !== undefined || input.target !== undefined || input.toTarget !== undefined || input.verify === true
  const limitsOf = (reach: boolean): DesktopTreeLimits => ({ depth: Math.min(input.depth ?? (reach ? TREE_DEPTH_CAP : TREE_DEPTH_DEFAULT), TREE_DEPTH_CAP), count: Math.min(input.limit ?? (reach ? TREE_LIMIT_CAP : TREE_LIMIT_DEFAULT), TREE_LIMIT_CAP), scope: 'window' })
  let tree = await driver.accessibilityTree(front, limitsOf(fullReach), signal)
  if (tree.ok && !fullReach && treeSight(tree.value, front.bounds) === 'widget') tree = await driver.accessibilityTree(front, limitsOf(true), signal)
  if (!tree.ok) return input.ref !== undefined || input.target !== undefined || input.toTarget !== undefined ? faultText(input.action, tree.error) : null
  const seen = treeSight(tree.value, front.bounds)
  plan.captcha = titled === 'challenge' || seen === 'challenge' ? 'challenge' : seen ?? titled
  plan.beforeTree = tree.value
  const scrollsInto = input.action !== 'scroll'
  plan.clipped = []
  const displays = await driver.displays()
  plan.screens = displays.ok ? { displays: displays.value.displays, spanning: displays.value.spanning ?? true } : undefined
  if (input.ref !== undefined) {
    const elements = resolveTreeRef(owner, front, tree.value, input.ref)
    if (elements.length !== 1) return `${input.action} refused: ref:${input.ref}: ${elements.length === 0 ? 'no element of the latest tree matches it now' : `${elements.length} elements match it now`} — read the tree or find again${elements.length ? `\n${candidateWords(elements, map)}` : ''}`
    const element = elements[0]!
    const point = targetPoint({ ...tree.value, elements: [element] }, {}, map)
    if ('refusal' in point) return `${input.action} refused: ref:${input.ref}${point.refusal}`
    const clipped = scrollsInto ? clippedWords(tree.value, element, front.bounds, plan.screens) : null
    if (clipped !== null) {
      if (titleSight(`${element.role} ${element.title ?? ''} ${element.value ?? ''}`) === 'challenge') plan.captcha = 'challenge'
      plan.clipped = [...(plan.clipped ?? []), { field: 'point', element, words: clipped, label: `ref:${input.ref}` }]
    }
    plan.point = point
    plan.element = element
    if (element.frame) plan.observe = element.frame
  }
  for (const [selector, field] of [[input.target, 'point'], [input.toTarget, 'target']] as const) {
    if (selector === undefined) continue
    const point = targetPoint(tree.value, selector, map)
    if ('refusal' in point) return `${input.action} refused: ${point.refusal}${pageContentNote(front, tree.value) ? `\n${pageContentNote(front, tree.value)}` : ''}`
    const element = targetElement(tree.value, selector, map)
    const clipped = 'refusal' in element || !scrollsInto ? null : clippedWords(tree.value, element, front.bounds, plan.screens)
    if (clipped !== null && !('refusal' in element)) {
      if (titleSight(`${element.role} ${element.title ?? ''} ${element.value ?? ''}`) === 'challenge') plan.captcha = 'challenge'
      plan.clipped = [...(plan.clipped ?? []), { field, element, words: clipped, label: targetWords(selector) }]
    }
    plan[field] = point
    const frame = 'refusal' in element ? undefined : element.frame
    if (field === 'point' && !('refusal' in element)) plan.element = element
    if (field === 'point' && frame) plan.observe = frame
  }
  return null
}

export function isPlanRefusal(plan: ActPlan | { refusal: string }): plan is { refusal: string } {
  return 'refusal' in plan
}

type ChallengeVerdict = { verdict: 'deny'; text: string } | { verdict: 'allow' } | { verdict: 'ask'; decision: PermissionDecision }

export function challengeVerdict(input: Input, front: DesktopApplication, context: ToolUseContext): ChallengeVerdict {
  const permissionContext = context.getAppState?.()?.toolPermissionContext as ToolPermissionContext | undefined
  const rule = ruleFor(permissionContext, 'captcha')
  if (rule?.ruleBehavior === 'deny') return { verdict: 'deny', text: `${ruleSentence('Trying a human-verification challenge', 'deny', rule)} The operator completes it — wait until it is gone, then re-issue` }
  if (challengeGranted(String(getSessionId()), front) !== null || rule?.ruleBehavior === 'allow' || (permissionContext !== undefined && postureBypassesAsks(permissionContext))) return { verdict: 'allow' }
  return {
    verdict: 'ask',
    decision: {
      behavior: 'ask',
      message: `Computer ${input.action}${actDetail(input)} in ${front.name} (${front.identity}) — ${CAPTCHA_QUESTION}`,
      decisionReason: { type: 'safetyCheck', reason: `${front.name} shows a human-verification challenge; whether Mercury may try it is the operator's own call`, operatorOnly: true },
      suggestions: suggestionForExactCommand(COMPUTER_TOOL_NAME, 'captcha'),
    },
  }
}

export function challengeAction(action: string): string {
  return `${action} captcha`
}

export async function challengeRoad(ComputerTool: Tool, input: Input, plan: ActPlan, front: DesktopApplication, context: ToolUseContext, canUseTool: CanUseToolFn | undefined, parent: AssistantMessage | undefined, toolUseId: string, answered: boolean): Promise<string | 'asked' | null> {
  const sessionId = String(getSessionId())
  const seen = plan.captcha === 'challenge'
  settleChallenge(sessionId, front, seen)
  if (!seen && input.captcha !== true) return null
  const verdict = challengeVerdict(input, front, context)
  if (verdict.verdict === 'deny') return `${input.action} not done: ${verdict.text}`
  if (verdict.verdict === 'allow' || answered) {
    grantChallenge(sessionId, front, seen)
    return null
  }
  if (!canUseTool || !parent) return `${input.action} not done: ${CAPTCHA_ASK_UNAVAILABLE}`
  const decision = await canUseTool(ComputerTool, { ...input, captcha: true }, context, parent, toolUseId, verdict.decision)
  if (decision.behavior === 'allow') {
    grantChallenge(sessionId, front, seen)
    return 'asked'
  }
  const message = 'message' in decision && typeof decision.message === 'string' ? decision.message : ''
  if (message.includes(CAPTCHA_OPERATOR_COMPLETES)) return `${input.action} not done: ${CAPTCHA_OPERATOR_COMPLETES}`
  const cause = decision.behavior === 'ask' ? '' : message.replace(DENIAL_WORKAROUND_GUIDANCE, '').replace(/\s+/g, ' ').trim()
  return `${input.action} not done: ${cause || 'no one answered the challenge question'} — a Computer(captcha) allow rule in guardrails.allow answers it without a card`
}

export function captchaLine(tree: DesktopTree, app: DesktopApplication): string {
  const note = captchaNote(treeSight(tree, app.bounds), challengeGranted(String(getSessionId()), app) !== null)
  return note ? `\n${note}` : ''
}

function insideBounds(point: DesktopPoint, bounds: { x: number; y: number; width: number; height: number }): boolean {
  return point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
}

function switchChordWords(): string {
  const chord = appSwitchChord()
  return `${chord.modifiers.map(modifier => (modifier === 'super' ? 'cmd' : modifier)).join('+')}+${chord.key}`
}

export async function ownTerminalRefusal(
  driver: DesktopDriver,
  input: Input,
  front: DesktopApplication,
  plan: ActPlan,
): Promise<string | null> {
  const own = await driver.ownTerminalApplication(front)
  const action = input.action
  if (!own.ok || own.value === null) {
    if (typesKeys(input, plan)) return `${action} refused: the terminal running this session could not be identified — keep the cockpit attached in a supported terminal before sending keystrokes`
    return null
  }
  if (own.value.identity !== front.identity) return null
  if (own.value.tty) {
    const current = await driver.frontmostApplication()
    if (!current.ok || current.value.identity !== front.identity || current.value.windowId !== front.windowId) {
      return `${action} refused: the front window changed while checking terminal ownership by tty — nothing done; take a screenshot and re-issue`
    }
  }
  const windowKnown = own.value.windowId != null && front.windowId != null
  if (windowKnown && own.value.windowId !== front.windowId) {
    for (const point of [plan.point, plan.target]) {
      if (point === null || (front.bounds !== null && insideBounds(point, front.bounds))) continue
      if (own.value.bounds === null) return `${action} refused: the point is outside the target window and the terminal running this session has unknown bounds — keep the act inside the target window`
      if (insideBounds(point, own.value.bounds)) return `${action} refused: ${pixelWordsOf(input, point, plan)} is inside the window of the terminal running this session`
    }
    return null
  }
  const windowCheck = windowKnown && own.value.tty ? '\nWindow ownership checked by tty.' : ''
  const unknownWindow = 'the terminal application running this session is in front, but its window identity is unknown — all windows of this application remain protected; switch to another application first'
  if (!windowKnown && typesKeys(input, plan)) {
    return `${action} refused: ${unknownWindow}`
  }
  if (action === 'type' || action === 'hold' || action === 'fill' || action === 'file') {
    return `${action} refused: the application in front is the terminal running this session — a keystroke there would land in this conversation; switch to the target application first${windowCheck}`
  }
  if (action === 'key') {
    if (plan.chord !== null && isAppSwitchChord(plan.chord)) return null
    return `key refused: the terminal running this session is in front — only the application switch chord (${switchChordWords()}) is allowed there; switch to the target application first${windowCheck}`
  }
  const points = [plan.point, plan.target].filter((point): point is DesktopPoint => point !== null)
  if (front.bounds === null) {
    if (!windowKnown) return `${action} refused: ${unknownWindow}; the front window's bounds are also unknown`
    return `${action} refused: the terminal running this session is in front and its window bounds are unknown — switch to the target application first${windowCheck}`
  }
  for (const point of points) {
    if (insideBounds(point, front.bounds)) {
      const pixel = pixelWordsOf(input, point, plan)
      if (!windowKnown) return `${action} refused: ${pixel} is inside the front window; ${unknownWindow}`
      return `${action} refused: ${pixel} is inside the window of the terminal running this session${windowCheck}`
    }
  }
  return null
}
