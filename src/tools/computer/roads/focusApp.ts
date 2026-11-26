import { sleep } from '../../../platform/async/sleep.js'
import { approveApp, consumeCheckedAct, setDrivingApp } from '../../../integrations/desktop/desktopSession.js'
import { claimDesktop, desktopClaimBusyNote } from '../../../integrations/desktop/desktopClaim.js'
import { sameWindow } from '../fastRoad.js'
import { readTerminalText, wantsTerminalText } from '../terminalText.js'
import { OPERATOR_TYPING_REFUSAL, operatorIsTyping, waitForOperatorPause } from '../operatorPause.js'
import { SETTLE_CAP_MS, SETTLE_DEFAULT_MS, clamp } from '../call/schema.js'
import { faultText } from '../call/act.js'
import { applicationWords, interruptedAfterActText, interruptedText } from '../call/words.js'
import type { ComputerAnswer, FocusDriver, RoadNeeds } from './needs.js'

export async function focusAppRoad({ run, input, owner, signal, takeShot, adoptShot, finish }: RoadNeeds, driver: FocusDriver, checked: ReturnType<typeof consumeCheckedAct>): Promise<ComputerAnswer> {
  const target = await driver.findApplication(input.focusApp!.name)
  if (!target.ok) { run.result = faultText('focusApp', target.error); return finish() }
  if (checked && checked.app.identity !== target.value.identity) {
    run.result = 'focusApp refused: the destination application changed since the permission check — re-issue'
    return finish()
  }
  const front = await driver.frontmostApplication()
  if (!front.ok) { run.result = faultText('focusApp', front.error); return finish() }
  if (signal.aborted) { run.result = interruptedText('focusApp'); return finish() }
  const alreadyFront =
    front.value.identity === target.value.identity &&
    front.value.pid !== null &&
    front.value.pid === target.value.pid &&
    (target.value.windowId == null || front.value.windowId === target.value.windowId)
  let focused = front.value
  if (!alreadyFront) {
    if (!(await waitForOperatorPause(driver, signal))) {
      run.result = signal.aborted ? interruptedText('focusApp') : `focusApp refused: ${OPERATOR_TYPING_REFUSAL}`
      return finish()
    }
    const current = await driver.frontmostApplication()
    if (!current.ok || !sameWindow(current.value, front.value)) {
      run.result = 'focusApp refused: the front window changed before focus — re-issue'
      return finish()
    }
    if (await operatorIsTyping(driver)) { run.result = `focusApp refused: ${OPERATOR_TYPING_REFUSAL}`; return finish() }
    const claim = await claimDesktop(signal, target.value)
    if (!claim.held) { run.result = claim.aborted ? interruptedText('focusApp') : `computer refused: ${desktopClaimBusyNote(claim.holder)}`; return finish() }
    run.claimedForAct = true
    if (signal.aborted) { await driver.releaseAll(); run.result = interruptedText('focusApp'); return finish() }
    const ready = await driver.frontmostApplication()
    if (!ready.ok || !sameWindow(ready.value, front.value)) { run.result = 'focusApp refused: the front window changed before focus — re-issue'; return finish() }
    setDrivingApp(target.value)
    const activated = await driver.activateApplication(target.value, signal)
    if (!activated.ok) { run.result = activated.error.kind === 'aborted' ? interruptedText('focusApp') : faultText('focusApp', activated.error); return finish() }
    const after = await driver.frontmostApplication()
    if (signal.aborted) { await driver.releaseAll(); run.result = interruptedText('focusApp'); return finish() }
    if (!after.ok || after.value.identity !== target.value.identity || after.value.pid !== target.value.pid) {
      run.result = `focusApp failed: ${target.value.name} did not come to the front`
      return finish()
    }
    focused = after.value
  }
  if (!checked?.viaGrant) approveApp(owner, target.value)
  run.result = `focusApp: ${applicationWords(focused)}`
  if (input.capture === true) {
    const settleMs = clamp(input.settleMs ?? (alreadyFront ? 0 : SETTLE_DEFAULT_MS), 0, SETTLE_CAP_MS)
    if (settleMs > 0) await sleep(settleMs, signal)
    if (signal.aborted) { run.result = interruptedAfterActText('focusApp'); return finish() }
    if (wantsTerminalText(focused, input)) {
      run.result += `\n${await readTerminalText(driver, focused, signal)}`
      run.contentShown = true
    } else {
      const shot = await takeShot(undefined, input.label)
      if (shot.ok) { adoptShot(shot); run.result += `\n${shot.line}` } else {
        run.result += `\n${shot.aborted ? interruptedAfterActText('focusApp') : shot.text}`
        if (shot.aborted) return finish()
      }
    }
  }
  run.outcome = 'succeeded'
  return finish()
}
