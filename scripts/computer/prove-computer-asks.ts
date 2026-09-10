#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, COMPUTER_READS, ownerOf, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const { suggestionForExactCommand } = await import('../../src/utils/permissions/shellRuleMatching.ts')
type ToolUseContext = import('../../src/Tool.ts').ToolUseContext
type FakeDesktopDriver = import('../../src/services/desktop/fakeDesktopDriver.ts').FakeDesktopDriver

const scratch = scratchDir('asks')
const TEXTEDIT = 'com.example.TextEdit'
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
  useScene('default', null)
  const context = toolContext()
  const owner = ownerOf(context)
  session.forgetDesktopOwner(owner)
  const first = await permission({ action: 'click', x: 812, y: 300 }, context)
  check('the first click asks', first.behavior === 'ask', JSON.stringify(first))
  check('the message names the act, the point and the application, and says it is the first act', (first.message ?? '').includes('Computer click (812, 300)') && (first.message ?? '').includes('TextEdit') && (first.message ?? '').includes('first act in this application'), first.message)
  check('the message shows the name with the identity', (first.message ?? '').includes(`TextEdit (${TEXTEDIT})`), first.message)
  check('the reason is a safety check the classifier may not answer', first.decisionReason?.type === 'safetyCheck' && first.decisionReason.classifierApprovable === false, JSON.stringify(first.decisionReason))
  check('the suggestion is the exact-command rule Computer(app:<identity>)', JSON.stringify(first.suggestions) === JSON.stringify(suggestionForExactCommand('Computer', `app:${TEXTEDIT}`)), JSON.stringify(first.suggestions))
  check('no grant yet', session.appApproved(owner, TEXTEDIT) === false && session.approvedAppList(owner).length === 0)
  const shot = await withScreenshot(ComputerTool as never, context, 'toolu_asks_shot')
  check('the screenshot before the act succeeds', shot.outcome === 'succeeded', shot.result)
  const acted = resultOf(await ComputerTool.call({ action: 'click', x: 812, y: 300, capture: false } as never, shot.context, allowEverything, toolUseTurn('toolu_asks_click', 'Computer', { action: 'click', x: 812, y: 300, capture: false })))
  check('the click runs on the fake and names its point in both spaces', acted.outcome === 'succeeded' && acted.result.includes('click (812, 300)') && acted.result.includes('(406, 150) pt'), acted.result)
  check('the act granted the application for the session', session.appApproved(owner, TEXTEDIT) === true && session.approvedAppList(owner).includes(TEXTEDIT), session.approvedAppList(owner).join(','))
  const second = await permission({ action: 'key', key: 'Enter' }, context)
  check('the second act in the same application is allowed', second.behavior === 'allow', JSON.stringify(second))
  const other = toolContext({ agentId: 'agent-b' })
  const otherOwner = ownerOf(other)
  session.forgetDesktopOwner(otherOwner)
  const crossed = await permission({ action: 'key', key: 'Enter' }, other)
  check('another owner does not inherit the grant', crossed.behavior === 'ask' && session.approvedAppList(otherOwner).length === 0, JSON.stringify(crossed))
  session.forgetDesktopOwner(owner)
  check('forgetDesktopOwner wipes the grant', session.appApproved(owner, TEXTEDIT) === false && session.approvedAppList(owner).length === 0)
}

section('§3 a switch to another application re-asks')
{
  useScene('switch', { switches: [{ afterActs: 1, frontmost: FINDER }] })
  const context = toolContext()
  const owner = ownerOf(context)
  session.forgetDesktopOwner(owner)
  const shot = await withScreenshot(ComputerTool as never, context, 'toolu_switch_shot')
  const acted = resultOf(await ComputerTool.call({ action: 'click', x: 812, y: 300, capture: false } as never, shot.context, allowEverything, toolUseTurn('toolu_switch_click', 'Computer', { action: 'click', x: 812, y: 300, capture: false })))
  check('the first click lands in TextEdit', acted.outcome === 'succeeded' && session.appApproved(owner, TEXTEDIT), acted.result)
  const front = await fakeDriver().frontmostApplication()
  check('Finder is now in front', front.ok && front.value.name === 'Finder')
  const next = await permission({ action: 'click', x: 100, y: 100 }, shot.context)
  check('the next click asks for Finder', next.behavior === 'ask' && (next.message ?? '').includes('Finder') && !(next.message ?? '').includes('TextEdit'), JSON.stringify(next))
  session.forgetDesktopOwner(owner)
}

section('§4 the judged application travels from the check to the act and refuses on drift')
{
  useScene('finder-front', { frontmost: FINDER })
  const context = toolContext()
  const owner = ownerOf(context)
  session.forgetDesktopOwner(owner)
  const shot = await withScreenshot(ComputerTool as never, context, 'toolu_drift_shot')
  session.noteCheckedActApp(owner, 'click', TEXTEDIT)
  const before = fakeDriver().acts.length
  const drifted = resultOf(await ComputerTool.call({ action: 'click', x: 100, y: 100, capture: false } as never, shot.context, allowEverything, toolUseTurn('toolu_drift_click', 'Computer', { action: 'click', x: 100, y: 100, capture: false })))
  check('the act refuses naming the drift and does nothing', drifted.outcome === 'failed' && drifted.result.includes('refused') && drifted.result.includes('moved') && drifted.result.includes('between the permission check and the act') && drifted.result.includes('nothing done'), drifted.result)
  check('no click reached the driver', fakeDriver().acts.filter(a => a.act === 'click').length === 0 && fakeDriver().acts.length === before)
  check('nothing was granted', session.appApproved(owner, 'com.example.Finder') === false && session.appApproved(owner, TEXTEDIT) === false)
  check('the carry was consumed by the refusal', session.consumeCheckedActApp(owner, 'click') === null)
  session.forgetDesktopOwner(owner)
}

section('§5 rules: a deny rule refuses before any ask, an allow rule allows without a grant')
{
  useScene('default', null)
  const denied = toolContext({ deny: [`Computer(app:${TEXTEDIT})`] })
  session.forgetDesktopOwner(ownerOf(denied))
  const denyVerdict = await permission({ action: 'click', x: 812, y: 300 }, denied)
  check('a deny rule refuses by name', denyVerdict.behavior === 'deny' && (denyVerdict.message ?? '').includes(`app:${TEXTEDIT}`) && (denyVerdict.message ?? '').includes('permission rule'), JSON.stringify(denyVerdict))
  const allowed = toolContext({ allow: [`Computer(app:${TEXTEDIT})`] })
  const allowOwner = ownerOf(allowed)
  session.forgetDesktopOwner(allowOwner)
  const allowVerdict = await permission({ action: 'click', x: 812, y: 300 }, allowed)
  check('an allow rule allows with no session grant written', allowVerdict.behavior === 'allow' && session.appApproved(allowOwner, TEXTEDIT) === false, JSON.stringify(allowVerdict))
  const otherApp = toolContext({ allow: ['Computer(app:com.example.Finder)'] })
  session.forgetDesktopOwner(ownerOf(otherApp))
  const stillAsks = await permission({ action: 'click', x: 812, y: 300 }, otherApp)
  check('an allow rule for another application still asks for this one', stillAsks.behavior === 'ask', JSON.stringify(stillAsks))
}

section('§6 the type ask names the length, never the text')
{
  useScene('default', null)
  const context = toolContext()
  session.forgetDesktopOwner(ownerOf(context))
  const verdict = await permission({ action: 'type', text: 'hello world' }, context)
  check('the ask says 11 chars and never spells the text', verdict.behavior === 'ask' && (verdict.message ?? '').includes('11 chars') && !(verdict.message ?? '').includes('hello world'), verdict.message)
  const drag = await permission({ action: 'drag', x: 812, y: 300, toX: 900, toY: 340 }, context)
  check('the drag ask spells both points', (drag.message ?? '').includes('(812, 300) → (900, 340)'), drag.message)
  const scroll = await permission({ action: 'scroll', x: 812, y: 300, dy: 3 }, context)
  check('the scroll ask spells the deltas at the point', (scroll.message ?? '').includes('by 0, 3 at (812, 300)'), scroll.message)
  const key = await permission({ action: 'key', key: 'cmd+s' }, context)
  check('the key ask spells the chord', (key.message ?? '').includes('cmd+s'), key.message)
  session.forgetDesktopOwner(ownerOf(context))
}

section('§7 the terminal running this session: keystrokes never land in it')
{
  useScene('terminal-front', { frontmost: TERMINAL })
  const context = toolContext()
  const owner = ownerOf(context)
  session.forgetDesktopOwner(owner)
  session.approveApp(owner, TERMINAL.identity)
  const shot = await withScreenshot(ComputerTool as never, context, 'toolu_terminal_shot')
  const typed = await refusalOf({ action: 'type', text: 'hello', capture: false }, shot.context)
  check('type refuses naming the terminal running this session', typed !== null && typed.includes('terminal running this session'), typed ?? 'allowed')
  const held = await refusalOf({ action: 'hold', key: 'shift', durationMs: 100, capture: false }, shot.context)
  check('hold refuses the same way', held !== null && held.includes('terminal running this session'), held ?? 'allowed')
  const enter = await refusalOf({ action: 'key', key: 'Enter', capture: false }, shot.context)
  check('key Enter refuses by name', enter !== null && enter.includes('terminal'), enter ?? 'allowed')
  const switchChord = process.platform === 'darwin' ? 'cmd+tab' : 'alt+tab'
  const switched = await refusalOf({ action: 'key', key: switchChord, capture: false }, shot.context)
  check(`the application switch chord ${switchChord} is allowed`, switched === null, switched ?? '')
  check('…and reached the driver as a key tap', fakeDriver().acts.some(a => a.act === 'keyTap' && a.detail.key === 'tab'), JSON.stringify(fakeDriver().acts.map(a => a.act)))
  const inside = await refusalOf({ action: 'click', x: 100, y: 1500, capture: false }, shot.context)
  check('a click inside the terminal\'s window refuses naming the window', inside !== null && inside.includes('inside the window of the terminal running this session'), inside ?? 'allowed')
  const outside = await refusalOf({ action: 'click', x: 100, y: 100, capture: false }, shot.context)
  check('a click outside its window is allowed', outside === null, outside ?? '')
  check('no keystroke reached the driver', !fakeDriver().acts.some(a => a.act === 'typeText' || a.act === 'keyDown'), JSON.stringify(fakeDriver().acts.map(a => a.act)))
  session.forgetDesktopOwner(owner)
}

useScene('default', null)
finish('prove-computer-asks')
