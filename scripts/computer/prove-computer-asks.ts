#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section, sourceText } from './computerProofKit.ts'
import { allowEverything, COMPUTER_READS, ownerOf, pixelOfPointOn, pointOfPixelOn, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const { suggestionForExactCommand } = await import('../../src/utils/permissions/shellRuleMatching.ts')
type ToolUseContext = import('../../src/Tool.ts').ToolUseContext
type FakeDesktopDriver = import('../../src/services/desktop/fakeDesktopDriver.ts').FakeDesktopDriver

const scratch = scratchDir('asks')
const TEXTEDIT = { identity: 'com.example.TextEdit', name: 'TextEdit' }
const FINDER = { identity: 'com.example.Finder', name: 'Finder', pid: 4300, title: null, bounds: { x: 0, y: 0, width: 600, height: 400 } }
const TERMINAL = { identity: 'com.example.Terminal', name: 'Terminal', pid: 4100, title: 'mercury', bounds: { x: 0, y: 700, width: 1440, height: 200 } }

function useScene(name: string, scene: Record<string, unknown> | null): void {
  if (scene === null) delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  else {
    const path = join(scratch, `${name}.json`)
    writeFileSync(path, JSON.stringify(scene))
    process.env.MERCURY_DESKTOP_FAKE_SCENE = path
  }
  resetDesktopDriverForTest()
}

function fakeDriver(): FakeDesktopDriver {
  const resolution = resolveDesktopDriver()
  if (resolution.state !== 'ok') throw new Error(`the fake driver did not resolve: ${JSON.stringify(resolution)}`)
  return resolution.driver as FakeDesktopDriver
}

type Verdict = { behavior: string; message?: string; suggestions?: unknown; decisionReason?: { type?: string; classifierApprovable?: boolean } }
const permission = async (input: Record<string, unknown>, context: ToolUseContext): Promise<Verdict> => (await ComputerTool.checkPermissions(input as never, context)) as Verdict

async function refusalOf(input: Record<string, unknown>, context: ToolUseContext): Promise<string | null> {
  const validation = await ComputerTool.validateInput!(input as never, context)
  if (validation.result === false) return validation.message
  const verdict = await permission(input, context)
  if (verdict.behavior === 'deny') return verdict.message ?? 'denied'
  const out = resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`toolu_${Math.random().toString(36).slice(2)}`, 'Computer', input)))
  return out.outcome === 'failed' ? out.result : null
}

async function fresh(name: string, scene: Record<string, unknown> | null, options: Parameters<typeof toolContext>[0] = {}): Promise<{ context: ToolUseContext; owner: ReturnType<typeof ownerOf>; screen: Record<string, unknown> }> {
  useScene(name, scene)
  const base = toolContext(options)
  const owner = ownerOf(base)
  session.forgetDesktopOwner(owner)
  const shot = await withScreenshot(ComputerTool as never, base, `toolu_${name}_shot`)
  check(`${name}: the opening screenshot succeeds`, shot.outcome === 'succeeded', shot.result)
  return { context: shot.context, owner, screen: shot.screen }
}

section('§1 reads never ask')
{
  useScene('default', null)
  const context = toolContext()
  for (const action of COMPUTER_READS) {
    const verdict = await permission({ action }, context)
    check(`${action} is allowed without an ask`, verdict.behavior === 'allow', JSON.stringify(verdict))
  }
}

section('§2 the first act asks by the application\'s name, the second rides the grant')
{
  const { context, owner, screen } = await fresh('default', null)
  const expected = pointOfPixelOn(screen, 812, 300)
  const first = await permission({ action: 'click', x: 812, y: 300 }, context)
  check('the first click asks', first.behavior === 'ask', JSON.stringify(first))
  check('the message names the act, the point and the application, and says it is the first act', (first.message ?? '').includes('Computer click (812, 300)') && (first.message ?? '').includes('first act in this application'), first.message)
  check('the message shows the name with the identity', (first.message ?? '').includes(`in ${TEXTEDIT.name} (${TEXTEDIT.identity})`), first.message)
  check('the reason is a safety check the classifier may not answer', first.decisionReason?.type === 'safetyCheck' && first.decisionReason.classifierApprovable === false, JSON.stringify(first.decisionReason))
  check('the suggestion is the exact-command rule Computer(app:<identity>)', JSON.stringify(first.suggestions) === JSON.stringify(suggestionForExactCommand('Computer', `app:${TEXTEDIT.identity}`)), JSON.stringify(first.suggestions))
  check('the judged application is on the carry for the card', session.peekCheckedActApp(owner)?.app.identity === TEXTEDIT.identity && session.peekCheckedActApp(owner)?.action === 'click')
  check('no grant yet', session.appApproved(owner, TEXTEDIT.identity) === false && session.approvedAppList(owner).length === 0)
  const acted = resultOf(await ComputerTool.call({ action: 'click', x: 812, y: 300, capture: false } as never, context, allowEverything, toolUseTurn('toolu_asks_click', 'Computer', { action: 'click', x: 812, y: 300, capture: false })))
  check('the click runs on the fake and names its point in both spaces', acted.outcome === 'succeeded' && acted.result.includes('click (812, 300)') && acted.result.includes(`(${expected.x}, ${expected.y}) pt`), `${acted.result} · expected (${expected.x}, ${expected.y}) pt from ${JSON.stringify(screen)}`)
  const clicked = fakeDriver().acts.find(a => a.act === 'click')
  check('the driver received the mapped point', JSON.stringify(clicked?.detail.at) === JSON.stringify(expected), JSON.stringify(clicked))
  check('the act granted the application for the session', session.appApproved(owner, TEXTEDIT.identity) === true && session.approvedAppList(owner).includes(TEXTEDIT.identity), session.approvedAppList(owner).join(','))
  check('the carry was consumed by the act', session.consumeCheckedActApp(owner, 'click') === null)
  const second = await permission({ action: 'key', key: 'Enter' }, context)
  check('the second act in the same application is allowed', second.behavior === 'allow', JSON.stringify(second))
  const other = toolContext({ agentId: 'agent-b' })
  const otherOwner = ownerOf(other)
  session.forgetDesktopOwner(otherOwner)
  const crossed = await permission({ action: 'key', key: 'Enter' }, other)
  check('another owner does not inherit the grant', crossed.behavior === 'ask' && session.approvedAppList(otherOwner).length === 0, JSON.stringify(crossed))
  session.forgetDesktopOwner(owner)
  check('forgetDesktopOwner wipes the grant', session.appApproved(owner, TEXTEDIT.identity) === false && session.approvedAppList(owner).length === 0)
}

section('§3 a switch to another application re-asks')
{
  const { context, owner } = await fresh('switch', { switches: [{ afterActs: 1, frontmost: FINDER }] })
  const acted = resultOf(await ComputerTool.call({ action: 'click', x: 812, y: 300, capture: false } as never, context, allowEverything, toolUseTurn('toolu_switch_click', 'Computer', { action: 'click', x: 812, y: 300, capture: false })))
  check('the first click lands in TextEdit', acted.outcome === 'succeeded' && session.appApproved(owner, TEXTEDIT.identity), acted.result)
  const front = await fakeDriver().frontmostApplication()
  check('Finder is now in front', front.ok && front.value.name === 'Finder')
  const next = await permission({ action: 'click', x: 100, y: 100 }, context)
  check('the next click asks for Finder', next.behavior === 'ask' && (next.message ?? '').includes('Finder (com.example.Finder)') && !(next.message ?? '').includes('TextEdit'), JSON.stringify(next))
  session.forgetDesktopOwner(owner)
}

section('§4 the judged application travels from the check to the act and refuses on drift')
{
  const { context, owner } = await fresh('finder-front', { frontmost: FINDER })
  session.noteCheckedActApp(owner, 'click', TEXTEDIT)
  const before = fakeDriver().acts.length
  const drifted = resultOf(await ComputerTool.call({ action: 'click', x: 100, y: 100, capture: false } as never, context, allowEverything, toolUseTurn('toolu_drift_click', 'Computer', { action: 'click', x: 100, y: 100, capture: false })))
  check('the act refuses naming the drift and does nothing', drifted.outcome === 'failed' && drifted.result.includes('refused') && drifted.result.includes('moved from TextEdit (com.example.TextEdit) to Finder (com.example.Finder)') && drifted.result.includes('between the permission check and the act') && drifted.result.includes('nothing done'), drifted.result)
  check('no click reached the driver', fakeDriver().acts.filter(a => a.act === 'click').length === 0 && fakeDriver().acts.length === before)
  check('nothing was granted', session.appApproved(owner, 'com.example.Finder') === false && session.appApproved(owner, TEXTEDIT.identity) === false)
  check('the carry was consumed by the refusal', session.consumeCheckedActApp(owner, 'click') === null)
  session.forgetDesktopOwner(owner)
}

section('§5 rules: a deny rule refuses before any ask, an allow rule allows without a grant')
{
  useScene('default', null)
  const denied = toolContext({ deny: [`Computer(app:${TEXTEDIT.identity})`] })
  session.forgetDesktopOwner(ownerOf(denied))
  const denyVerdict = await permission({ action: 'key', key: 'Enter' }, denied)
  check('a deny rule refuses by name', denyVerdict.behavior === 'deny' && denyVerdict.message === `Computer is denied for app:${TEXTEDIT.identity} by a permission rule`, JSON.stringify(denyVerdict))
  const allowed = toolContext({ allow: [`Computer(app:${TEXTEDIT.identity})`] })
  const allowOwner = ownerOf(allowed)
  session.forgetDesktopOwner(allowOwner)
  const allowVerdict = await permission({ action: 'key', key: 'Enter' }, allowed)
  check('an allow rule allows with no session grant written', allowVerdict.behavior === 'allow' && session.appApproved(allowOwner, TEXTEDIT.identity) === false, JSON.stringify(allowVerdict))
  const otherApp = toolContext({ allow: ['Computer(app:com.example.Finder)'] })
  session.forgetDesktopOwner(ownerOf(otherApp))
  const stillAsks = await permission({ action: 'key', key: 'Enter' }, otherApp)
  check('an allow rule for another application still asks for this one', stillAsks.behavior === 'ask', JSON.stringify(stillAsks))
  const deniedClick = toolContext({ deny: [`Computer(app:${TEXTEDIT.identity})`] })
  session.forgetDesktopOwner(ownerOf(deniedClick))
  const shot = await withScreenshot(ComputerTool as never, deniedClick, 'toolu_deny_shot')
  const denyClick = await permission({ action: 'click', x: 812, y: 300 }, shot.context)
  check('a deny rule refuses a click the same way', denyClick.behavior === 'deny' && (denyClick.message ?? '').includes('by a permission rule'), JSON.stringify(denyClick))
  session.forgetDesktopOwner(ownerOf(deniedClick))
}

section('§6 the ask names the shape of the act, never the text')
{
  const { context, owner } = await fresh('default', null)
  const verdict = await permission({ action: 'type', text: 'hello world' }, context)
  check('the type ask says 11 chars and never spells the text', verdict.behavior === 'ask' && (verdict.message ?? '').includes('11 chars') && !(verdict.message ?? '').includes('hello world'), verdict.message)
  const drag = await permission({ action: 'drag', x: 812, y: 300, toX: 900, toY: 340 }, context)
  check('the drag ask spells both points', (drag.message ?? '').includes('(812, 300) → (900, 340)'), drag.message)
  const scroll = await permission({ action: 'scroll', x: 812, y: 300, dy: 3 }, context)
  check('the scroll ask spells the deltas at the point', (scroll.message ?? '').includes('by 0, 3 at (812, 300)'), scroll.message)
  const key = await permission({ action: 'key', key: 'cmd+s' }, context)
  check('the key ask spells the chord', (key.message ?? '').includes('cmd+s'), key.message)
  const gone = await permission({ action: 'click', x: 1, y: 1 }, toolContext())
  check('a point act whose screenshot is not in the conversation it reads is refused before any ask', gone.behavior === 'deny' && (gone.message ?? '').includes('no longer in the conversation'), JSON.stringify(gone))
  session.forgetDesktopOwner(owner)
  const bare = await permission({ action: 'click', x: 1, y: 1 }, toolContext())
  check('a point act without a screenshot is refused before any ask', bare.behavior === 'deny' && (bare.message ?? '').includes('no screenshot yet'), JSON.stringify(bare))
  session.forgetDesktopOwner(owner)
}

section('§7 the terminal running this session: keystrokes never land in it')
{
  const { context, owner, screen } = await fresh('terminal-front', { frontmost: TERMINAL })
  session.approveApp(owner, { identity: TERMINAL.identity, name: TERMINAL.name })
  const insidePixel = pixelOfPointOn(screen, 50, 750)
  const outsidePixel = pixelOfPointOn(screen, 50, 50)
  const typed = await refusalOf({ action: 'type', text: 'hello', capture: false }, context)
  check('type refuses naming the terminal running this session', typed !== null && typed.includes('terminal running this session'), typed ?? 'allowed')
  const held = await refusalOf({ action: 'hold', key: 'shift', durationMs: 100, capture: false }, context)
  check('hold refuses the same way', held !== null && held.includes('terminal running this session'), held ?? 'allowed')
  const enter = await refusalOf({ action: 'key', key: 'Enter', capture: false }, context)
  check('key Enter refuses naming the switch chord as the one allowed', enter !== null && enter.includes('terminal running this session') && enter.includes('application switch chord'), enter ?? 'allowed')
  const switchChord = process.platform === 'darwin' ? 'cmd+tab' : 'alt+tab'
  const switched = await refusalOf({ action: 'key', key: switchChord, capture: false }, context)
  check(`the application switch chord ${switchChord} is allowed`, switched === null, switched ?? '')
  check('…and reached the driver as a key tap', fakeDriver().acts.some(a => a.act === 'keyTap' && a.detail.key === 'tab'), JSON.stringify(fakeDriver().acts.map(a => a.act)))
  const inside = await refusalOf({ action: 'click', x: insidePixel.x, y: insidePixel.y, capture: false }, context)
  check('a click inside the terminal\'s window refuses naming the window', inside !== null && inside.includes(`(${insidePixel.x}, ${insidePixel.y}) is inside the window of the terminal running this session`), inside ?? 'allowed')
  const outside = await refusalOf({ action: 'click', x: outsidePixel.x, y: outsidePixel.y, capture: false }, context)
  check('a click outside its window is allowed', outside === null, outside ?? '')
  check('no keystroke reached the driver', !fakeDriver().acts.some(a => a.act === 'typeText' || a.act === 'keyDown'), JSON.stringify(fakeDriver().acts.map(a => a.act)))
  session.forgetDesktopOwner(owner)
}

section('§8 unknown terminal identity refuses keystrokes instead of guessing')
{
  const { context, owner } = await fresh('terminal-unknown', { ownTerminal: null })
  for (const input of [{ action: 'type', text: 'hello' }, { action: 'hold', key: 'shift', durationMs: 100 }, { action: 'key', key: 'Enter' }]) {
    const verdict = await permission(input, context)
    check(`${input.action}: unknown terminal identity refuses before approval`, verdict.behavior === 'deny' && (verdict.message ?? '').includes('could not be identified'), JSON.stringify(verdict))
  }
  check('unknown-terminal refusals post no keyboard input', !fakeDriver().acts.some(act => act.act === 'keyTap' || act.act === 'keyDown' || act.act === 'typeText'))
  session.forgetDesktopOwner(owner)
}

section('§8 the relayed ask keeps the application name and its rule identity distinct')
{
  const { judgedAppFromAsk, computerAskAppLine } = await import('../../src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx')
  const suggestions = suggestionForExactCommand('Computer', `app:${TEXTEDIT.identity}`)
  const direct = judgedAppFromAsk(`Computer click (812, 300) in ${TEXTEDIT.name} (${TEXTEDIT.identity}) — first act in this application this session`, suggestions)
  check('a local ask keeps its application name and identity', JSON.stringify(direct) === JSON.stringify(TEXTEDIT), JSON.stringify(direct))
  const reason = `${TEXTEDIT.name} (${TEXTEDIT.identity}) is in front of the operator's screen; the first act there needs the operator's own consent`
  const relayed = judgedAppFromAsk('', suggestions, reason)
  check('a relayed ask without a message reads the display name from its safety reason', JSON.stringify(relayed) === JSON.stringify(TEXTEDIT), JSON.stringify(relayed))
  check('the card names TextEdit once beside its identity, never uses the identity as the name', computerAskAppLine(relayed) === `in TextEdit (${TEXTEDIT.identity}) — first act in this application this session`, computerAskAppLine(relayed))
  const named = judgedAppFromAsk('', suggestions, `Document Editor (Preview) (${TEXTEDIT.identity}) is in front of the operator's screen; the first act there needs the operator's own consent`)
  check('spaces and parentheses in an application name survive the relay', named?.name === 'Document Editor (Preview)' && named.identity === TEXTEDIT.identity, JSON.stringify(named))
  const mismatch = judgedAppFromAsk('', suggestions, `${FINDER.name} (${FINDER.identity}) is in front of the operator's screen; the first act there needs the operator's own consent`)
  check('a reason naming a different identity cannot rename the granted application', mismatch?.identity === TEXTEDIT.identity && mismatch.name === TEXTEDIT.identity, JSON.stringify(mismatch))
  const foreign = judgedAppFromAsk('', [{ type: 'addRules', rules: [{ toolName: 'Browser', ruleContent: `app:${TEXTEDIT.identity}` }] }])
  check("another tool's suggestion supplies no Computer application grant", foreign === null, JSON.stringify(foreign))
  check('missing relay facts retain the unnamed application fallback', judgedAppFromAsk('', undefined) === null)
  check('an empty application identity cannot produce a persistent grant', judgedAppFromAsk('', [{ type: 'addRules', rules: [{ toolName: 'Computer', ruleContent: 'app:' }] }]) === null)
  const { renderToolUseMessage } = await import('../../src/tools/ComputerTool/UI.tsx')
  const multiline = renderToolUseMessage({ action: 'type', text: 'first\nsecond\tthird' }, { verbose: false })
  check('typed newlines and tabs are spelled on one display row', typeof multiline === 'string' && !/[\r\n\t]/.test(multiline) && multiline.includes('\\n') && multiline.includes('\\t'), String(multiline))
}

section('§9 sovereign mode is the one bypass: with the access type unset the first act asks in a posture that asks and is allowed under the bypass posture, where the access reads full')
for (const [mode, bypassAvailable, asks] of [['default', true, true], ['implement', true, true], ['strategy', false, true], ['strategy', true, false], ['sovereign', true, false], ['autopilot', true, false]] as const) {
  const tag = `${mode}${mode === 'strategy' ? (bypassAvailable ? ' (bypass available)' : ' (no bypass)') : ''}`
  const { context, owner } = await fresh(`posture-${mode}-${bypassAvailable ? 'b' : 'n'}`, null)
  const permissionContext = context.getAppState().toolPermissionContext
  permissionContext.mode = mode
  permissionContext.isBypassPermissionsModeAvailable = bypassAvailable
  const first = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, context)
  if (asks) {
    check(`${tag}: the first act in an application asks (the safety-check road, never bypass-immune while the access type is unset)`, first.decision.behavior === 'ask' && first.trace.decidedBy === 'safetyCheckAsk', JSON.stringify(first.decision))
  } else {
    check(`${tag}: the first act in an application is allowed without an ask — the access reads full by the posture and the check itself allows`, first.decision.behavior === 'allow' && first.trace.decidedBy === 'bypassPosture', JSON.stringify(first.decision))
    check(`${tag}: the allowance names the posture`, first.decision.behavior === 'allow' && first.decision.decisionReason?.type === 'mode' && (first.decision.decisionReason as { mode?: string }).mode === mode, JSON.stringify(first.decision))
    check(`${tag}: the check alone wrote no session grant`, session.appApproved(owner, TEXTEDIT.identity) === false)
    check(`${tag}: the judged application still travels to the act, marked as opened by the access (the moved-in-front refusal keeps its frame, no per-application grant follows)`, session.peekCheckedActApp(owner)?.app.identity === TEXTEDIT.identity && session.peekCheckedActApp(owner)?.viaGrant === true)
  }
  for (const action of COMPUTER_READS) {
    const read = await decideToolPermission(ComputerTool, { action }, context)
    check(`${tag}: ${action} remains allowed`, read.decision.behavior === 'allow', JSON.stringify(read.decision))
  }
  session.approveApp(owner, TEXTEDIT)
  const granted = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, context)
  check(`${tag}: the later act still rides the approved application grant`, granted.decision.behavior === 'allow', JSON.stringify(granted.decision))
  permissionContext.alwaysAskRules = { localSettings: [`Computer(app:${TEXTEDIT.identity})`] }
  const explicitAsk = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, context)
  check(`${tag}: an explicit application ask rule outranks the session grant and ${asks ? 'asks' : 'stands down under the posture'}`, explicitAsk.decision.behavior === (asks ? 'ask' : 'allow'), JSON.stringify(explicitAsk.decision))
  permissionContext.alwaysDenyRules = { localSettings: [`Computer(app:${TEXTEDIT.identity})`] }
  const explicitDeny = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, context)
  check(`${tag}: the deny rule still outranks every grant, ask and posture`, explicitDeny.decision.behavior === 'deny', JSON.stringify(explicitDeny.decision))
  session.forgetDesktopOwner(owner)
}

section('§10 the computer tool declares its ask bypass-immune only while the access type is pinned to a value that asks; the terminal refusal holds in sovereign mode; the posture is the state')
{
  const pinnedAsk = (): boolean => ComputerTool.requiresUserInteraction?.() === true
  delete process.env.MERCURY_COMPUTER_ACCESS
  check('with the access type unset the Computer tool declares no bypass-immune ask (the default follows the posture)', pinnedAsk() === false)
  process.env.MERCURY_COMPUTER_ACCESS = 'asks'
  const asksPinned = pinnedAsk()
  process.env.MERCURY_COMPUTER_ACCESS = 'permissive'
  const permissivePinned = pinnedAsk()
  process.env.MERCURY_COMPUTER_ACCESS = 'full'
  const fullPinned = pinnedAsk()
  process.env.MERCURY_COMPUTER_ACCESS = 'sovereign'
  const foreignPinned = pinnedAsk()
  delete process.env.MERCURY_COMPUTER_ACCESS
  check('pinned to asks or permissive it declares the ask bypass-immune; pinned to full, or to a foreign value, it does not', asksPinned === true && permissivePinned === true && fullPinned === false && foreignPinned === false)
  const { context: terminalContext, owner: terminalOwner } = await fresh('sovereign-terminal', { frontmost: TERMINAL })
  terminalContext.getAppState().toolPermissionContext.mode = 'sovereign'
  const typed = await decideToolPermission(ComputerTool, { action: 'type', text: 'hello' }, terminalContext)
  check('typing into the terminal running this session is still refused in sovereign mode (a refusal, not an ask)', typed.decision.behavior === 'deny' && (typed.decision.message ?? '').includes('terminal running this session'), JSON.stringify(typed.decision))
  session.forgetDesktopOwner(terminalOwner)
  const { context: sovereignContext, owner: sovereignOwner } = await fresh('sovereign-then-default', null)
  const permissionContext = sovereignContext.getAppState().toolPermissionContext
  permissionContext.mode = 'sovereign'
  const under = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, sovereignContext)
  check('under sovereign mode the first act is allowed', under.decision.behavior === 'allow', JSON.stringify(under.decision))
  permissionContext.mode = 'default'
  const back = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, sovereignContext)
  check('back in default mode, with no act made, the first act asks again — the posture is the state, nothing was written', back.decision.behavior === 'ask' && session.appApproved(sovereignOwner, TEXTEDIT.identity) === false, JSON.stringify(back.decision))
  session.forgetDesktopOwner(sovereignOwner)
}

section('§11 the access type: three values × two postures at the full decision chain')
for (const value of ['asks', 'permissive', 'full'] as const) {
  for (const posture of ['default', 'sovereign'] as const) {
    const tag = `${value} · ${posture}`
    const sovereign = posture === 'sovereign'
    const { context, owner } = await fresh(`access-${value}-${posture}`, null)
    process.env.MERCURY_COMPUTER_ACCESS = value
    const permissionContext = context.getAppState().toolPermissionContext
    permissionContext.mode = posture
    permissionContext.isBypassPermissionsModeAvailable = true
    check(`${tag}: the opening screenshot recorded TextEdit as the turn's home application`, session.turnHomeApp(owner, session.turnKeyOf(context))?.identity === TEXTEDIT.identity, JSON.stringify(session.turnHomeApp(owner, session.turnKeyOf(context))))
    const home = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, context)
    if (value === 'asks') {
      check(`${tag}: the first act in the home application asks${sovereign ? ' even under sovereign mode — a saved asks wins' : ''}, at the bypass-immune road a pinned value declares`, home.decision.behavior === 'ask' && home.trace.decidedBy === 'userInteractionAsk', JSON.stringify({ decidedBy: home.trace.decidedBy, decision: home.decision }))
    } else {
      check(`${tag}: the first act in the home application never asks (${sovereign ? 'the posture band' : 'the check itself'})`, home.decision.behavior === 'allow' && home.trace.decidedBy === (sovereign ? 'bypassPosture' : 'resolution'), JSON.stringify({ decidedBy: home.trace.decidedBy, decision: home.decision }))
      check(`${tag}: the check wrote no per-application grant and marked the act as opened by the access`, session.appApproved(owner, TEXTEDIT.identity) === false && session.peekCheckedActApp(owner)?.viaGrant === true)
    }
    for (const action of COMPUTER_READS) {
      const read = await decideToolPermission(ComputerTool, { action }, context)
      check(`${tag}: ${action} remains allowed`, read.decision.behavior === 'allow', JSON.stringify(read.decision))
    }
    useScene(`access-${value}-${posture}-finder`, { frontmost: FINDER })
    const other = await decideToolPermission(ComputerTool, { action: 'click', x: 100, y: 100 }, context)
    if (value === 'full') {
      check(`${tag}: an act in another application never asks either`, other.decision.behavior === 'allow', JSON.stringify(other.decision))
    } else {
      check(`${tag}: an act that lands in another application asks for it by name, at the bypass-immune road${sovereign ? ' — it asks under sovereign mode too' : ''}`, other.decision.behavior === 'ask' && other.trace.decidedBy === 'userInteractionAsk' && (other.decision.message ?? '').includes('Finder (com.example.Finder)'), JSON.stringify({ decidedBy: other.trace.decidedBy, decision: other.decision }))
      session.approveApp(owner, { identity: FINDER.identity, name: FINDER.name })
      const covered = await decideToolPermission(ComputerTool, { action: 'click', x: 100, y: 100 }, context)
      check(`${tag}: a Yes covers that application for the session`, covered.decision.behavior === 'allow', JSON.stringify(covered.decision))
    }
    permissionContext.alwaysDenyRules = { localSettings: [`Computer(app:${FINDER.identity})`] }
    const denied = await decideToolPermission(ComputerTool, { action: 'click', x: 100, y: 100 }, context)
    check(`${tag}: a deny rule still refuses`, denied.decision.behavior === 'deny', JSON.stringify(denied.decision))
    delete process.env.MERCURY_COMPUTER_ACCESS
    session.forgetDesktopOwner(owner)
  }
}
{
  const { context, owner } = await fresh('access-foreign', null)
  process.env.MERCURY_COMPUTER_ACCESS = 'sovereign'
  const first = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, context)
  check("a foreign value ('sovereign' from an earlier build) reads as the default: the first act asks with the posture off", first.decision.behavior === 'ask' && first.trace.decidedBy === 'safetyCheckAsk', JSON.stringify(first.decision))
  context.getAppState().toolPermissionContext.mode = 'sovereign'
  const under = await decideToolPermission(ComputerTool, { action: 'click', x: 812, y: 300 }, context)
  check('…and as full with the posture on', under.decision.behavior === 'allow' && under.trace.decidedBy === 'bypassPosture', JSON.stringify(under.decision))
  delete process.env.MERCURY_COMPUTER_ACCESS
  session.forgetDesktopOwner(owner)
}

section("§12 permissive: the application in front at the turn's first call is the home for that turn; a new turn records a new one; the terminal as home refuses and the first act elsewhere asks")
{
  process.env.MERCURY_COMPUTER_ACCESS = 'permissive'
  const { context, owner } = await fresh('permissive-turns', { switches: [{ afterActs: 1, frontmost: FINDER }] })
  const turnOne = session.turnKeyOf(context)
  check("the turn key of a context without a query chain is the operator's last message — none here, so the one key", turnOne === '' && session.turnHomeApp(owner, turnOne)?.identity === TEXTEDIT.identity)
  const first = await permission({ action: 'click', x: 812, y: 300 }, context)
  check('the first act in the home application is allowed by the check', first.behavior === 'allow', JSON.stringify(first))
  const acted = resultOf(await ComputerTool.call({ action: 'click', x: 812, y: 300, capture: false } as never, context, allowEverything, toolUseTurn('toolu_permissive_click', 'Computer', { action: 'click', x: 812, y: 300, capture: false })))
  check('the act runs and leaves no per-application grant behind (the home is the turn\'s, not the session\'s)', acted.outcome === 'succeeded' && session.appApproved(owner, TEXTEDIT.identity) === false, acted.result)
  const front = await fakeDriver().frontmostApplication()
  check('Finder is now in front', front.ok && front.value.name === 'Finder')
  const elsewhere = await permission({ action: 'click', x: 100, y: 100 }, context)
  check('in the same turn an act in Finder asks for Finder by name', elsewhere.behavior === 'ask' && (elsewhere.message ?? '').includes('Finder (com.example.Finder)'), JSON.stringify(elsewhere))
  check('the home stays TextEdit for this turn', session.turnHomeApp(owner, turnOne)?.identity === TEXTEDIT.identity)
  const turnTwo = { ...context, queryTracking: { chainId: 'turn-two', depth: 0 } } as ToolUseContext
  check('a new query chain is a new turn key', session.turnKeyOf(turnTwo) === 'chain:turn-two')
  const shot = await withScreenshot(ComputerTool as never, turnTwo, 'toolu_permissive_turn_two_shot')
  check('the new turn\'s opening screenshot succeeds and records Finder as its home', shot.outcome === 'succeeded' && session.turnHomeApp(owner, 'chain:turn-two')?.identity === FINDER.identity, JSON.stringify(session.turnHomeApp(owner, 'chain:turn-two')))
  const homeTwo = await permission({ action: 'click', x: 100, y: 100 }, shot.context)
  check('in the new turn an act in Finder never asks', homeTwo.behavior === 'allow', JSON.stringify(homeTwo))
  useScene('permissive-back-to-textedit', null)
  const back = await permission({ action: 'click', x: 812, y: 300 }, shot.context)
  check('in the new turn TextEdit is another application again and asks (nothing was granted to it in the first turn)', back.behavior === 'ask' && (back.message ?? '').includes('TextEdit (com.example.TextEdit)'), JSON.stringify(back))
  session.forgetDesktopOwner(owner)
  const { context: terminalContext, owner: terminalOwner } = await fresh('permissive-terminal', { frontmost: TERMINAL })
  check('with the terminal running this session in front, it is the home', session.turnHomeApp(terminalOwner, session.turnKeyOf(terminalContext))?.identity === TERMINAL.identity)
  const typed = await permission({ action: 'type', text: 'hello' }, terminalContext)
  check('the terminal refusal stands over the home rule', typed.behavior === 'deny' && (typed.message ?? '').includes('terminal running this session'), JSON.stringify(typed))
  useScene('permissive-terminal-then-textedit', null)
  const elsewhereFirst = await permission({ action: 'click', x: 812, y: 300 }, terminalContext)
  check('the first act elsewhere asks', elsewhereFirst.behavior === 'ask' && (elsewhereFirst.message ?? '').includes('TextEdit'), JSON.stringify(elsewhereFirst))
  session.forgetDesktopOwner(terminalOwner)
  delete process.env.MERCURY_COMPUTER_ACCESS
}

section('§13 the card offers four answers while sovereign mode is already on, five otherwise — the same words in the same order')
{
  const { COMPUTER_ASK_CHOICES, computerAskChoicesFor } = await import('../../src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx')
  check('with sovereign mode off the card offers the five answers exactly as they are', computerAskChoicesFor(false) === COMPUTER_ASK_CHOICES && COMPUTER_ASK_CHOICES.map(c => c.value).join(',') === 'yes,no,hour,day,sovereign')
  const four = computerAskChoicesFor(true)
  check('with sovereign mode on the card offers the first four answers only, unchanged', four.length === 4 && four.every((c, i) => c === COMPUTER_ASK_CHOICES[i]))
  const card = sourceText('src/components/permissions/ComputerPermissionRequest/ComputerPermissionRequest.tsx')
  check('the card reads the posture through the one predicate every ask road reads', card.includes('postureBypassesAsks(') && card.includes('computerAskChoicesFor('))
}

useScene('default', null)
finish('prove-computer-asks')
