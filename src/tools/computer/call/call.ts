import type { CanUseToolFn, ToolEffect, ToolUseContext } from '../../kit/tool.js'
import { readTerminalText, wantsTerminalText } from '../terminalText.js'
import { WEB_CONTENT_NOTICE } from '../../shell/webContent.js'
import { pollUntil } from '../../../platform/async/deadline.js'
import { sleep } from '../../../platform/async/sleep.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { rememberDesktopPermissions, resolveDesktopDriver } from '../../../integrations/desktop/resolveDriver.js'
import type { DesktopBounds, DesktopTree } from '../../../integrations/desktop/driver.js'
import {
  type DesktopJudgedApp,
  approveApp,
  consumeCheckedAct,
  desktopPostureRefusal,
  noteTurnHome,
  peekCheckedActApp,
  screenOf,
  setScreen,
  turnKeyOf,
} from '../../../integrations/desktop/desktopSession.js'
import { renewDesktopClaim } from '../../../integrations/desktop/desktopClaim.js'
import type { AssistantMessage } from '../../../engine/message-shapes/message.js'
import { regionRefusal, sameWindow } from '../fastRoad.js'
import { waitConditionPassed, waitConditionWords } from '../waitCondition.js'
import {
  ACT_ACTIONS,
  type Input,
  type Output,
  SCREENSHOT_NOT_RETURNED,
  TREE_DEPTH_CAP,
  TREE_LIMIT_CAP,
  UNTIL_DEFAULT_MS,
  WAIT_CAP_MS,
  WAIT_DEFAULT_MS,
  carriesScreenContent,
  clamp,
  inputSchema,
  tableRefusal,
} from './schema.js'
import { captchaLine, challengeAction, frontAfterCard, isPlanRefusal, planOf } from './plan.js'
import { faultNote, faultText } from './act.js'
import { factsLine, interruptedText, readWords, treeLimitsOf } from './words.js'
import { type Shot, takeScreenshot, toolUseIdOfParent, toolUseIdsOfParent } from './shot.js'
import type { CallRun, ComputerAnswer, ComputerDoor, FocusDriver, RoadNeeds } from '../roads/needs.js'
import { sequenceRoad } from '../roads/sequence.js'
import { focusAppRoad } from '../roads/focusApp.js'
import { actRoad } from '../roads/act.js'
import { readRoad } from '../roads/read.js'
import { treeRoad } from '../roads/tree.js'
import { cursorRoad, displaysRoad, frontmostRoad } from '../roads/facts.js'

export async function computerCall(ComputerTool: ComputerDoor, input: Input, context: ToolUseContext, canUseTool?: CanUseToolFn, parentAssistantMessage?: AssistantMessage, inSequence = false): Promise<{ data: Output; effect: ToolEffect }> {
  const startedAt = Date.now()
  const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
  const signal = context.abortController?.signal ?? new AbortController().signal
  const toolUseId = context.toolUseId ?? toolUseIdOfParent(parentAssistantMessage) ?? ''
  const sameMessage: ReadonlySet<string> = new Set(toolUseIdsOfParent(parentAssistantMessage))
  const run: CallRun = { outcome: 'no-change', claimedForAct: false, contentShown: false }
  const posture = desktopPostureRefusal(context)
  if (posture !== null) {
    run.result = `policy denial: ${posture}`
    run.outcome = 'failed'
    return finish()
  }
  const resolution = resolveDesktopDriver()
  if (resolution.state === 'unavailable') {
    run.result = `no desktop driver: ${resolution.note}${resolution.remedy ? ` — ${resolution.remedy}` : ''}`
    run.outcome = 'failed'
    return finish()
  }
  const driver = resolution.driver
  if (!inSequence) {
    const permissions = await driver.permissions()
    if (permissions.ok) rememberDesktopPermissions(permissions.value)
  }
  const takeShot = (wanted: number | undefined, label: string | undefined, settleMs = 0, observe?: DesktopBounds): Promise<Shot> =>
    takeScreenshot(owner, driver, context, toolUseId, wanted, label, signal, input.region, settleMs, observe, input.full, input.scale, true, sameMessage)
  const shotLines = new Set<string>()
  const omittedShots: Array<{ line: string; imagePath: string }> = []
  let activeShotLine: string | undefined
  const adoptShot = (shot: Extract<Shot, { ok: true }>): void => {
    if (run.imagePath !== undefined && activeShotLine !== undefined) {
      omittedShots.push({ line: activeShotLine, imagePath: run.imagePath })
    }
    run.imagePath = shot.imagePath
    run.inlinePath = shot.inlinePath
    run.inlineMediaType = shot.inlineMediaType
    run.screen = shot.screen
    activeShotLine = shot.line
    shotLines.add(shot.line)
  }
  const runStep = (step: Input): Promise<ComputerAnswer> => computerCall(ComputerTool, step, context, canUseTool, parentAssistantMessage, true)
  const needs: RoadNeeds = { run, input, context, owner, signal, toolUseId, sameMessage, driver, canUseTool, parentAssistantMessage, takeShot, adoptShot, shotLines, finish, runStep, ComputerTool }
  try {
    const invalid = inSequence ? null : tableRefusal(input)
    const badRegion = input.region === undefined ? null : regionRefusal(input.region, screenOf(owner))
    if (invalid !== null || badRegion !== null) {
      run.result = invalid ?? badRegion!
      run.outcome = 'failed'
      return finish()
    }
    if (input.action === 'sequence') {
      const steps = input.steps!.map(step => inputSchema().parse(step))
      return await sequenceRoad(needs, steps)
    }
    if (input.action === 'focusApp') {
      run.outcome = 'failed'
      const checked = consumeCheckedAct(owner, input.action)
      if (!driver.findApplication || !driver.activateApplication) {
        run.result = 'focusApp is unavailable in this desktop driver'
        return finish()
      }
      return await focusAppRoad(needs, driver as FocusDriver, checked)
    }
    if (ACT_ACTIONS.has(input.action)) {
      if (signal.aborted) {
        run.result = interruptedText(input.action)
        run.outcome = 'failed'
        return finish()
      }
      const plan = planOf(owner, context, input, sameMessage)
      if (isPlanRefusal(plan)) {
        run.result = plan.refusal
        run.outcome = 'failed'
        return finish()
      }
      const challengeAnswered = peekCheckedActApp(owner)?.action === challengeAction(input.action)
      const checked = consumeCheckedAct(owner, challengeAnswered ? challengeAction(input.action) : input.action)
      const judged: DesktopJudgedApp | null = checked?.app ?? null
      const viaGrant = checked?.viaGrant === true
      return await actRoad(needs, plan, challengeAnswered, checked, judged, viaGrant, inSequence)
    }
    const turnFront = await driver.frontmostApplication()
    if (turnFront.ok) noteTurnHome(owner, turnKeyOf(context), { identity: turnFront.value.identity, name: turnFront.value.name })
    switch (input.action) {
      case 'screenshot': {
        if (turnFront.ok && wantsTerminalText(turnFront.value, input)) {
          run.result = await readTerminalText(driver, turnFront.value, signal)
          run.outcome = 'succeeded'
          break
        }
        const shot = await takeShot(input.display, input.label)
        if (!shot.ok) {
          run.result = shot.aborted ? interruptedText('screenshot') : shot.text
          run.outcome = 'failed'
          break
        }
        adoptShot(shot)
        run.result = shot.line
        run.outcome = 'succeeded'
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
            run.result = 'wait refused: the application changed since the permission check — re-issue for the application in front'
            run.outcome = 'failed'
            break
          }
          const app = back?.front ?? turnFront.value
          const returned = back ? ` · ${back.returned}` : ''
          const waitingSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(pause))])
          let lastSize: number | null = null
          let lastTree: DesktopTree | null = null
          const waitOutcome = await pollUntil<'matched' | 'refused' | 'stopped', 'stopped', 'stopped'>(
            async () => {
              const before = await driver.frontmostApplication()
              if (!before.ok || !sameWindow(before.value, app)) {
                run.result = 'wait refused: the front window changed while waiting — re-issue'
                run.outcome = 'failed'
                return 'refused'
              }
              if (waitingSignal.aborted) return 'stopped'
              const tree = await driver.accessibilityTree(app, treeLimitsOf(input), waitingSignal)
              if (waitingSignal.aborted) return 'stopped'
              const after = await driver.frontmostApplication()
              if (waitingSignal.aborted) return 'stopped'
              if (!tree.ok || !after.ok || !sameWindow(after.value, app)) {
                run.result = !tree.ok ? faultText('wait', tree.error) : 'wait refused: the front window changed while reading — re-issue'
                run.outcome = 'failed'
                return 'refused'
              }
              if (checked?.viaGrant !== true) approveApp(owner, { identity: app.identity, name: app.name })
              lastTree = tree.value
              lastSize = tree.value.elements.length
              if (waitConditionPassed(input.until!, after.value, tree.value)) return 'matched'
              return undefined
            },
            left => Math.min(100, left),
            pause,
            () => 'stopped',
            { signal: waitingSignal, onAbort: () => 'stopped' },
          )
          if (waitOutcome === 'refused') return finish()
          const matched = waitOutcome === 'matched'
          metAfterMs = Date.now() - waitStarted
          if (!matched) {
            run.result = signal.aborted ? interruptedText('wait') : `wait timed out after ${pause}ms: ${waitConditionWords(input.until)} · last tree: ${lastSize === null ? 'unavailable' : `${lastSize} elements`}${returned}${lastTree ? captchaLine(lastTree, app) : ''}`
            run.outcome = 'failed'
            break
          }
          waitNote = `${returned}${lastTree ? captchaLine(lastTree, app) : ''}`
        } else await sleep(pause, signal)
        if ((input.capture === false || (input.capture !== true && input.until === undefined)) && !signal.aborted) {
          run.result = `wait ${input.until ? `${waitConditionWords(input.until)} · met after ${metAfterMs}ms of ${pause}` : `${pause}ms`} · ${await factsLine(driver, screenOf(owner))}${waitNote}`
          run.outcome = 'succeeded'
          break
        }
        if (signal.aborted) {
          run.result = interruptedText('wait')
          run.outcome = 'failed'
          break
        }
        const shot = await takeShot(undefined, input.label)
        if (!shot.ok) {
          run.result = shot.aborted ? interruptedText('wait') : `wait ${input.until ? waitConditionWords(input.until) : `${pause}ms`} · ${shot.text}`
          run.outcome = 'failed'
          break
        }
        adoptShot(shot)
        run.result = `wait ${input.until ? `${waitConditionWords(input.until)} · met after ${metAfterMs}ms of ${pause}` : `${pause}ms`} · ${shot.line}${waitNote}`
        run.outcome = 'succeeded'
        break
      }
      case 'cursor': {
        await cursorRoad(needs)
        break
      }
      case 'displays': {
        await displaysRoad(needs)
        break
      }
      case 'frontmost': {
        await frontmostRoad(needs)
        break
      }
      case 'read': {
        run.outcome = 'failed'
        if (input.clipboard === true) {
          if (!driver.readClipboard) { run.result = 'read clipboard is unavailable in this desktop driver'; break }
          const clipboard = await driver.readClipboard(signal)
          if (!clipboard.ok) { run.result = faultText('read', clipboard.error); break }
          if (signal.aborted) { run.result = interruptedText('read'); break }
          run.result = readWords('clipboard', clipboard.value)
          run.outcome = 'succeeded'
          break
        }
        const checked = consumeCheckedAct(owner, input.action)
        if (!turnFront.ok) { run.result = faultText('read', turnFront.error); break }
        await readRoad(needs, checked, turnFront)
        break
      }
      case 'find':
      case 'fields':
      case 'tree': {
        const checked = consumeCheckedAct(owner, input.action)
        const judged: DesktopJudgedApp | null = checked?.app ?? null
        if (!turnFront.ok) {
          run.result = faultText('tree', turnFront.error)
          run.outcome = 'failed'
          break
        }
        await treeRoad(needs, checked, judged, turnFront)
        break
      }
      default: {
        run.result = `${input.action} is not an action of this tool`
        run.outcome = 'failed'
      }
    }
  } catch (err) {
    const e = err as Error
    run.result = e.name === 'AbortError' || signal.aborted ? interruptedText(input.action) : `${input.action} failed: ${faultNote(e.message)}`
    run.outcome = 'failed'
  }
  return finish()

  function finish() {
    if (run.outcome === 'failed' && run.imagePath !== undefined) {
      run.result = run.result!.split('\n').map(line => (shotLines.has(line) ? SCREENSHOT_NOT_RETURNED : line)).join('\n')
      run.imagePath = run.inlinePath = run.inlineMediaType = undefined
      run.screen = undefined
    }
    const { outcome, imagePath, inlinePath, inlineMediaType, screen, claimedForAct, contentShown } = run
    let result = run.result!
    const keptOmitted: Array<{ line: string; imagePath: string }> = []
    if (outcome === 'succeeded' && imagePath !== undefined && omittedShots.length > 0) {
      const resultLines = result.split('\n')
      const byLine = new Map(omittedShots.map(shot => [shot.line, shot]))
      result = resultLines.map(line => {
        const omitted = byLine.get(line)
        if (!omitted) return line
        keptOmitted.push(omitted)
        return `screenshot saved at ${omitted.imagePath} (not returned in this answer — only the last screenshot travels; use Read on that path to view it)`
      }).join('\n')
      if (keptOmitted.length > 0) {
        result += `\nimages: 1 of ${keptOmitted.length + 1} returned (only the last screenshot travels; ${keptOmitted.length} earlier saved to disk — see paths above); coordinates now refer to ${imagePath}`
      }
    }
    if (imagePath && screen) setScreen(owner, screen)
    if (claimedForAct && !signal.aborted) renewDesktopClaim()
    const clamps = ([['depth', TREE_DEPTH_CAP], ['limit', TREE_LIMIT_CAP]] as const).filter(([field, cap]) => (input[field] ?? 0) > cap).map(([field, cap]) => `${field} ${input[field]} → ${cap}`)
    const text = result + (clamps.length && outcome === 'succeeded' ? `\nclamped: ${clamps.join('; ')}` : '')
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
        changedPaths: imagePath ? [...keptOmitted.map(shot => shot.imagePath), imagePath] : [],
        evidence: text.split('\n')[0]?.slice(0, 160) ?? '',
        startedAt,
        completedAt: Date.now(),
      },
    }
  }
}
