import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, ROOT, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'
import type { PermissionDecision } from '../../src/types/permissions.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const scratch = scratchDir('captcha')
const bounds = { x: 0, y: 30, width: 1920, height: 956 }
const chrome = { identity: 'com.example.Browser', name: 'Browser', pid: 4242, windowId: 'careers', title: 'Job application — Example Careers', bounds }
const field = (title: string, y: number) => ({ role: 'AXTextField', title, frame: { x: 400, y, width: 500, height: 32 } })
const badge = (attributed: boolean) => ({ role: 'AXGroup', title: 'reCAPTCHA', frame: { x: 1650, y: 912, width: 256, height: 60 }, children: [
  { role: 'AXGroup', title: 'reCAPTCHA', frame: { x: 1650, y: 912, width: 256, height: 60 }, children: attributed ? [
    { role: 'AXStaticText', title: 'protected by ', frame: { x: 1660, y: 920, width: 80, height: 20 } },
    { role: 'AXStaticText', title: 'reCAPTCHA', frame: { x: 1740, y: 920, width: 80, height: 20 } },
  ] : [] },
] })
const checkbox = (visible = true) => ({ role: 'AXCheckBox', title: "I'm not a robot", frame: visible ? { x: 400, y: 700, width: 304, height: 78 } : { x: 400, y: 700, width: 0, height: 0 } })
const page = (...extra: Record<string, unknown>[]) => [{ role: 'AXWindow', title: chrome.title, focused: true, frame: bounds, children: [
  { role: 'AXWebArea', title: chrome.title, frame: { x: 0, y: 120, width: 1920, height: 866 }, children: [field('First Name', 300), field('Last Name', 360), field('Email', 420), ...extra] },
] }]
const DO_NOT_TRY = /do not try|must complete|never solves/i
let scenes = 0
async function scene(name: string, tree: unknown, title = chrome.title) {
  const path = join(scratch, `${++scenes}-${name}.json`)
  writeFileSync(path, JSON.stringify({ displays: [{ index: 0, id: 'careers', originX: 0, originY: 0, width: 1920, height: 1080, scale: 2, primary: true }], frontmost: { ...chrome, title, windowId: `${name}-${scenes}` }, cursor: { x: 50, y: 50 }, lines: ['Careers'], tree }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = path
  resetDesktopDriverForTest()
  const resolved = resolveDesktopDriver()
  if (resolved.state !== 'ok') throw new Error(resolved.note)
  const driver = resolved.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
  const base = toolContext()
  session.forgetDesktopOwner(ownerOf(base))
  const shot = await withScreenshot(ComputerTool as never, base, `captcha-${scenes}`)
  return { driver, context: shot.context, clicks: () => driver.acts.filter(a => a.act === 'click').length }
}
let serial = 0
const call = async (context: ReturnType<typeof toolContext>, input: Record<string, unknown>, consent: unknown = allowEverything) => resultOf(await ComputerTool.call(input as never, context, (consent === null ? undefined : consent) as never, toolUseTurn(`captcha-act-${++serial}`, 'Computer', input) as never))
const firstName = { x: 325, y: 143 }
const { CAPTCHA_OPERATOR_COMPLETES } = await import('../../src/tools/ComputerTool/captcha.ts')
const { REJECT_MESSAGE_WITH_REASON_PREFIX } = await import('../../src/utils/messages/rejectionText.ts')
const grants = await import('../../src/services/desktop/computerGrant.ts')
const { unansweredAskRefusal } = await import('../../src/utils/permissions/askClock.ts')
const hostOf = (asks: PermissionDecision[], answer: () => 'allow' | 'deny' | 'expired', onAnswer: () => void = () => undefined) => (async (_tool: unknown, input: unknown, _context: unknown, _parent: unknown, _id: unknown, forced?: PermissionDecision) => {
  if (forced) asks.push(forced)
  onAnswer()
  const verdict = answer()
  if (verdict === 'allow') return { behavior: 'allow', updatedInput: input }
  if (verdict === 'deny') return { behavior: 'ask', message: `${REJECT_MESSAGE_WITH_REASON_PREFIX}${CAPTCHA_OPERATOR_COMPLETES}` }
  return { behavior: 'deny', message: unansweredAskRefusal('Computer', 60_000), decisionReason: { type: 'other', reason: unansweredAskRefusal('Computer', 60_000) } }
}) as never
const treeReads = (driver: DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }, from: number) => driver.acts.slice(from).filter(a => a.act === 'accessibilityTree').map(a => `${a.detail.count}/${a.detail.depth}`)

section('§1 a brand word alone never refuses: a reCAPTCHA group without its attribution (the badge road that stopped a job form cold)')
{
  const { context, clicks } = await scene('brand-only', page(badge(false)))
  const clicked = await call(context, { action: 'click', ...firstName, capture: false })
  check('an untargeted click on the form goes through beside an unattributed reCAPTCHA group', clicked.outcome === 'succeeded' && clicks() === 1 && !/refused/.test(clicked.result), clicked.result)
  const targeted = await call(context, { action: 'click', target: { role: 'AXTextField', name: 'Last Name' }, capture: false })
  check('a targeted click goes through too', targeted.outcome === 'succeeded' && clicks() === 2, targeted.result)
  const typed = await call(context, { action: 'type', text: 'Jane', capture: false })
  check('typing goes through', typed.outcome === 'succeeded', typed.result)
  const tree = await call(context, { action: 'tree' })
  check('tree succeeds and carries one note that the page has a captcha widget', tree.outcome === 'succeeded' && tree.result.includes('AXTextField "Email"') && (tree.result.match(/captcha widget/g)?.length ?? 0) === 1 && !/refused/.test(tree.result), tree.result)
  const read = await call(context, { action: 'read', target: { role: 'AXTextField', name: 'Email' } })
  check('read is never refused for a brand word', read.outcome === 'succeeded', read.result)
  const waited = await call(context, { action: 'wait', until: { role: 'AXTextField', name: 'Email' }, durationMs: 300, capture: false })
  check('wait-until is never refused for a brand word', waited.outcome === 'succeeded', waited.result)
  for (const [label, out] of [['click', clicked], ['tree', tree], ['read', read], ['wait', waited]] as const) check(`${label}: no result tells the model not to try`, !DO_NOT_TRY.test(out.result), out.result)
}

section('§2 the attributed badge and other brand words behave the same')
{
  const { context, clicks } = await scene('attributed', page(badge(true)))
  const clicked = await call(context, { action: 'click', ...firstName, capture: false })
  check('the attributed badge never refused and still does not', clicked.outcome === 'succeeded' && clicks() === 1, clicked.result)
  for (const marker of ['hCaptcha', 'Turnstile', 'captcha']) {
    const brand = await scene(marker, page({ role: 'AXGroup', title: marker, frame: { x: 100, y: 800, width: 250, height: 100 } }))
    const out = await call(brand.context, { action: 'click', ...firstName, capture: false })
    check(`${marker}: a brand group of any size is a note, not a refusal`, out.outcome === 'succeeded' && brand.clicks() === 1, out.result)
  }
}

section("§3 a visible challenge is the operator's question: complete it yourself, or let Mercury try (the owner's rule)")
{
  const asks: PermissionDecision[] = []
  let answer: 'allow' | 'deny' | 'expired' = 'allow'
  const host = hostOf(asks, () => answer)
  const { context, clicks, driver } = await scene('challenge', page(badge(true), checkbox()))
  const asked = await call(context, { action: 'click', ...firstName, capture: false }, host)
  const ask = asks[0]
  check('the first act on a visible "I\'m not a robot" asks the operator once', asks.length === 1 && ask?.behavior === 'ask', JSON.stringify(asks))
  check('the question offers both roads: complete it yourself, or let Mercury try', ask?.behavior === 'ask' && /complete it yourself/i.test(ask.message) && /try/i.test(ask.message) && /challenge/i.test(ask.message), ask?.behavior === 'ask' ? ask.message : JSON.stringify(ask))
  check('the question is operator-only and offers the pre-given rule', ask?.behavior === 'ask' && ask.decisionReason?.type === 'safetyCheck' && ask.decisionReason.operatorOnly === true && JSON.stringify(ask.suggestions ?? []).includes('captcha'), JSON.stringify(ask))
  check("on the operator's yes the act is sent", asked.outcome === 'succeeded' && clicks() === 1, asked.result)
  const again = await call(context, { action: 'click', ...firstName, capture: false }, host)
  check('the grant holds for the window: the next act asks no more', again.outcome === 'succeeded' && asks.length === 1 && clicks() === 2, again.result)
  const sequence = await call(context, { action: 'sequence', steps: [{ action: 'click', target: { role: 'AXCheckBox', name: "I'm not a robot" } }, { action: 'wait', durationMs: 0 }], capture: false, settleMs: 0 }, host)
  check('a sequence step on the challenge itself runs under the same grant', sequence.outcome === 'succeeded' && sequence.result.includes('2/2') && asks.length === 1, sequence.result)
  const tree = await call(context, { action: 'tree' })
  check('tree names the challenge and the grant, never a refusal', tree.outcome === 'succeeded' && /challenge/i.test(tree.result) && /allowed/i.test(tree.result) && !DO_NOT_TRY.test(tree.result), tree.result)
  const originalTree = driver.accessibilityTree.bind(driver)
  let gone = true
  driver.accessibilityTree = async (...args) => {
    const answer = await originalTree(...args)
    if (answer.ok && gone) answer.value.elements = answer.value.elements.filter(element => element.role !== 'AXCheckBox')
    return answer
  }
  const after = await call(context, { action: 'click', ...firstName, capture: false }, host)
  check('with the challenge gone the act runs and the grant ends', after.outcome === 'succeeded' && asks.length === 1, after.result)
  gone = false
  const back = await call(context, { action: 'click', ...firstName, capture: false }, host)
  check('a challenge that returns asks again', back.outcome === 'succeeded' && asks.length === 2, back.result)
  driver.accessibilityTree = originalTree
  answer = 'deny'
  grants.clearChallengeGrants?.()
  const before = clicks()
  const declined = await call(context, { action: 'click', ...firstName, capture: false }, host)
  check("on the operator's no the act is not sent and the sentence names the road back", declined.outcome === 'failed' && clicks() === before && /complete it themselves/i.test(declined.result) && /re-issue/i.test(declined.result) && !DO_NOT_TRY.test(declined.result), declined.result)
  answer = 'expired'
  const unanswered = await call(context, { action: 'click', ...firstName, capture: false }, host)
  check("the ask clock's own refusal is reported with its cause, the guidance sentence cut, naming the rule for an unattended run", unanswered.outcome === 'failed' && clicks() === before && unanswered.result.includes('nobody answered the permission ask within') && unanswered.result.includes('Computer(captcha)') && !DO_NOT_TRY.test(unanswered.result) && !/wait for the operator/.test(unanswered.result) && !/complete it themselves/.test(unanswered.result), unanswered.result)
  const { createRuleOnlyAsks } = await import('../../src/cli/headless/runnerAsks.ts')
  const ruleOnly = await call(context, { action: 'click', ...firstName, capture: false }, createRuleOnlyAsks().createCanUseTool())
  check('a run with no permission host hands the question back unanswered: the result says no one answered, never the question itself', ruleOnly.outcome === 'failed' && clicks() === before && ruleOnly.result.includes('no one answered the challenge question') && ruleOnly.result.includes('Computer(captcha)') && !ruleOnly.result.includes('complete it yourself') && !DO_NOT_TRY.test(ruleOnly.result), ruleOnly.result)
  const alone = await call(context, { action: 'click', ...firstName, capture: false }, null)
  check('without a permission host the sentence names captcha: true', alone.outcome === 'failed' && clicks() === before && /captcha: true/.test(alone.result) && !DO_NOT_TRY.test(alone.result), alone.result)
  const read = await call(context, { action: 'read', target: { role: 'AXTextField', name: 'Email' } })
  const waited = await call(context, { action: 'wait', until: { role: 'AXTextField', name: 'Email' }, durationMs: 300, capture: false })
  check('read and wait-until are reads: never refused on a challenge', read.outcome === 'succeeded' && waited.outcome === 'succeeded' && !DO_NOT_TRY.test(read.result + waited.result), `${read.result}\n${waited.result}`)
}

section("§4 the pre-given rule, the deny rule and the sovereign posture need no question; the model's own captcha: true asks at once")
{
  const asks: PermissionDecision[] = []
  const host = hostOf(asks, () => 'allow')
  const ruled = await scene('allow-rule', page(badge(true), checkbox()))
  const allowContext = toolContext({ allow: ['Computer(captcha)'], messages: ruled.context.messages })
  const allowed = await call(allowContext, { action: 'click', ...firstName, capture: false }, host)
  check('a Computer(captcha) allow rule is the pre-given answer: no question, the act runs', allowed.outcome === 'succeeded' && asks.length === 0 && ruled.clicks() === 1, allowed.result)
  const denied = await scene('deny-rule', page(badge(true), checkbox()))
  const denyContext = toolContext({ deny: ['Computer(captcha)'], messages: denied.context.messages })
  const refused = await call(denyContext, { action: 'click', ...firstName, capture: false }, host)
  check('a deny rule is a sentence naming the rule, not silence', refused.outcome === 'failed' && asks.length === 0 && denied.clicks() === 0 && /denied by the rule Computer\(captcha\)/.test(refused.result) && /re-issue/i.test(refused.result), refused.result)
  const sovereign = await scene('sovereign', page(badge(true), checkbox()))
  const sovereignContext = toolContext({ messages: sovereign.context.messages })
  Object.assign(sovereignContext.getAppState().toolPermissionContext, { mode: 'sovereign', isBypassPermissionsModeAvailable: true })
  const bypassed = await call(sovereignContext, { action: 'click', ...firstName, capture: false }, host)
  check('under the sovereign posture the ask stands down as every safety ask does', bypassed.outcome === 'succeeded' && asks.length === 0 && sovereign.clicks() === 1, bypassed.result)
  const pixels = await scene('pixels-only', page(badge(true)))
  const flagged = await call(pixels.context, { action: 'click', ...firstName, captcha: true, capture: false }, host)
  check('captcha: true on an act asks at once even when the tree shows no challenge (a challenge seen in pixels)', flagged.outcome === 'succeeded' && asks.length === 1 && asks[0]?.behavior === 'ask' && pixels.clicks() === 1, flagged.result)
  const next = await call(pixels.context, { action: 'click', ...firstName, capture: false }, host)
  check('that grant holds for the window until it runs out: the next act asks no more', next.outcome === 'succeeded' && asks.length === 1, next.result)
  const hidden = await scene('hidden', page(badge(true), checkbox(false)))
  const unseen = await call(hidden.context, { action: 'click', ...firstName, capture: false }, host)
  check('a challenge element with no visible frame asks nothing', unseen.outcome === 'succeeded' && asks.length === 1 && hidden.clicks() === 1, unseen.result)
  const strip = await scene('strip', page(badge(true), { role: 'AXCheckBox', title: "I'm not a robot", frame: { x: 400, y: 985, width: 304, height: 1 } }))
  const belowFold = await call(strip.context, { action: 'click', ...firstName, capture: false }, host)
  check('a challenge below the fold (the 1 pt strip a browser reports) is not on screen and asks nothing', belowFold.outcome === 'succeeded' && asks.length === 1 && strip.clicks() === 1, belowFold.result)
  const frameless = await scene('frameless', page(badge(true), { role: 'AXCheckBox', title: "I'm not a robot" }))
  const noFrame = await call(frameless.context, { action: 'click', ...firstName, capture: false }, host)
  check('a challenge element without a frame asks nothing', noFrame.outcome === 'succeeded' && asks.length === 1 && frameless.clicks() === 1, noFrame.result)
  const titled = await scene('title', page(badge(true)), 'Verify you are human')
  const byTitle = await call(titled.context, { action: 'click', ...firstName, capture: false }, host)
  check('a challenge phrase in the window title asks', byTitle.outcome === 'succeeded' && asks.length === 2, byTitle.result)
  grants.grantChallenge?.(String((await import('../../src/bootstrap/state.ts')).getSessionId()), { identity: chrome.identity, windowId: `title-${scenes}`, title: 'Verify you are human' }, true)
  const outranked = toolContext({ deny: ['Computer(captcha)'], messages: titled.context.messages })
  const lateDeny = await call(outranked, { action: 'click', ...firstName, capture: false }, host)
  check('a deny rule outranks a live grant', lateDeny.outcome === 'failed' && /denied by the rule Computer\(captcha\)/.test(lateDeny.result), lateDeny.result)
}

section('§4b the act road reads the tree in two stages: the cheap read first, the whole tree only when a brand word is in it')
{
  const plain = await scene('plain', page())
  let from = plain.driver.acts.length
  await call(plain.context, { action: 'click', ...firstName, capture: false })
  check('an untargeted act on a page without a captcha word reads the cheap tree once', treeReads(plain.driver, from).filter(limits => limits === '400/12').length === 1 && !treeReads(plain.driver, from).includes('2000/32'), treeReads(plain.driver, from).join(','))
  const branded = await scene('branded', page(badge(true)))
  from = branded.driver.acts.length
  await call(branded.context, { action: 'click', ...firstName, capture: false })
  check('a brand word in the cheap read brings the whole read, so a challenge past the cheap read is seen', treeReads(branded.driver, from).slice(0, 2).join(',') === '400/12,2000/32', treeReads(branded.driver, from).join(','))
  from = branded.driver.acts.length
  await call(branded.context, { action: 'click', target: { role: 'AXTextField', name: 'Email' }, capture: false })
  check('a targeted act reads the whole tree once as before', treeReads(branded.driver, from)[0] === '2000/32' && !treeReads(branded.driver, from).slice(1).includes('2000/32'), treeReads(branded.driver, from).join(','))
}

section("§4c the card's answer: the typing check and the targets run again after it, No carries feedback and ends no turn")
{
  const asks: PermissionDecision[] = []
  let answeredAt = 0
  const host = hostOf(asks, () => 'allow', () => { answeredAt = Date.now() })
  const { context, clicks, driver } = await scene('after-card', page(badge(true), checkbox()))
  driver.keyboardIdleMs = async () => (answeredAt === 0 ? null : Date.now() - answeredAt)
  const from = driver.acts.length
  const started = Date.now()
  const after = await call(context, { action: 'click', ...firstName, capture: false }, host)
  const reads = treeReads(driver, from)
  check('the Enter that answered the card is operator typing: the act waits it out instead of refusing', after.outcome === 'succeeded' && clicks() === 1 && Date.now() - started >= 1_300, `${after.result} after ${Date.now() - started}ms`)
  const kinds = driver.acts.slice(from).map(a => a.act)
  check('the targets are resolved again after the card, before the act', asks.length === 1 && kinds.slice(0, kinds.indexOf('click')).filter(kind => kind === 'accessibilityTree').length >= 2, `${reads.join(',')} · ${kinds.join(',')}`)
  const { createPermissionContext, createPermissionQueueOps } = await import('../../src/hooks/toolPermission/PermissionContext.ts')
  const { handleInteractivePermission } = await import('../../src/hooks/toolPermission/handlers/interactiveHandler.ts')
  const queue: Array<{ onReject: (feedback?: string) => void }> = []
  const askContext = toolContext({ messages: context.messages })
  const parent = toolUseTurn('captcha-card', 'Computer', { action: 'click', ...firstName })
  const ctx = createPermissionContext(ComputerTool as never, { action: 'click', ...firstName, captcha: true }, askContext, parent as never, 'captcha-card', () => undefined, createPermissionQueueOps(updater => { queue.splice(0, queue.length, ...(updater(queue as never) as never)) }))
  const decision = await new Promise<PermissionDecision>(resolve => {
    handleInteractivePermission({ ctx, description: 'Computer', result: (asks[0] ?? { behavior: 'ask', message: 'the challenge question' }) as never, awaitAutomatedChecksBeforeDialog: false, channelCallbacks: undefined } as never, resolve)
    setTimeout(() => queue[0]?.onReject(CAPTCHA_OPERATOR_COMPLETES), 10)
  })
  check('No on the card answers with the resume sentence as feedback and leaves the turn running', !askContext.abortController.signal.aborted && decision.behavior === 'ask' && 'message' in decision && decision.message.includes(CAPTCHA_OPERATOR_COMPLETES), JSON.stringify(decision))
}

section('§4d the challenge is its own permission subject: checkPermissions answers it after the application, and the card is keyed on the harness, not the input')
{
  const { context, clicks } = await scene('subject', page(badge(true), checkbox()))
  const owner = ownerOf(context)
  const first = await ComputerTool.checkPermissions({ action: 'click', ...firstName, captcha: true, capture: false } as never, context)
  check('a first act in an application with captcha: true gets the application question, not the challenge card', first.behavior === 'ask' && JSON.stringify(first.suggestions ?? []).includes('app:') && !JSON.stringify(first.suggestions ?? []).includes('"captcha"'), JSON.stringify(first))
  session.approveApp(owner, { identity: 'com.example.Browser', name: 'Browser' })
  const subject = await ComputerTool.checkPermissions({ action: 'click', ...firstName, captcha: true, capture: false } as never, context)
  check('once the application is approved, captcha: true gets the challenge question from the engine itself', subject.behavior === 'ask' && JSON.stringify(subject.suggestions ?? []).includes('"captcha"') && subject.decisionReason?.type === 'safetyCheck' && subject.decisionReason.operatorOnly === true && /complete it yourself/.test('message' in subject ? subject.message : ''), JSON.stringify(subject))
  const recheck = await ComputerTool.checkPermissions({ action: 'click', ...firstName, captcha: true, capture: false } as never, context)
  check('a permission re-check cannot answer the pending question: the engine asks again until the operator or a rule answers', recheck.behavior === 'ask' && JSON.stringify(recheck.suggestions ?? []).includes('"captcha"'), JSON.stringify(recheck))
  const asks: PermissionDecision[] = []
  const host = hostOf(asks, () => 'allow')
  const answered = await call(context, { action: 'click', ...firstName, captcha: true, capture: false }, host)
  check("the host's Yes on that question carries into the act: one card, not two", answered.outcome === 'succeeded' && asks.length === 0 && clicks() === 1, answered.result)
  const ruled = toolContext({ allow: ['Computer(captcha)'], messages: context.messages })
  session.approveApp(ownerOf(ruled), { identity: 'com.example.Browser', name: 'Browser' })
  const byRule = await ComputerTool.checkPermissions({ action: 'click', ...firstName, captcha: true, capture: false } as never, ruled)
  check('a Computer(captcha) allow rule answers the subject in checkPermissions', byRule.behavior === 'allow', JSON.stringify(byRule))
  const denyRuled = toolContext({ deny: ['Computer(captcha)'], messages: context.messages })
  session.approveApp(ownerOf(denyRuled), { identity: 'com.example.Browser', name: 'Browser' })
  const byDeny = await ComputerTool.checkPermissions({ action: 'click', ...firstName, captcha: true, capture: false } as never, denyRuled)
  check('a deny rule denies the subject in checkPermissions, naming the rule', byDeny.behavior === 'deny' && /denied by the rule Computer\(captcha\)/.test('message' in byDeny ? byDeny.message : ''), JSON.stringify(byDeny))
  const { challengeAsk } = await import('../../src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx')
  check('the card takes its challenge shape from the Computer(captcha) suggestion the harness attaches, never from the input', challengeAsk?.(subject.behavior === 'ask' ? subject.suggestions : undefined) === true && challengeAsk?.(first.behavior === 'ask' ? first.suggestions : undefined) === false && challengeAsk?.(undefined) === false)
}

section('§5 the schema, the prompt and the words')
{
  const context = toolContext()
  const explicit = await ComputerTool.validateInput!({ action: 'click', x: 10, y: 10, captcha: true, capture: false } as never, context)
  check('captcha: true is a legal act input, no longer a code refusal', explicit.result === true, JSON.stringify(explicit))
  const prompt = await ComputerTool.prompt({ getToolPermissionContext: async () => context.getAppState().toolPermissionContext, tools: [], agents: [] })
  const description = (ComputerTool.inputJSONSchema as { properties: { captcha: { description: string } } }).properties.captcha.description
  check('the captcha field says it asks the operator, and the prompt carries no captcha lecture', /ask/i.test(description) && /operator/i.test(description) && !/captcha/i.test(prompt), `${description}\n${prompt}`)
  for (const file of ['src/tools/ComputerTool/captcha.ts', 'src/tools/ComputerTool/ComputerTool.ts', 'src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx', 'docs/COMPUTER-USE.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    check(`${file}: no sentence tells a model not to try`, !DO_NOT_TRY.test(text), (DO_NOT_TRY.exec(text) ?? [''])[0])
  }
}
finish('prove-computer-captcha')
