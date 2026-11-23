import type { DesktopAnswer, DesktopApplication, DesktopError, DesktopTreeElement } from '../../../integrations/desktop/driver.js'
import { approveApp, consumeCheckedAct, screenOf } from '../../../integrations/desktop/desktopSession.js'
import { sameWindow, targetElement, withOrdinal } from '../fastRoad.js'
import { captchaLine, frontAfterCard } from '../call/plan.js'
import { faultText } from '../call/act.js'
import { interruptedText, readRefElement, readWords, treeLimitsOf } from '../call/words.js'
import type { RoadNeeds } from './needs.js'

export async function readRoad({ run, input, owner, signal, driver }: RoadNeeds, checked: ReturnType<typeof consumeCheckedAct>, turnFront: Extract<DesktopAnswer<DesktopApplication>, { ok: true }>): Promise<void> {
  const back = await frontAfterCard(driver, checked, turnFront.value, signal)
  const app = back?.front ?? turnFront.value
  if (back === null && checked && checked.app.identity !== app.identity) { run.result = 'read refused: the application changed since the permission check — re-issue'; return }
  if (!driver.readElement) { run.result = 'read is unavailable in this desktop driver'; return }
  const tree = await driver.accessibilityTree(app, treeLimitsOf(input), signal)
  if (!tree.ok) { run.result = faultText('read', tree.error); return }
  const element = input.ref !== undefined ? readRefElement(owner, app, tree.value, input.ref, screenOf(owner)) : targetElement(tree.value, input.target!, screenOf(owner))
  if ('refusal' in element) { run.result = `read refused: ${element.refusal}`; return }
  const before = await driver.frontmostApplication()
  if (!before.ok || !sameWindow(before.value, app)) { run.result = 'read refused: the front window changed while reading — re-issue'; return }
  const sourceIndices = (element as DesktopTreeElement & { sourceIndices?: number[] }).sourceIndices
  let value: DesktopAnswer<import('../../../integrations/desktop/driver.js').DesktopFocusedText | null>
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
  if (!value.ok) { run.result = faultText('read', value.error); return }
  const after = await driver.frontmostApplication()
  if (signal.aborted) { run.result = interruptedText('read'); return }
  if (!after.ok || !sameWindow(after.value, app)) { run.result = 'read refused: the front window changed while reading — re-issue'; return }
  if (value.value === null) { run.result = 'read failed: the element has no readable text or value'; return }
  if (!checked?.viaGrant) approveApp(owner, app)
  run.result = `${readWords(JSON.stringify(value.value.title ?? element.title ?? value.value.role), value.value.text, value.value.truncated)}${back ? `\n${back.returned}` : ''}${captchaLine(tree.value, app)}`
  run.outcome = 'succeeded'
  return
}
