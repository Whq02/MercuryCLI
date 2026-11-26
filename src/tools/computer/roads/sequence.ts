import { isTerminalApplication, readTerminalText } from '../terminalText.js'
import { WEB_CONTENT_NOTICE } from '../../shell/webContent.js'
import type { PermissionDecision } from '../../../permissions/rules/permissions.js'
import { appApproved, peekCheckedActApp, screenOf } from '../../../integrations/desktop/desktopSession.js'
import { type DesktopObservation, STATE_LINE, observationChanged, readObservation, stateWord, treeObservation } from '../fastRoad.js'
import { ACT_ACTIONS, type Input, SCREENSHOT_SUPERSEDED, SCREENSHOT_UNSEEN, definitelyTakesImage, permissionAction, usesScreenshotPixels } from '../call/schema.js'
import { frontAfterCard } from '../call/plan.js'
import { interruptedAfterActText, interruptedText } from '../call/words.js'
import { takeScreenshot } from '../call/shot.js'
import type { ScreenMap } from '../screenMap.js'
import type { ComputerAnswer, RoadNeeds } from './needs.js'

async function preflightUnseenScreenshot(driver: RoadNeeds['driver'], input: Input, steps: Input[]): Promise<Input | null> {
  const first = steps[0]
  if (first?.action !== 'screenshot') return null
  const bad = steps.slice(1).find(usesScreenshotPixels)
  if (!bad) return null
  if (definitelyTakesImage(first, input) || process.platform !== 'darwin') return bad
  const front = await driver.frontmostApplication()
  return front.ok && !isTerminalApplication(front.value) ? bad : null
}

export async function sequenceRoad({ run, input, context, owner, signal, toolUseId, sameMessage, driver, canUseTool, parentAssistantMessage, adoptShot, shotLines, finish, ComputerTool }: RoadNeeds, steps: Input[]): Promise<ComputerAnswer> {
  const preflight = await preflightUnseenScreenshot(driver, input, steps)
  if (preflight !== null) {
    run.result = `sequence 0/${steps.length} completed · ${preflight.action} refused: ${SCREENSHOT_UNSEEN}; nothing further done`
    run.outcome = 'failed'
    return finish()
  }
  const lines: string[] = []
  let completed = 0
  let afterState = ''
  let anyChanged = false
  let anyScrolled = false
  let firstBefore: DesktopObservation | null = null
  let mayRead = false
  let shotInSequence = false
  let lastShotScreen: ScreenMap | null = screenOf(owner)
  const readable = new Set<string>()
  for (const step of steps) {
    if (signal.aborted) {
      await driver.releaseAll()
      run.result = `sequence ${completed}/${steps.length} completed · ${interruptedText('sequence')}${lines.length ? `\n${lines.join('\n')}` : ''}`
      run.outcome = 'failed'
      return finish()
    }
    if (shotInSequence && usesScreenshotPixels(step)) {
      run.result = `sequence ${completed}/${steps.length} completed · ${step.action} refused: ${SCREENSHOT_UNSEEN}; nothing further done\n${lines.join('\n')}`
      run.outcome = 'failed'
      return finish()
    }
    let decision: PermissionDecision = await ComputerTool.checkPermissions(step, context)
    if (decision.behavior !== 'deny') {
      if (!canUseTool || !parentAssistantMessage) {
        run.result = `sequence ${completed}/${steps.length} completed · a permission host is required for ${step.action}; run that act separately`
        run.outcome = 'failed'
        return finish()
      }
      decision = await canUseTool(ComputerTool, step, context, parentAssistantMessage, toolUseId)
    }
    if (decision.behavior !== 'allow') {
      run.result = `sequence ${completed}/${steps.length} completed · ${'message' in decision ? decision.message : 'permission not granted'}; nothing further done${lines.length ? `\n${lines.join('\n')}` : ''}`
      run.outcome = 'failed'
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
      const front = await driver.frontmostApplication()
      if (front.ok && isTerminalApplication(front.value) && !step.pixels && !(step.full ?? input.full) && step.display === undefined && (step.region ?? input.region) === undefined) {
        for (let at = 0; at < lines.length; at++) if (shotLines.has(lines[at]!)) lines[at] = SCREENSHOT_SUPERSEDED
        lines.push(await readTerminalText(driver, front.value, signal))
        run.contentShown = true
        run.imagePath = run.inlinePath = run.inlineMediaType = undefined
        run.screen = undefined
        lastShotScreen = screenOf(owner)
        completed++
        continue
      }
      const shot = await takeScreenshot(owner, driver, context, toolUseId, step.display, step.label, signal, step.region ?? input.region, 0, undefined, step.full ?? input.full, step.scale ?? input.scale, false, sameMessage, lastShotScreen)
      if (!shot.ok) {
        run.result = `sequence ${completed}/${steps.length} completed${lines.length ? `\n${lines.join('\n')}` : ''}\n${shot.aborted ? interruptedText('screenshot') : shot.text}`
        run.outcome = 'failed'
        return finish()
      }
      adoptShot(shot)
      lastShotScreen = shot.screen
      shotInSequence = true
      lines.push(shot.line)
      run.contentShown = true
      completed++
      continue
    }
    const answer = await ComputerTool.call(ACT_ACTIONS.has(step.action) ? { ...step, capture: false, settleMs: last ? input.settleMs : 0 } : step.action === 'wait' || step.action === 'focusApp' ? { ...step, capture: false } : step, context, canUseTool, parentAssistantMessage)
    const stepLines = answer.data.result.split('\n').filter(line => line !== WEB_CONTENT_NOTICE)
    run.contentShown ||= stepLines.length !== answer.data.result.split('\n').length
    afterState = stepLines.find(line => STATE_LINE.test(line)) ?? ''
    anyChanged ||= afterState.startsWith('changed · ')
    anyScrolled ||= stepLines.some(line => line.includes('scrolled into view first'))
    lines.push(stepLines.filter(line => !STATE_LINE.test(line)).join('\n'))
    if (answer.data.outcome !== 'succeeded') {
      run.result = `sequence ${completed}/${steps.length} completed\n${lines.join('\n')}`
      run.outcome = 'failed'
      return finish()
    }
    if (reads && judged !== null && judged.action === step.action) readable.add(judged.app.identity)
    completed++
  }
  run.outcome = 'succeeded'
  if (input.capture !== false && steps.at(-1)?.action !== 'screenshot') {
    const shot = await takeScreenshot(owner, driver, context, toolUseId, undefined, input.label, signal, input.region, 0, undefined, input.full, input.scale, false, sameMessage, lastShotScreen)
    if (shot.ok) {
      adoptShot(shot)
      lastShotScreen = shot.screen
      lines.push(shot.line)
    } else {
      lines.push(shot.aborted ? interruptedAfterActText('sequence') : shot.text)
      if (shot.aborted) run.outcome = 'failed'
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
    run.outcome = 'failed'
    afterState = ''
    lines.push(interruptedAfterActText('sequence'))
  }
  run.result = `sequence ${completed}/${steps.length} completed${afterState ? `\n${afterState}` : ''}\n${lines.join('\n')}`
  return finish()
}
