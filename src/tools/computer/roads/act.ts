import { sleep } from '../../../platform/async/sleep.js'
import {
  type DesktopJudgedApp,
  approveApp,
  consumeCheckedAct,
  screenOf,
  setDrivingApp,
} from '../../../integrations/desktop/desktopSession.js'
import { claimDesktop, desktopClaimBusyNote } from '../../../integrations/desktop/desktopClaim.js'
import { sameWindow, settledObservation, stateWord, treeObservation, verificationWords } from '../fastRoad.js'
import { OPERATOR_TYPING_REFUSAL, operatorIsTyping, waitForOperatorPause } from '../operatorPause.js'
import { SETTLE_CAP_MS, SETTLE_DEFAULT_MS, clamp } from '../call/schema.js'
import {
  type ActPlan,
  challengeRoad,
  frontAfterCard,
  ownTerminalRefusal,
  resolveActTargets,
  scrollClippedEnds,
  settleActPoints,
} from '../call/plan.js'
import { type ActWords, faultText, performAct } from '../call/act.js'
import { factsLine, interruptedAfterActText, interruptedText } from '../call/words.js'
import type { Shot } from '../call/shot.js'
import type { ComputerAnswer, RoadNeeds } from './needs.js'

export async function actRoad({ run, input, context, owner, signal, toolUseId, driver, canUseTool, parentAssistantMessage, takeShot, adoptShot, finish, ComputerTool }: RoadNeeds, plan: ActPlan, challengeAnswered: boolean, checked: ReturnType<typeof consumeCheckedAct>, judged: DesktopJudgedApp | null, viaGrant: boolean, inSequence = false): Promise<ComputerAnswer> {
  let front = await driver.frontmostApplication()
  if (!front.ok) {
    run.result = faultText(input.action, front.error)
    run.outcome = 'failed'
    return finish()
  }
  let live: DesktopJudgedApp = { identity: front.value.identity, name: front.value.name }
  if (judged !== null && judged.identity !== live.identity) {
    const back = await frontAfterCard(driver, checked, front.value, signal)
    if (back === null) {
      run.result = `${input.action} refused: the screen moved from ${judged.name} (${judged.identity}) to ${live.name} (${live.identity}) between the permission check and the act — nothing done; take a screenshot and re-issue`
      run.outcome = 'failed'
      return finish()
    }
    front = { ok: true, value: back.front }
    live = { identity: back.front.identity, name: back.front.name }
    plan.returned = back.returned
  }
  const terminal = await ownTerminalRefusal(driver, input, front.value, plan)
  if (terminal !== null) {
    run.result = terminal
    run.outcome = 'failed'
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
      run.result = `${input.action} refused: the front window changed before the act — nothing done; take a screenshot and re-issue`
      run.outcome = 'failed'
      return finish()
    }
    if (!(await waitForOperatorPause(driver, signal))) {
      if (signal.aborted) await driver.releaseAll()
      run.result = signal.aborted ? interruptedText(input.action) : `${input.action} refused: ${OPERATOR_TYPING_REFUSAL}`
      run.outcome = 'failed'
      return finish()
    }
    const targeting = await resolveActTargets(driver, input, front.value, plan, signal, owner, screenOf(owner))
    const resolvedTerminal = targeting === null ? await ownTerminalRefusal(driver, input, front.value, plan) : null
    if (targeting !== null || resolvedTerminal !== null) {
      run.result = targeting ?? resolvedTerminal!
      run.outcome = 'failed'
      return finish()
    }
    const challenge = await challengeRoad(ComputerTool, input, plan, front.value, context, canUseTool, parentAssistantMessage, toolUseId, challengeAnswered || pass > 0)
    if (challenge === 'asked') continue
    if (challenge !== null) {
      run.result = challenge
      run.outcome = 'failed'
      return finish()
    }
    break
  }
  if (await operatorIsTyping(driver)) {
    run.result = `${input.action} refused: ${OPERATOR_TYPING_REFUSAL}`
    run.outcome = 'failed'
    return finish()
  }
  const claim = await claimDesktop(signal, live)
  if (!claim.held) {
    run.result = claim.aborted === true ? interruptedText(input.action) : `computer refused: ${desktopClaimBusyNote(claim.holder)}`
    run.outcome = 'failed'
    return finish()
  }
  run.claimedForAct = true
  const ready = await driver.frontmostApplication()
  if (!ready.ok || !sameWindow(ready.value, front.value)) {
    run.result = `${input.action} refused: the front window changed before the act — nothing done; take a screenshot and re-issue`
    run.outcome = 'failed'
    return finish()
  }
  setDrivingApp(live)
  const unscrolled = (await scrollClippedEnds(driver, input, plan, ready.value, signal, screenOf(owner))) ?? (await settleActPoints(driver, input, plan, ready.value, signal, screenOf(owner)))
  if (unscrolled !== null) {
    await driver.releaseAll()
    run.result = unscrolled
    run.outcome = 'failed'
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
    run.result = act.aborted ? interruptedText(input.action) : act.text
    run.outcome = 'failed'
    return finish()
  }
  if (!viaGrant) approveApp(owner, judged ?? live)
  run.outcome = 'succeeded'
  if (input.label) act.words += ` · ${input.label}`
  const settleMs = clamp(input.settleMs ?? SETTLE_DEFAULT_MS, 0, SETTLE_CAP_MS)
  if (inSequence && !input.verify && input.capture !== true) {
    if (settleMs > 0) await sleep(settleMs, signal)
    if (signal.aborted) {
      await driver.releaseAll()
      run.result = interruptedAfterActText(input.action)
      run.outcome = 'failed'
      return finish()
    }
    run.result = `${act.words} · ${await factsLine(driver, screenOf(owner))}`
    return finish()
  }
  const deadline = Date.now() + settleMs
  let shot: Shot | undefined
  if (input.capture === true) {
    shot = await takeShot(input.display, input.label, settleMs, input.region ? undefined : plan.observe)
    if (shot.ok) adoptShot(shot)
  }
  const { observation: after, changed } = await settledObservation(driver, { app: ready.value, tree: plan.beforeTree }, signal, shot ? 0 : Math.max(0, deadline - Date.now()), input.verify)
  if (signal.aborted || (shot && !shot.ok && shot.aborted)) {
    await driver.releaseAll()
    run.result = interruptedAfterActText(input.action)
    run.outcome = 'failed'
    return finish()
  }
  run.result = `${act.words} · ${shot ? shot.ok ? shot.line : shot.text : await factsLine(driver, screenOf(owner))}\n${stateWord({ app: ready.value, tree: plan.beforeTree }, after, changed)} · ${treeObservation(after)}`
  if (input.verify) {
    run.result += `\n${after.app && sameWindow(after.app, front.value) ? verificationWords(plan.beforeTree, after.tree) : 'verification: front window changed — read tree in the application now in front'}`
  }
  return finish()
}
