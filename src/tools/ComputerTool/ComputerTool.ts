import { readFileSync } from 'node:fs'
import { type CanUseToolFn, type ToolEffect, type ToolEffectOutcome, type ToolUseContext, buildTool } from '../../Tool.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { isTerminalApplication, readTerminalText } from './terminalText.js'
import { WEB_CONTENT_NOTICE } from '../BashTool/webContent.js'
import { modelReceivesImageBlocks } from '../../utils/model/capabilities.js'
import { getEngineModel } from '../../utils/model/model.js'
import { sleep } from '../../utils/sleep.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { suggestionForExactCommand } from '../../utils/permissions/shellRuleMatching.js'
import { ruleSentence } from '../../utils/permissions/ruleReason.js'
import type { PermissionDecision, ToolPermissionContext } from '../../types/permissions.js'
import { rememberDesktopPermissions, resolveDesktopDriver } from '../../services/desktop/resolveDriver.js'
import type { DesktopAnswer, DesktopBounds, DesktopError, DesktopTree, DesktopTreeElement } from '../../services/desktop/driver.js'
import {
  type DesktopJudgedApp,
  appApproved,
  approveApp,
  consumeCheckedAct,
  desktopPostureRefusal,
  markCheckedActAsked,
  noteCheckedActApp,
  noteTurnHome,
  peekCheckedActApp,
  screenOf,
  setDrivingApp,
  setScreen,
  turnKeyOf,
} from '../../services/desktop/desktopSession.js'
import { claimDesktop, desktopClaimBusyNote, renewDesktopClaim } from '../../services/desktop/desktopClaim.js'
import { readComputerGrant, settleChallenge } from '../../services/desktop/computerGrant.js'
import { computerAccessPinnedToAsk, savedComputerAccess } from '../../services/desktop/computerAccess.js'
import { resolveComputerAccess } from '../../substrate/startupMenu.js'
import { postureBypassesAsks } from '../../utils/permissions/decision/engine.js'
import { getSessionId } from '../../bootstrap/state.js'
import { COMPUTER_TOOL_NAME } from '../../services/desktop/toolName.js'
import type { AssistantMessage } from '../../types/message.js'
import {
  type DesktopOutline,
  type ScreenMap,
  outlineTree,
  pixelOfPoint,
  pixelOnScreen,
  rememberTreeRefs,
  resolveTreeRef,
} from './screenMap.js'
import { renderToolResultMessage, renderToolUseErrorMessage, renderToolUseMessage, userFacingName } from './UI.js'
import {
  type DesktopObservation,
  STATE_LINE,
  observationChanged,
  pageContentNote,
  readObservation,
  regionRefusal,
  sameWindow,
  settledObservation,
  stateWord,
  targetElement,
  targetMatches,
  targetWords,
  treeObservation,
  verificationWords,
  withOrdinal,
} from './fastRoad.js'
import { treeSight } from './captcha.js'
import { OPERATOR_TYPING_REFUSAL, operatorIsTyping, waitForOperatorPause } from './operatorPause.js'
import { waitConditionPassed, waitConditionWords } from './waitCondition.js'
import { COMPUTER_PROMPT } from './prompt.js'
import {
  ACTIONS,
  ACT_ACTIONS,
  ASK_ACTIONS,
  FACT_ACTIONS,
  FIELD_ROLES,
  type Input,
  type Output,
  READ_ACTIONS,
  SCREENSHOT_NOT_RETURNED,
  SCREENSHOT_SUPERSEDED,
  SCREENSHOT_UNSEEN,
  SETTLE_CAP_MS,
  SETTLE_DEFAULT_MS,
  type SchemaType,
  TREE_DEPTH_CAP,
  TREE_DEPTH_DEFAULT,
  TREE_LIMIT_CAP,
  TREE_LIMIT_DEFAULT,
  UNTIL_DEFAULT_MS,
  WAIT_CAP_MS,
  WAIT_DEFAULT_MS,
  carriesScreenContent,
  clamp,
  computerToolEnabled,
  inputSchema,
  modelInputSchema,
  permissionAction,
  refuse,
  tableRefusal,
} from './computer/schema.js'
import {
  captchaLine,
  challengeAction,
  challengeRoad,
  challengeVerdict,
  frontAfterCard,
  isPlanRefusal,
  ownTerminalRefusal,
  planOf,
  resolveActTargets,
  scrollClippedEnds,
  settleActPoints,
} from './computer/plan.js'
import { type ActWords, actDetail, faultNote, faultText, performAct } from './computer/act.js'
import {
  applicationWords,
  factsLine,
  fieldsWords,
  interruptedAfterActText,
  interruptedText,
  readRefElement,
  readWords,
  treeLimitsOf,
  treeWords,
} from './computer/words.js'
import {
  type Shot,
  denied,
  routeRefusal,
  ruleFor,
  ruleVerdict,
  takeScreenshot,
  toolUseIdOfParent,
  toolUseIdsOfParent,
} from './computer/shot.js'

export { COMPUTER_TOOL_NAME }
export { computerToolEnabled, HOLD_CAP_MS, TREE_DEPTH_CAP, TREE_DEPTH_DEFAULT, TREE_LIMIT_CAP, TREE_LIMIT_DEFAULT, TYPE_TEXT_CAP } from './computer/schema.js'
export type { Input, Output } from './computer/schema.js'

export const ComputerTool = buildTool({
  name: COMPUTER_TOOL_NAME,
  searchHint: 'inspect desktop applications and operate their mouse and keyboard',
  searchKeywords: ['computer use', 'screen', 'mouse', 'keyboard', 'desktop', 'screenshot', 'click', 'type', 'scroll', 'press', 'keys', 'application', 'window', 'control', 'native app', 'automate', 'GUI'],
  capability: {
    intents: [
      'see the screen and drive the mouse and keyboard',
      'take a screenshot of the desktop',
      'click, type, scroll or press keys in the application in front',
      'find out which application is in front',
    ],
    units: ['desktop-drive'],
    class: 'execution',
    operations: [...ACTIONS],
    execution: { kind: 'desktop-session', representation: 'child-execution' },
    evidence: ['artifact'],
    resources: [],
    cancellation: 'cooperative',
    latency: 'interactive',
    gate: 'MERCURY_COMPUTER_USE',
    conditions: ['a desktop driver that resolves (the native driver pack; MERCURY_DESKTOP_DRIVER=none switches it off)'],
    proof: 'scripts/computer/prove-computer-asks.ts',
  },
  maxResultSizeChars: 20_000,
  async description() {
    return "Drive the operator's screen: screenshot, click, type, press keys, scroll and drag in the application in front, on every model route that receives images"
  },
  async prompt() {
    return COMPUTER_PROMPT
  },
  userFacingName,
  shouldDefer: true,
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  get inputJSONSchema() {
    return zodToJsonSchema(modelInputSchema()) as never
  },
  isEnabled() {
    return computerToolEnabled()
  },
  isConcurrencySafe(input: Input) {
    return FACT_ACTIONS.has(input?.action)
  },
  isReadOnly(input: Input) {
    return input?.action !== 'sequence' && READ_ACTIONS.has(input ? permissionAction(input) : '')
  },
  requiresUserInteraction() {
    return computerAccessPinnedToAsk()
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  async validateInput(input: Input, context: ToolUseContext) {
    if (!flagEnabled('MERCURY_COMPUTER_USE')) {
      return refuse("the Computer tool is off — MERCURY_COMPUTER_USE=0 in this session's environment removes it; unset it before the session starts")
    }
    const posture = desktopPostureRefusal(context)
    if (posture !== null && context.agentId) return refuse(posture)
    const model = context?.options?.engineModel ?? getEngineModel()
    const route = await routeRefusal(model, context.abortController?.signal)
    if (route !== null) return refuse(route)
    const resolution = resolveDesktopDriver()
    if (resolution.state === 'unavailable') {
      return refuse(`no desktop driver: ${resolution.note}${resolution.remedy ? ` — ${resolution.remedy}` : ''}`)
    }
    const table = tableRefusal(input)
    if (table !== null) return refuse(table)
    return { result: true as const }
  },
  async checkPermissions(input: Input, context: ToolUseContext) {
    const posture = desktopPostureRefusal(context)
    if (posture !== null && !context.agentId) return denied(posture, 'desktop session policy')
    if (input.action === 'read' && input.clipboard === true) {
      const permissionContext = context.getAppState?.()?.toolPermissionContext as ToolPermissionContext | undefined
      const rule = ruleFor(permissionContext, 'clipboard')
      if (rule?.ruleBehavior === 'deny') return denied(ruleSentence('Reading the clipboard', 'deny', rule), 'clipboard carries a deny rule')
      if (rule?.ruleBehavior === 'allow') return { behavior: 'allow' as const, updatedInput: input }
      return { behavior: 'ask' as const, message: 'Computer read clipboard — read the clipboard text', decisionReason: { type: 'safetyCheck' as const, reason: 'Clipboard text needs separate consent', operatorOnly: true }, suggestions: suggestionForExactCommand(COMPUTER_TOOL_NAME, 'clipboard') }
    }
    if (!ASK_ACTIONS.has(permissionAction(input))) return { behavior: 'allow' as const, updatedInput: input }
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const resolution = resolveDesktopDriver()
    if (resolution.state !== 'ok') return { behavior: 'allow' as const, updatedInput: input }
    const driver = resolution.driver
    const front = await driver.frontmostApplication()
    if (!front.ok) {
      return denied(
        `Computer ${input.action} refused: the application in front could not be read — ${front.error.note}`,
        'the application in front is unknown',
      )
    }
    let app = front.value
    const home = noteTurnHome(owner, turnKeyOf(context), { identity: app.identity, name: app.name })
    if (input.action === 'focusApp') {
      if (!driver.findApplication) return denied('focusApp is unavailable in this desktop driver', 'application lookup unavailable')
      const target = await driver.findApplication(input.focusApp!.name)
      if (!target.ok) return denied(faultText('focusApp', target.error), 'application not found')
      app = target.value
    }
    const plan = planOf(owner, context, input)
    if (isPlanRefusal(plan)) return denied(plan.refusal, 'the act has no screenshot frame')
    const terminal = permissionAction(input) === 'tree' || input.action === 'focusApp' ? null : await ownTerminalRefusal(driver, input, app, plan)
    if (terminal !== null) return denied(terminal, 'the own-terminal guard refused the act')
    const permissionContext = (context as Partial<ToolUseContext> | undefined)?.getAppState?.()
      ?.toolPermissionContext as ToolPermissionContext | undefined
    const content = `app:${app.identity}`
    const ruled = ruleVerdict(permissionContext, content)
    if (ruled === 'deny') {
      return denied(ruleSentence(`Driving ${app.name} (${app.identity})`, 'deny', ruleFor(permissionContext, content)!), `${content} carries a deny rule`)
    }
    noteCheckedActApp(owner, input.action, { identity: app.identity, name: app.name })
    const asked = (decision: PermissionDecision): PermissionDecision => {
      if (decision.behavior === 'ask') markCheckedActAsked(owner)
      return decision
    }
    const challenge = (viaGrant: boolean): PermissionDecision => {
      if (input.captcha !== true || !ACT_ACTIONS.has(input.action)) return { behavior: 'allow' as const, updatedInput: input }
      const verdict = challengeVerdict(input, app, context)
      if (verdict.verdict === 'deny') return denied(`Computer ${input.action} not done: ${verdict.text}`, 'captcha carries a deny rule')
      noteCheckedActApp(owner, challengeAction(input.action), { identity: app.identity, name: app.name }, viaGrant)
      return verdict.verdict === 'allow' ? { behavior: 'allow' as const, updatedInput: input } : asked(verdict.decision)
    }
    if (ruled === 'allow' || (ruled === null && appApproved(owner, app.identity))) return challenge(false)
    const access = resolveComputerAccess(savedComputerAccess(), permissionContext !== undefined && postureBypassesAsks(permissionContext))
    const opened = access.value === 'full' || (access.value === 'permissive' && home.identity === app.identity)
    if (ruled === null && (opened || readComputerGrant(String(getSessionId())) !== null)) {
      noteCheckedActApp(owner, input.action, { identity: app.identity, name: app.name }, true)
      return challenge(true)
    }
    return asked({
      behavior: 'ask' as const,
      message: `Computer ${input.action}${actDetail(input)} in ${app.name} (${app.identity}) — the first act this session (${permissionAction(input) === 'tree' ? 'reads its accessibility tree: the controls with their titles, values and frames' : input.action === 'focusApp' ? 'brings this application to the front' : 'drives your mouse and keyboard'})`,
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: `${app.name} (${app.identity}) is in front of the operator's screen; the first act of the session needs the operator's own consent`,
        operatorOnly: true,
      },
      suggestions: suggestionForExactCommand(COMPUTER_TOOL_NAME, content),
    })
  },
  async call(input: Input, context: ToolUseContext, canUseTool?: CanUseToolFn, parentAssistantMessage?: AssistantMessage): Promise<{ data: Output; effect: ToolEffect }> {
    const startedAt = Date.now()
    const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
    const signal = context.abortController?.signal ?? new AbortController().signal
    const toolUseId = context.toolUseId ?? toolUseIdOfParent(parentAssistantMessage) ?? ''
    const sameMessage: ReadonlySet<string> = new Set(toolUseIdsOfParent(parentAssistantMessage))
    let result: string
    let outcome: ToolEffectOutcome = 'no-change'
    let imagePath: string | undefined
    let inlinePath: string | undefined
    let inlineMediaType: string | undefined
    let screen: ScreenMap | undefined
    let claimedForAct = false
    let contentShown = false
    const posture = desktopPostureRefusal(context)
    if (posture !== null) {
      result = `policy denial: ${posture}`
      outcome = 'failed'
      return finish()
    }
    const resolution = resolveDesktopDriver()
    if (resolution.state === 'unavailable') {
      result = `no desktop driver: ${resolution.note}${resolution.remedy ? ` — ${resolution.remedy}` : ''}`
      outcome = 'failed'
      return finish()
    }
    const driver = resolution.driver
    const permissions = await driver.permissions()
    if (permissions.ok) rememberDesktopPermissions(permissions.value)
    const takeShot = (wanted: number | undefined, label: string | undefined, settleMs = 0, observe?: DesktopBounds): Promise<Shot> =>
      takeScreenshot(owner, driver, context, toolUseId, wanted, label, signal, input.region, settleMs, observe, input.full, input.scale, true, sameMessage)
    const shotLines = new Set<string>()
    const adoptShot = (shot: Extract<Shot, { ok: true }>): void => {
      imagePath = shot.imagePath
      inlinePath = shot.inlinePath
      inlineMediaType = shot.inlineMediaType
      screen = shot.screen
      shotLines.add(shot.line)
    }
    try {
      const invalid = tableRefusal(input)
      const badRegion = input.region === undefined ? null : regionRefusal(input.region, screenOf(owner))
      if (invalid !== null || badRegion !== null) {
        result = invalid ?? badRegion!
        outcome = 'failed'
        return finish()
      }
      if (input.action === 'sequence') {
        const steps = input.steps!.map(step => inputSchema().parse(step))
        const lines: string[] = []
        let completed = 0
        let afterState = ''
        let anyChanged = false
        let anyScrolled = false
        let firstBefore: DesktopObservation | null = null
        let mayRead = false
        let shotInSequence = false
        const readable = new Set<string>()
        for (const step of steps) {
          if (signal.aborted) {
            await driver.releaseAll()
            result = `sequence ${completed}/${steps.length} completed · ${interruptedText('sequence')}${lines.length ? `\n${lines.join('\n')}` : ''}`
            outcome = 'failed'
            return finish()
          }
          if (shotInSequence && ((step.x !== undefined && step.y !== undefined) || (step.toX !== undefined && step.toY !== undefined) || step.region !== undefined)) {
            result = `sequence ${completed}/${steps.length} completed · ${step.action} refused: ${SCREENSHOT_UNSEEN}; nothing further done\n${lines.join('\n')}`
            outcome = 'failed'
            return finish()
          }
          let decision: PermissionDecision = await ComputerTool.checkPermissions(step, context)
          if (decision.behavior !== 'deny') {
            if (!canUseTool || !parentAssistantMessage) {
              result = `sequence ${completed}/${steps.length} completed · a permission host is required for ${step.action}; run that act separately`
              outcome = 'failed'
              return finish()
            }
            decision = await canUseTool(ComputerTool, step, context, parentAssistantMessage, toolUseId)
          }
          if (decision.behavior !== 'allow') {
            result = `sequence ${completed}/${steps.length} completed · ${'message' in decision ? decision.message : 'permission not granted'}; nothing further done${lines.length ? `\n${lines.join('\n')}` : ''}`
            outcome = 'failed'
            return finish()
          }
          const judged = peekCheckedActApp(owner)
          const reads = ACT_ACTIONS.has(step.action) || permissionAction(step) === 'tree'
          const last = completed === steps.length - 1
          if (firstBefore === null) {
            let front = await driver.frontmostApplication()
            const back = front.ok && reads && judged !== null && judged.action === step.action ? await frontAfterCard(driver, judged, front.value, signal) : null
            if (back !== null) {
              front = { ok: true, value: back.front }
              lines.push(back.returned)
            }
            mayRead = reads || (front.ok && (appApproved(owner, front.value.identity) || readable.has(front.value.identity)))
            firstBefore = front.ok ? { app: front.value } : {}
            if (mayRead && front.ok) firstBefore = await readObservation(driver, signal, false, front.value.identity)
          } else if (!mayRead && reads) {
            mayRead = true
          }
          if (step.action === 'screenshot') {
            if (input.capture !== false) {
              const front = await driver.frontmostApplication()
              if (front.ok && isTerminalApplication(front.value) && !step.pixels && !(step.full ?? input.full) && step.display === undefined && (step.region ?? input.region) === undefined) {
                for (let at = 0; at < lines.length; at++) if (shotLines.has(lines[at]!)) lines[at] = SCREENSHOT_SUPERSEDED
                lines.push(await readTerminalText(driver, front.value, signal))
                contentShown = true
                imagePath = inlinePath = inlineMediaType = undefined
                screen = undefined
                completed++
                continue
              }
              const shot = await takeScreenshot(owner, driver, context, toolUseId, step.display, step.label, signal, step.region ?? input.region, 0, undefined, step.full ?? input.full, step.scale ?? input.scale, false, sameMessage)
              if (!shot.ok) {
                result = `sequence ${completed}/${steps.length} completed\n${lines.join('\n')}\n${shot.aborted ? interruptedText('screenshot') : shot.text}`
                outcome = 'failed'
                return finish()
              }
              adoptShot(shot)
              shotInSequence = true
              lines.push(shot.line)
              contentShown = true
            } else lines.push('screenshot step skipped (capture: false)')
            completed++
            continue
          }
          const answer = await ComputerTool.call(ACT_ACTIONS.has(step.action) ? { ...step, capture: false, settleMs: last ? input.settleMs : 0 } : step.action === 'wait' || step.action === 'focusApp' ? { ...step, capture: false } : step, context, canUseTool, parentAssistantMessage)
          const stepLines = answer.data.result.split('\n').filter(line => line !== WEB_CONTENT_NOTICE)
          contentShown ||= stepLines.length !== answer.data.result.split('\n').length
          afterState = stepLines.find(line => STATE_LINE.test(line)) ?? ''
          anyChanged ||= afterState.startsWith('changed · ')
          anyScrolled ||= stepLines.some(line => line.includes('scrolled into view first'))
          lines.push(stepLines.filter(line => !STATE_LINE.test(line)).join('\n'))
          if (answer.data.outcome !== 'succeeded') {
            result = `sequence ${completed}/${steps.length} completed\n${lines.join('\n')}`
            outcome = 'failed'
            return finish()
          }
          if (reads && judged !== null && judged.action === step.action) readable.add(judged.app.identity)
          completed++
        }
        outcome = 'succeeded'
        if (input.capture !== false && steps.at(-1)?.action !== 'screenshot') {
          imagePath = inlinePath = inlineMediaType = undefined
          screen = undefined
          const shot = await takeShot(undefined, input.label)
          if (shot.ok) {
            adoptShot(shot)
            lines.push(shot.line)
          } else {
            lines.push(shot.aborted ? interruptedAfterActText('sequence') : shot.text)
            if (shot.aborted) outcome = 'failed'
          }
        }
        if (!signal.aborted) {
          const before = firstBefore ?? {}
          const front = await driver.frontmostApplication()
          const after = mayRead && front.ok ? await readObservation(driver, signal, false, before.app?.identity ?? front.value.identity) : front.ok ? { app: front.value } : {}
          afterState = `${stateWord(before, after, anyChanged || observationChanged(before, after, !anyScrolled))} · ${treeObservation(after)}`
        }
        if (signal.aborted) {
          await driver.releaseAll()
          outcome = 'failed'
          afterState = ''
          lines.push(interruptedAfterActText('sequence'))
        }
        result = `sequence ${completed}/${steps.length} completed${afterState ? `\n${afterState}` : ''}\n${lines.join('\n')}`
        return finish()
      }
      if (input.action === 'focusApp') {
        outcome = 'failed'
        const checked = consumeCheckedAct(owner, input.action)
        if (!driver.findApplication || !driver.activateApplication) {
          result = 'focusApp is unavailable in this desktop driver'
          return finish()
        }
        const target = await driver.findApplication(input.focusApp!.name)
        if (!target.ok) { result = faultText('focusApp', target.error); return finish() }
        if (checked && checked.app.identity !== target.value.identity) {
          result = 'focusApp refused: the destination application changed since the permission check — re-issue'
          return finish()
        }
        const front = await driver.frontmostApplication()
        if (!front.ok) { result = faultText('focusApp', front.error); return finish() }
        if (!(await waitForOperatorPause(driver, signal))) {
          result = signal.aborted ? interruptedText('focusApp') : `focusApp refused: ${OPERATOR_TYPING_REFUSAL}`
          return finish()
        }
        const current = await driver.frontmostApplication()
        if (!current.ok || !sameWindow(current.value, front.value)) {
          result = 'focusApp refused: the front window changed before focus — re-issue'
          return finish()
        }
        if (await operatorIsTyping(driver)) { result = `focusApp refused: ${OPERATOR_TYPING_REFUSAL}`; return finish() }
        const claim = await claimDesktop(signal, target.value)
        if (!claim.held) { result = claim.aborted ? interruptedText('focusApp') : `computer refused: ${desktopClaimBusyNote(claim.holder)}`; return finish() }
        claimedForAct = true
        if (signal.aborted) { await driver.releaseAll(); result = interruptedText('focusApp'); return finish() }
        const ready = await driver.frontmostApplication()
        if (!ready.ok || !sameWindow(ready.value, front.value)) { result = 'focusApp refused: the front window changed before focus — re-issue'; return finish() }
        setDrivingApp(target.value)
        const activated = await driver.activateApplication(target.value, signal)
        if (!activated.ok) { result = activated.error.kind === 'aborted' ? interruptedText('focusApp') : faultText('focusApp', activated.error); return finish() }
        const after = await driver.frontmostApplication()
        if (signal.aborted) { await driver.releaseAll(); result = interruptedText('focusApp'); return finish() }
        if (!after.ok || after.value.identity !== target.value.identity || after.value.pid !== target.value.pid) {
          result = `focusApp failed: ${target.value.name} did not come to the front`
          return finish()
        }
        if (!checked?.viaGrant) approveApp(owner, target.value)
        result = `focusApp: ${applicationWords(after.value)}`
        if (input.capture === true) {
          const settleMs = clamp(input.settleMs ?? SETTLE_DEFAULT_MS, 0, SETTLE_CAP_MS)
          if (settleMs > 0) await sleep(settleMs, signal)
          const shot = await takeShot(undefined, input.label)
          if (shot.ok) { adoptShot(shot); result += `\n${shot.line}` } else result += `\n${shot.aborted ? interruptedAfterActText('focusApp') : shot.text}`
        }
        outcome = 'succeeded'
        return finish()
      }
      if (ACT_ACTIONS.has(input.action)) {
        if (signal.aborted) {
          result = interruptedText(input.action)
          outcome = 'failed'
          return finish()
        }
        const plan = planOf(owner, context, input, sameMessage)
        if (isPlanRefusal(plan)) {
          result = plan.refusal
          outcome = 'failed'
          return finish()
        }
        const challengeAnswered = peekCheckedActApp(owner)?.action === challengeAction(input.action)
        const checked = consumeCheckedAct(owner, challengeAnswered ? challengeAction(input.action) : input.action)
        const judged: DesktopJudgedApp | null = checked?.app ?? null
        const viaGrant = checked?.viaGrant === true
        let front = await driver.frontmostApplication()
        if (!front.ok) {
          result = faultText(input.action, front.error)
          outcome = 'failed'
          return finish()
        }
        let live: DesktopJudgedApp = { identity: front.value.identity, name: front.value.name }
        if (judged !== null && judged.identity !== live.identity) {
          const back = await frontAfterCard(driver, checked, front.value, signal)
          if (back === null) {
            result = `${input.action} refused: the screen moved from ${judged.name} (${judged.identity}) to ${live.name} (${live.identity}) between the permission check and the act — nothing done; take a screenshot and re-issue`
            outcome = 'failed'
            return finish()
          }
          front = { ok: true, value: back.front }
          live = { identity: back.front.identity, name: back.front.name }
          plan.returned = back.returned
        }
        const terminal = await ownTerminalRefusal(driver, input, front.value, plan)
        if (terminal !== null) {
          result = terminal
          outcome = 'failed'
          return finish()
        }
        for (let pass = 0; ; pass++) {
          let atAct = await driver.frontmostApplication()
          const afterCard = pass > 0 && atAct.ok ? await frontAfterCard(driver, { app: live, asked: true }, atAct.value, signal) : null
          if (afterCard !== null) {
            atAct = { ok: true, value: afterCard.front }
            plan.returned = afterCard.returned
          }
          if (!atAct.ok || atAct.value.identity !== front.value.identity || atAct.value.windowId !== front.value.windowId || JSON.stringify(atAct.value.bounds) !== JSON.stringify(front.value.bounds)) {
            result = `${input.action} refused: the front window changed before the act — nothing done; take a screenshot and re-issue`
            outcome = 'failed'
            return finish()
          }
          if (!(await waitForOperatorPause(driver, signal))) {
            if (signal.aborted) await driver.releaseAll()
            result = signal.aborted ? interruptedText(input.action) : `${input.action} refused: ${OPERATOR_TYPING_REFUSAL}`
            outcome = 'failed'
            return finish()
          }
          const targeting = await resolveActTargets(driver, input, front.value, plan, signal, owner, screenOf(owner))
          const resolvedTerminal = targeting === null ? await ownTerminalRefusal(driver, input, front.value, plan) : null
          if (targeting !== null || resolvedTerminal !== null) {
            result = targeting ?? resolvedTerminal!
            outcome = 'failed'
            return finish()
          }
          const challenge = await challengeRoad(ComputerTool, input, plan, front.value, context, canUseTool, parentAssistantMessage, toolUseId, challengeAnswered || pass > 0)
          if (challenge === 'asked') continue
          if (challenge !== null) {
            result = challenge
            outcome = 'failed'
            return finish()
          }
          break
        }
        if (await operatorIsTyping(driver)) {
          result = `${input.action} refused: ${OPERATOR_TYPING_REFUSAL}`
          outcome = 'failed'
          return finish()
        }
        const claim = await claimDesktop(signal, live)
        if (!claim.held) {
          result = claim.aborted === true ? interruptedText(input.action) : `computer refused: ${desktopClaimBusyNote(claim.holder)}`
          outcome = 'failed'
          return finish()
        }
        claimedForAct = true
        const ready = await driver.frontmostApplication()
        if (!ready.ok || !sameWindow(ready.value, front.value)) {
          result = `${input.action} refused: the front window changed before the act — nothing done; take a screenshot and re-issue`
          outcome = 'failed'
          return finish()
        }
        setDrivingApp(live)
        const unscrolled = (await scrollClippedEnds(driver, input, plan, ready.value, signal, screenOf(owner))) ?? (await settleActPoints(driver, input, plan, ready.value, signal, screenOf(owner)))
        if (unscrolled !== null) {
          await driver.releaseAll()
          result = unscrolled
          outcome = 'failed'
          return finish()
        }
        let act: ActWords
        try {
          act = await performAct(driver, input, plan, ready.value, signal)
        } catch (err) {
          await driver.releaseAll()
          throw err
        }
        if (!act.ok) {
          await driver.releaseAll()
          result = act.aborted ? interruptedText(input.action) : act.text
          outcome = 'failed'
          return finish()
        }
        if (!viaGrant) approveApp(owner, judged ?? live)
        outcome = 'succeeded'
        if (input.label) act.words += ` · ${input.label}`
        const settleMs = clamp(input.settleMs ?? SETTLE_DEFAULT_MS, 0, SETTLE_CAP_MS)
        const deadline = Date.now() + settleMs
        let shot: Shot | undefined
        if (input.capture === true) {
          shot = await takeShot(input.display, input.label, settleMs, input.region ? undefined : plan.observe)
          if (shot.ok) adoptShot(shot)
        }
        const { observation: after, changed } = await settledObservation(driver, { app: ready.value, tree: plan.beforeTree }, signal, shot ? 0 : Math.max(0, deadline - Date.now()), input.verify)
        if (signal.aborted || (shot && !shot.ok && shot.aborted)) {
          await driver.releaseAll()
          result = interruptedAfterActText(input.action)
          outcome = 'failed'
          return finish()
        }
        result = `${act.words} · ${shot ? shot.ok ? shot.line : shot.text : await factsLine(driver, screenOf(owner))}\n${stateWord({ app: ready.value, tree: plan.beforeTree }, after, changed)} · ${treeObservation(after)}`
        if (input.verify) {
          result += `\n${after.app && sameWindow(after.app, front.value) ? verificationWords(plan.beforeTree, after.tree) : 'verification: front window changed — read tree in the application now in front'}`
        }
        return finish()
      }
      const turnFront = await driver.frontmostApplication()
      if (turnFront.ok) noteTurnHome(owner, turnKeyOf(context), { identity: turnFront.value.identity, name: turnFront.value.name })
      switch (input.action) {
        case 'screenshot': {
          if (turnFront.ok && isTerminalApplication(turnFront.value) && !input.pixels && !input.full && input.display === undefined && input.region === undefined) {
            result = await readTerminalText(driver, turnFront.value, signal)
            outcome = 'succeeded'
            break
          }
          const shot = await takeShot(input.display, input.label)
          if (!shot.ok) {
            result = shot.aborted ? interruptedText('screenshot') : shot.text
            outcome = 'failed'
            break
          }
          adoptShot(shot)
          result = shot.line
          outcome = 'succeeded'
          break
        }
        case 'wait': {
          const pause = clamp(input.durationMs ?? (input.until !== undefined ? UNTIL_DEFAULT_MS : WAIT_DEFAULT_MS), 0, WAIT_CAP_MS)
          const waitStarted = Date.now()
          let metAfterMs = 0
          let waitNote = ''
          if (input.until !== undefined) {
            const checked = consumeCheckedAct(owner, 'wait')
            const back = turnFront.ok ? await frontAfterCard(driver, checked, turnFront.value, signal) : null
            if (!turnFront.ok || (back === null && checked !== null && checked.app.identity !== turnFront.value.identity)) {
              result = 'wait refused: the application changed since the permission check — re-issue for the application in front'
              outcome = 'failed'
              break
            }
            const app = back?.front ?? turnFront.value
            const returned = back ? ` · ${back.returned}` : ''
            const deadline = Date.now() + pause
            const waitingSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(pause))])
            let matched = false
            let lastSize: number | null = null
            let lastTree: DesktopTree | null = null
            while (!waitingSignal.aborted) {
              const before = await driver.frontmostApplication()
              if (!before.ok || !sameWindow(before.value, app)) {
                result = 'wait refused: the front window changed while waiting — re-issue'
                outcome = 'failed'
                return finish()
              }
              if (waitingSignal.aborted) break
              const tree = await driver.accessibilityTree(app, treeLimitsOf(input), waitingSignal)
              if (waitingSignal.aborted) break
              const after = await driver.frontmostApplication()
              if (waitingSignal.aborted) break
              if (!tree.ok || !after.ok || !sameWindow(after.value, app)) {
                result = !tree.ok ? faultText('wait', tree.error) : 'wait refused: the front window changed while reading — re-issue'
                outcome = 'failed'
                return finish()
              }
              if (checked?.viaGrant !== true) approveApp(owner, { identity: app.identity, name: app.name })
              lastTree = tree.value
              lastSize = tree.value.elements.length
              if (waitConditionPassed(input.until, after.value, tree.value)) { matched = true; break }
              if (Date.now() >= deadline) break
              await sleep(Math.min(100, Math.max(0, deadline - Date.now())), signal)
            }
            metAfterMs = Date.now() - waitStarted
            if (!matched) {
              result = signal.aborted ? interruptedText('wait') : `wait timed out after ${pause}ms: ${waitConditionWords(input.until)} · last tree: ${lastSize === null ? 'unavailable' : `${lastSize} elements`}${returned}${lastTree ? captchaLine(lastTree, app) : ''}`
              outcome = 'failed'
              break
            }
            waitNote = `${returned}${lastTree ? captchaLine(lastTree, app) : ''}`
          } else await sleep(pause, signal)
          if ((input.capture === false || (input.capture !== true && input.until === undefined)) && !signal.aborted) {
            result = `wait ${input.until ? `${waitConditionWords(input.until)} · met after ${metAfterMs}ms of ${pause}` : `${pause}ms`} · ${await factsLine(driver, screenOf(owner))}${waitNote}`
            outcome = 'succeeded'
            break
          }
          if (signal.aborted) {
            result = interruptedText('wait')
            outcome = 'failed'
            break
          }
          const shot = await takeShot(undefined, input.label)
          if (!shot.ok) {
            result = shot.aborted ? interruptedText('wait') : `wait ${input.until ? waitConditionWords(input.until) : `${pause}ms`} · ${shot.text}`
            outcome = 'failed'
            break
          }
          adoptShot(shot)
          result = `wait ${input.until ? `${waitConditionWords(input.until)} · met after ${metAfterMs}ms of ${pause}` : `${pause}ms`} · ${shot.line}${waitNote}`
          outcome = 'succeeded'
          break
        }
        case 'cursor': {
          const cursor = await driver.cursor()
          if (!cursor.ok) {
            result = faultText('cursor', cursor.error)
            outcome = 'failed'
            break
          }
          const map = screenOf(owner)
          const at = cursor.value
          const where = `(${at.x}, ${at.y}) pt${at.display !== null ? ` on display ${at.display}` : ''}`
          if (map !== null && (at.display === null || at.display === map.display)) {
            const pixel = pixelOfPoint(map, at)
            if (pixelOnScreen(map, pixel)) {
              result = `cursor (${pixel.x}, ${pixel.y}) px of the last screenshot · ${where}`
              outcome = 'succeeded'
              break
            }
          }
          result = map !== null ? `cursor ${where} — outside the last screenshot` : `cursor ${where} — no screenshot yet`
          outcome = 'succeeded'
          break
        }
        case 'displays': {
          const displays = await driver.displays()
          if (!displays.ok) {
            result = faultText('displays', displays.error)
            outcome = 'failed'
            break
          }
          const rows = displays.value.displays.map(
            d => `${d.index} — ${d.width}×${d.height} pt at (${d.originX}, ${d.originY}), scale ${d.scale}${d.primary ? ', primary' : ''}`,
          )
          result = rows.length > 0 ? `displays: ${rows.join(' · ')}` : 'displays: none attached'
          outcome = 'succeeded'
          break
        }
        case 'frontmost': {
          const front = await driver.frontmostApplication()
          if (!front.ok) {
            result = faultText('frontmost', front.error)
            outcome = 'failed'
            break
          }
          const app = front.value
          result = `frontmost: ${app.name} (${app.identity})${app.title ? ` — ${app.title}` : ''}`
          outcome = 'succeeded'
          break
        }
        case 'read': {
          outcome = 'failed'
          if (input.clipboard === true) {
            if (!driver.readClipboard) { result = 'read clipboard is unavailable in this desktop driver'; break }
            const clipboard = await driver.readClipboard(signal)
            if (!clipboard.ok) { result = faultText('read', clipboard.error); break }
            if (signal.aborted) { result = interruptedText('read'); break }
            result = readWords('clipboard', clipboard.value)
            outcome = 'succeeded'
            break
          }
          const checked = consumeCheckedAct(owner, input.action)
          if (!turnFront.ok) { result = faultText('read', turnFront.error); break }
          const back = await frontAfterCard(driver, checked, turnFront.value, signal)
          const app = back?.front ?? turnFront.value
          if (back === null && checked && checked.app.identity !== app.identity) { result = 'read refused: the application changed since the permission check — re-issue'; break }
          if (!driver.readElement) { result = 'read is unavailable in this desktop driver'; break }
          const tree = await driver.accessibilityTree(app, treeLimitsOf(input), signal)
          if (!tree.ok) { result = faultText('read', tree.error); break }
          const element = input.ref !== undefined ? readRefElement(owner, app, tree.value, input.ref, screenOf(owner)) : targetElement(tree.value, input.target!, screenOf(owner))
          if ('refusal' in element) { result = `read refused: ${element.refusal}`; break }
          const before = await driver.frontmostApplication()
          if (!before.ok || !sameWindow(before.value, app)) { result = 'read refused: the front window changed while reading — re-issue'; break }
          const sourceIndices = (element as DesktopTreeElement & { sourceIndices?: number[] }).sourceIndices
          let value: DesktopAnswer<import('../../services/desktop/driver.js').DesktopFocusedText | null>
          if (sourceIndices && sourceIndices.length > 1) {
            const texts: string[] = []
            let failure: DesktopError | undefined
            let truncated = false
            for (const index of sourceIndices) {
              const source = tree.value.elements[index]
              if (!source) { failure = { kind: 'input', note: 'the referenced text changed — read tree again' }; break }
              if ((source.title?.length ?? 0) < 300 && (source.value?.length ?? 0) < 300) texts.push([source.title, source.value !== source.title ? source.value : null].filter(Boolean).join(' '))
              else {
                const full = await driver.readElement(app, source, signal)
                if (!full.ok || !full.value) { failure = full.ok ? { kind: 'input', note: 'the referenced text has no readable value' } : full.error; break }
                texts.push(full.value.text)
                truncated ||= full.value.truncated === true
              }
            }
            value = failure ? { ok: false, error: failure } : { ok: true, value: { text: texts.join(' '), title: element.title, role: element.role, truncated } }
          } else value = await driver.readElement(app, withOrdinal(tree.value, element), signal)
          if (!value.ok) { result = faultText('read', value.error); break }
          const after = await driver.frontmostApplication()
          if (signal.aborted) { result = interruptedText('read'); break }
          if (!after.ok || !sameWindow(after.value, app)) { result = 'read refused: the front window changed while reading — re-issue'; break }
          if (value.value === null) { result = 'read failed: the element has no readable text or value'; break }
          if (!checked?.viaGrant) approveApp(owner, app)
          result = `${readWords(JSON.stringify(value.value.title ?? element.title ?? value.value.role), value.value.text, value.value.truncated)}${back ? `\n${back.returned}` : ''}${captchaLine(tree.value, app)}`
          outcome = 'succeeded'
          break
        }
        case 'find':
        case 'fields':
        case 'tree': {
          const checked = consumeCheckedAct(owner, input.action)
          const judged: DesktopJudgedApp | null = checked?.app ?? null
          if (!turnFront.ok) {
            result = faultText('tree', turnFront.error)
            outcome = 'failed'
            break
          }
          const back = await frontAfterCard(driver, checked, turnFront.value, signal)
          const app = back?.front ?? turnFront.value
          if (back === null && judged !== null && judged.identity !== app.identity) {
            result = `tree refused: the screen moved from ${judged.name} (${judged.identity}) to ${app.name} (${app.identity}) between the permission check and the read — nothing read; re-issue`
            outcome = 'failed'
            break
          }
          const limits = treeLimitsOf(input)
          const tree = await driver.accessibilityTree(app, limits, signal)
          if (!tree.ok) {
            result = tree.error.kind === 'aborted' ? interruptedText('tree') : faultText('tree', tree.error)
            outcome = 'failed'
            break
          }
          const after = await driver.frontmostApplication()
          if (!after.ok || !sameWindow(after.value, app)) {
            result = `${input.action} refused: the front window changed while reading — re-issue`
            outcome = 'failed'
            break
          }
          if (checked?.viaGrant !== true) approveApp(owner, judged ?? { identity: app.identity, name: app.name })
          const keptLimits = { depth: input.depth ?? TREE_DEPTH_DEFAULT, count: input.limit ?? TREE_LIMIT_DEFAULT }
          let root: DesktopTree['elements'][number] | undefined
          if (input.root !== undefined) {
            const selected = typeof input.root === 'number' ? targetElement({ ...tree.value, elements: resolveTreeRef(owner, app, tree.value, input.root) }, {}) : targetMatches(tree.value, input.root).length === 0 ? { refusal: `${targetWords(input.root)}: 0 matches — read tree or take a screenshot${pageContentNote(app, tree.value) ? `\n${pageContentNote(app, tree.value)}` : ''}` } : targetElement(tree.value, input.root, screenOf(owner))
            if ('refusal' in selected) {
              result = `${input.action} refused: ${typeof input.root === 'number' ? `ref:${input.root}` : ''}${selected.refusal}`
              outcome = 'failed'
              break
            }
            root = selected
          }
          const outlined = outlineTree(tree.value, app.bounds, { all: input.all, root, ...(input.action === 'tree' ? keptLimits : { depth: TREE_DEPTH_CAP, count: TREE_LIMIT_CAP }) })
          let shown = outlined
          if (input.action !== 'tree') {
            const matches = (input.action === 'find' ? targetMatches(outlined, input.target!) : outlined.elements.filter(element => FIELD_ROLES.test(element.role))) as DesktopOutline['elements']
            const depth = input.action === 'find' ? keptLimits.depth : (input.depth ?? TREE_DEPTH_CAP)
            const elements = matches.filter(element => element.depth <= depth).slice(0, keptLimits.count)
            shown = { ...outlined, elements, truncated: outlined.truncated || elements.length !== matches.length, reason: elements.length !== matches.length ? `the limit of ${keptLimits.count} elements or depth ${depth}` : outlined.reason }
          }
          rememberTreeRefs(owner, app, tree.value, shown)
          result = input.action === 'tree' && !input.pixels && input.root === undefined && input.scope !== 'app' && isTerminalApplication(app) ? await readTerminalText(driver, app, signal, tree.value) : input.action === 'fields' ? fieldsWords(app, shown, keptLimits, screenOf(owner), input.points === true) : treeWords(app, shown, keptLimits, screenOf(owner), input.points === true)
          settleChallenge(String(getSessionId()), app, treeSight(tree.value, app.bounds) === 'challenge')
          result += `${back ? `\n${back.returned}` : ''}${captchaLine(tree.value, app)}`
          outcome = 'succeeded'
          break
        }
        default: {
          result = `${input.action} is not an action of this tool`
          outcome = 'failed'
        }
      }
    } catch (err) {
      const e = err as Error
      result = e.name === 'AbortError' || signal.aborted ? interruptedText(input.action) : `${input.action} failed: ${faultNote(e.message)}`
      outcome = 'failed'
    }
    return finish()

    function finish() {
      if (outcome === 'failed' && imagePath !== undefined) {
        result = result!.split('\n').map(line => (shotLines.has(line) ? SCREENSHOT_NOT_RETURNED : line)).join('\n')
        imagePath = inlinePath = inlineMediaType = undefined
        screen = undefined
      }
      if (imagePath && screen) setScreen(owner, screen)
      if (claimedForAct && !signal.aborted) renewDesktopClaim()
      const clamps = ([['depth', TREE_DEPTH_CAP], ['limit', TREE_LIMIT_CAP]] as const).filter(([field, cap]) => (input[field] ?? 0) > cap).map(([field, cap]) => `${field} ${input[field]} → ${cap}`)
      const text = result! + (clamps.length && outcome === 'succeeded' ? `\nclamped: ${clamps.join('; ')}` : '')
      const noted = imagePath !== undefined || contentShown || (outcome === 'succeeded' && carriesScreenContent(input, false))
      const output: Output = {
        action: input.action,
        result: noted ? `${WEB_CONTENT_NOTICE}\n${text}` : text,
        outcome,
        ...(imagePath !== undefined && { imagePath }),
        ...(inlinePath !== undefined && { inlinePath }),
        ...(inlineMediaType !== undefined && { inlineMediaType }),
        ...(screen !== undefined && { screen }),
      }
      return {
        data: output,
        effect: {
          outcome,
          operation: `computer.${input.action}`,
          changedPaths: imagePath ? [imagePath] : [],
          evidence: text.split('\n')[0]?.slice(0, 160) ?? '',
          startedAt,
          completedAt: Date.now(),
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    if (output.imagePath && modelReceivesImageBlocks(getEngineModel())) {
      try {
        const bytes = readFileSync(output.inlinePath ?? output.imagePath)
        const mediaType = (output.inlinePath ? (output.inlineMediaType ?? 'image/png') : 'image/png') as 'image/png'
        return {
          tool_use_id: toolUseId,
          type: 'tool_result' as const,
          content: [
            { type: 'text' as const, text: output.result },
            {
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: mediaType, data: bytes.toString('base64') },
            },
          ],
        }
      } catch {
        return { tool_use_id: toolUseId, type: 'tool_result' as const, content: output.result }
      }
    }
    const text =
      output.imagePath && !modelReceivesImageBlocks(getEngineModel())
        ? `${output.result}\n(image not inlined — this model takes no image input; open the file to view it)`
        : output.result
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: text,
    }
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  extractSearchText({ result }) {
    return result
  },
})
