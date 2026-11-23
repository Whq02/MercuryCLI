import { isTerminalApplication, readTerminalText } from '../terminalText.js'
import type { DesktopAnswer, DesktopApplication, DesktopTree } from '../../../integrations/desktop/driver.js'
import { type DesktopJudgedApp, approveApp, consumeCheckedAct, screenOf } from '../../../integrations/desktop/desktopSession.js'
import { settleChallenge } from '../../../integrations/desktop/computerGrant.js'
import { getSessionId } from '../../../boot/process-state/processState.js'
import { type DesktopOutline, outlineTree, rememberTreeRefs, resolveTreeRef } from '../screenMap.js'
import { pageContentNote, sameWindow, targetElement, targetMatches, targetWords } from '../fastRoad.js'
import { treeSight } from '../captcha.js'
import { FIELD_ROLES, TREE_DEPTH_CAP, TREE_DEPTH_DEFAULT, TREE_LIMIT_CAP, TREE_LIMIT_DEFAULT } from '../call/schema.js'
import { captchaLine, frontAfterCard } from '../call/plan.js'
import { faultText } from '../call/act.js'
import { fieldsWords, interruptedText, treeLimitsOf, treeWords } from '../call/words.js'
import type { RoadNeeds } from './needs.js'

export async function treeRoad({ run, input, owner, signal, driver }: RoadNeeds, checked: ReturnType<typeof consumeCheckedAct>, judged: DesktopJudgedApp | null, turnFront: Extract<DesktopAnswer<DesktopApplication>, { ok: true }>): Promise<void> {
  const back = await frontAfterCard(driver, checked, turnFront.value, signal)
  const app = back?.front ?? turnFront.value
  if (back === null && judged !== null && judged.identity !== app.identity) {
    run.result = `tree refused: the screen moved from ${judged.name} (${judged.identity}) to ${app.name} (${app.identity}) between the permission check and the read — nothing read; re-issue`
    run.outcome = 'failed'
    return
  }
  const limits = treeLimitsOf(input)
  const tree = await driver.accessibilityTree(app, limits, signal)
  if (!tree.ok) {
    run.result = tree.error.kind === 'aborted' ? interruptedText('tree') : faultText('tree', tree.error)
    run.outcome = 'failed'
    return
  }
  const after = await driver.frontmostApplication()
  if (!after.ok || !sameWindow(after.value, app)) {
    run.result = `${input.action} refused: the front window changed while reading — re-issue`
    run.outcome = 'failed'
    return
  }
  if (checked?.viaGrant !== true) approveApp(owner, judged ?? { identity: app.identity, name: app.name })
  const keptLimits = { depth: input.depth ?? TREE_DEPTH_DEFAULT, count: input.limit ?? TREE_LIMIT_DEFAULT }
  let root: DesktopTree['elements'][number] | undefined
  if (input.root !== undefined) {
    const selected = typeof input.root === 'number' ? targetElement({ ...tree.value, elements: resolveTreeRef(owner, app, tree.value, input.root) }, {}) : targetMatches(tree.value, input.root).length === 0 ? { refusal: `${targetWords(input.root)}: 0 matches — read tree or take a screenshot${pageContentNote(app, tree.value) ? `\n${pageContentNote(app, tree.value)}` : ''}` } : targetElement(tree.value, input.root, screenOf(owner))
    if ('refusal' in selected) {
      run.result = `${input.action} refused: ${typeof input.root === 'number' ? `ref:${input.root}` : ''}${selected.refusal}`
      run.outcome = 'failed'
      return
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
  run.result = input.action === 'tree' && !input.pixels && input.root === undefined && input.scope !== 'app' && isTerminalApplication(app) ? await readTerminalText(driver, app, signal, tree.value) : input.action === 'fields' ? fieldsWords(app, shown, keptLimits, screenOf(owner), input.points === true) : treeWords(app, shown, keptLimits, screenOf(owner), input.points === true)
  settleChallenge(String(getSessionId()), app, treeSight(tree.value, app.bounds) === 'challenge')
  run.result += `${back ? `\n${back.returned}` : ''}${captchaLine(tree.value, app)}`
  run.outcome = 'succeeded'
  return
}
