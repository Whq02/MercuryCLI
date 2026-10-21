#!/usr/bin/env bun
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section, sourceText } from './computerProofKit.ts'
import { allowEverything, COMPUTER_READS, ownerOf, pixelOfPointOn, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'

const { ComputerTool, TREE_DEPTH_CAP, TREE_DEPTH_DEFAULT, TREE_LIMIT_CAP, TREE_LIMIT_DEFAULT } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const { suggestionForExactCommand } = await import('../../src/utils/permissions/shellRuleMatching.ts')
type ToolUseContext = import('../../src/Tool.ts').ToolUseContext
type FakeDesktopDriver = import('../../src/services/desktop/fakeDesktopDriver.ts').FakeDesktopDriver

const scratch = scratchDir('tree')
const TEXTEDIT = { identity: 'com.example.TextEdit', name: 'TextEdit' }
const FINDER = { identity: 'com.example.Finder', name: 'Finder', pid: 4300, title: null, bounds: { x: 0, y: 0, width: 600, height: 400 } }
const TERMINAL = { identity: 'com.example.Terminal', name: 'Terminal', pid: 4100, title: 'mercury', windowId: '101', bounds: { x: 0, y: 700, width: 1440, height: 200 } }
const LIVE = (process.env.MERCURY_SUITE_DESKTOP_LIVE ?? '').trim()

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

type Verdict = { behavior: string; message?: string; suggestions?: unknown; decisionReason?: { type?: string; operatorOnly?: boolean } }
const permission = async (input: Record<string, unknown>, context: ToolUseContext): Promise<Verdict> => (await ComputerTool.checkPermissions(input as never, context)) as Verdict
let calls = 0
const call = async (input: Record<string, unknown>, context: ToolUseContext) => resultOf(await ComputerTool.call({ scope: 'app', ...input } as never, context, allowEverything, toolUseTurn(`toolu_tree_${++calls}`, 'Computer', input)))
const inputActs = (): string[] => fakeDriver().acts.filter(a => a.act !== 'capture' && a.act !== 'accessibilityTree' && a.act !== 'releaseAll').map(a => a.act)

async function fresh(name: string, scene: Record<string, unknown> | null, options: Parameters<typeof toolContext>[0] = {}): Promise<{ context: ToolUseContext; owner: ReturnType<typeof ownerOf>; screen: Record<string, unknown> }> {
  useScene(name, scene)
  const base = toolContext(options)
  const owner = ownerOf(base)
  session.forgetDesktopOwner(owner)
  const shot = await withScreenshot(ComputerTool as never, base, `toolu_${name}_shot`)
  check(`${name}: the opening screenshot succeeds`, shot.outcome === 'succeeded', shot.result)
  return { context: shot.context, owner, screen: shot.screen }
}

function wide(windows: number, groupsPerWindow: number, buttonsPerGroup: number): Record<string, unknown>[] {
  const tree: Record<string, unknown>[] = []
  for (let w = 0; w < windows; w++) {
    const groups: Record<string, unknown>[] = []
    for (let g = 0; g < groupsPerWindow; g++) {
      const buttons: Record<string, unknown>[] = []
      for (let b = 0; b < buttonsPerGroup; b++) buttons.push({ role: 'AXButton', title: `Button ${w}.${g}.${b}`, frame: { x: 10 * b, y: 10 * g, width: 8, height: 8 } })
      groups.push({ role: 'AXGroup', frame: { x: 0, y: 20 * g, width: 200, height: 20 }, children: buttons })
    }
    tree.push({ role: 'AXWindow', title: `Window ${w}`, frame: { x: 0, y: 0, width: 400, height: 300 }, children: groups })
  }
  return tree
}

section('§1 tree is a read-only action that asks like an act, under the same per-application grant')
{
  const { context, owner, screen } = await fresh('default', null)
  check('tree is read-only to the batcher and never concurrency-safe (it goes through an ask)', ComputerTool.isReadOnly({ action: 'tree' } as never) === true && ComputerTool.isConcurrencySafe({ action: 'tree' } as never) === false)
  check('tree is not among the never-ask reads', !(COMPUTER_READS as readonly string[]).includes('tree'))
  const first = await permission({ action: 'tree' }, context)
  check('the first tree in an application asks', first.behavior === 'ask', JSON.stringify(first))
  check('the ask names the action, the application and what the read is', (first.message ?? '') === `Computer tree in ${TEXTEDIT.name} (${TEXTEDIT.identity}) — first act in this application this session (reads its accessibility tree: the controls with their titles, values and frames)`, first.message)
  check('the reason is a safety check the operator alone answers', first.decisionReason?.type === 'safetyCheck' && first.decisionReason.operatorOnly === true, JSON.stringify(first.decisionReason))
  check('the suggestion is the same per-application rule the acts offer', JSON.stringify(first.suggestions) === JSON.stringify(suggestionForExactCommand('Computer', `app:${TEXTEDIT.identity}`)), JSON.stringify(first.suggestions))
  check('the judged application is on the carry under the action tree', session.peekCheckedActApp(owner)?.app.identity === TEXTEDIT.identity && session.peekCheckedActApp(owner)?.action === 'tree')
  check('no grant yet', session.appApproved(owner, TEXTEDIT.identity) === false)
  const read = await call({ action: 'tree' }, context)
  check('the read succeeds', read.outcome === 'succeeded', read.result)
  const lines = read.result.split('\n')
  check('the first line names the application, the count, the depth reached and the limits', lines[0] === `tree: TextEdit (com.example.TextEdit) — 10 elements to depth 4 (limit ${TREE_LIMIT_DEFAULT}, depth ${TREE_DEPTH_DEFAULT}) · frames @x,y w×h in screen points; (x, y) px is the element's centre in the last screenshot`, lines[0])
  check('the application is the root, its windows and menu bar its children, indented by depth', lines[1] === 'AXApplication "TextEdit"' && lines[2]?.startsWith('  AXWindow "Untitled" @100,100 800×600') && lines.some(l => l.startsWith('  AXMenuBar @0,0 1440×24')), read.result)
  const bold = pixelOfPointOn(screen, 112 + 14, 134 + 14)
  check('a control carries its role, title and frame, with its centre in pixels of the screenshot the model received', lines.includes(`      AXButton "Bold" @112,134 28×28 · (${bold.x}, ${bold.y}) px`), `${read.result}\n expected (${bold.x}, ${bold.y}) from ${JSON.stringify(screen)}`)
  check('a text area carries its value, quoted whole (newlines escaped)', lines.some(l => l.startsWith('      AXTextArea value="The quick brown fox jumps over the lazy dog.\\nA second line of the document." @100,168 785×532')), read.result)
  check('an element without a frame has no coordinates at all', lines.includes('        AXMenuItem "Save"'), read.result)
  check('a whole tree says nothing of truncation', !read.result.includes('truncated'), read.result)
  const window = pixelOfPointOn(screen, 100 + 400, 100 + 300)
  check(`the window's centre maps through the same screen map (${screen.imageWidth}×${screen.imageHeight} px over ${screen.pointWidth}×${screen.pointHeight} pt)`, lines[2] === `  AXWindow "Untitled" @100,100 800×600 · (${window.x}, ${window.y}) px`, lines[2])
  const logged = fakeDriver().acts.find(a => a.act === 'accessibilityTree')
  check('the driver received one tree read with the defaults, for the application in front', logged?.outcome === 'done' && logged.detail.app === TEXTEDIT.identity && logged.detail.depth === TREE_DEPTH_DEFAULT && logged.detail.count === TREE_LIMIT_DEFAULT && logged.detail.elements === 10, JSON.stringify(logged))
  check('no mouse or keyboard act reached the driver', inputActs().length === 0, inputActs().join(','))
  check('the read granted the application for the session, as an act would', session.appApproved(owner, TEXTEDIT.identity) === true)
  check('the carry was consumed by the read', session.consumeCheckedActApp(owner, 'tree') === null)
  const again = await permission({ action: 'tree' }, context)
  const act = await permission({ action: 'key', key: 'Enter' }, context)
  check('a second tree and an act in the same application ride the grant', again.behavior === 'allow' && act.behavior === 'allow', `${JSON.stringify(again)} ${JSON.stringify(act)}`)
  session.forgetDesktopOwner(owner)
}

section('§2 without a screenshot the frames stand alone in points; depth and limit are honoured')
{
  useScene('no-shot', null)
  const context = toolContext()
  const owner = ownerOf(context)
  session.forgetDesktopOwner(owner)
  const read = await call({ action: 'tree', depth: 1, limit: 2 }, context)
  const lines = read.result.split('\n')
  check('the read succeeds with no screenshot and says frames are points only', read.outcome === 'succeeded' && lines[0]?.endsWith('frames @x,y w×h in screen points') === true, read.result)
  check('limit 2 keeps the application and its first window', lines[1] === 'AXApplication "TextEdit"' && lines[2] === '  AXWindow "Untitled" @100,100 800×600' && lines.filter(l => /^\s*AX/.test(l)).length === 2, read.result)
  check('the cut is said, naming the limits and what to do', lines[lines.length - 1] === `truncated: the tree goes on past the limit of 2 elements or depth 1 — raise limit or depth to read more, or act on what is shown`, read.result)
  const shallow = await call({ action: 'tree', depth: 0 }, context)
  check('depth 0 is the application alone, and says the tree goes on', shallow.result.split('\n').filter(l => /^\s*AX/.test(l)).join('|') === 'AXApplication "TextEdit"' && shallow.result.includes('truncated:'), shallow.result)
  session.forgetDesktopOwner(owner)
}

section('§3 refusals: an application the ask denied; a tree over the cap is truncated and said; bad limits; a stray field')
{
  useScene('denied', null)
  const denied = toolContext({ deny: [`Computer(app:${TEXTEDIT.identity})`] })
  session.forgetDesktopOwner(ownerOf(denied))
  const verdict = await permission({ action: 'tree' }, denied)
  check('a deny rule for the application refuses the tree by name, before any read', verdict.behavior === 'deny' && verdict.message === `Driving ${TEXTEDIT.name} (${TEXTEDIT.identity}) is denied by the rule Computer(app:${TEXTEDIT.identity}) in the project local settings.`, JSON.stringify(verdict))
  check('nothing was read', fakeDriver().acts.filter(a => a.act === 'accessibilityTree').length === 0)
  const allowed = toolContext({ allow: [`Computer(app:${TEXTEDIT.identity})`] })
  session.forgetDesktopOwner(ownerOf(allowed))
  check('an allow rule for the application allows the tree with no session grant written', (await permission({ action: 'tree' }, allowed)).behavior === 'allow' && session.appApproved(ownerOf(allowed), TEXTEDIT.identity) === false)

  const { context, owner } = await fresh('wide', { tree: wide(3, 10, 10) })
  const capped = await call({ action: 'tree', limit: 25 }, context)
  const shown = capped.result.split('\n').filter(l => /^\s*AX/.test(l))
  check('a tree of 334 elements under limit 25 shows exactly 25, in reading order', capped.outcome === 'succeeded' && shown.length === 25 && shown[0] === 'AXApplication "TextEdit"' && shown[1]?.startsWith('  AXWindow "Window 0"') === true && shown[3]?.startsWith('      AXButton "Button 0.0.0"') === true, capped.result)
  check('…and says it was cut, with the count and depth it ran under', capped.result.split('\n')[0]?.includes('25 elements to depth 3 (limit 25') === true && capped.result.endsWith('truncated: the tree goes on past the limit of 25 elements or depth 8 — raise limit or depth to read more, or act on what is shown'), capped.result)
  const byDepth = await call({ action: 'tree', depth: 2 }, context)
  const depthLines = byDepth.result.split('\n').filter(l => /^\s*AX/.test(l))
  check('depth 2 stops at the groups (1 + 3 + 30 elements), no button shown, the cut said', depthLines.length === 34 && !byDepth.result.includes('AXButton') && byDepth.result.includes('truncated:'), byDepth.result.slice(0, 400))
  const whole = await call({ action: 'tree', limit: 400, depth: 4 }, context)
  check('a limit above the tree reads it whole: 334 elements and no truncation line', whole.result.split('\n').filter(l => /^\s*AX/.test(l)).length === 334 && !whole.result.includes('truncated'), whole.result.slice(0, 200))
  for (const [input, words] of [
    [{ action: 'tree', depth: TREE_DEPTH_CAP + 1 }, `tree takes depth as a whole number from 0 to ${TREE_DEPTH_CAP}`],
    [{ action: 'tree', depth: -1 }, `tree takes depth as a whole number from 0 to ${TREE_DEPTH_CAP}`],
    [{ action: 'tree', depth: 1.5 }, `tree takes depth as a whole number from 0 to ${TREE_DEPTH_CAP}`],
    [{ action: 'tree', limit: 0 }, `tree takes limit as a whole number from 1 to ${TREE_LIMIT_CAP}`],
    [{ action: 'tree', limit: TREE_LIMIT_CAP + 1 }, `tree takes limit as a whole number from 1 to ${TREE_LIMIT_CAP}`],
    [{ action: 'tree', x: 1 }, 'tree does not take x'],
    [{ action: 'screenshot', depth: 2 }, 'screenshot does not take depth'],
    [{ action: 'click', x: 1, y: 1, limit: 2 }, 'click does not take limit'],
  ] as const) {
    const validation = await ComputerTool.validateInput!(input as never, context)
    check(`${JSON.stringify(input)} is refused: ${words}`, validation.result === false && validation.message.includes(words), JSON.stringify(validation))
  }
  session.forgetDesktopOwner(owner)
}

section('§4 the screen moving between the check and the read refuses; the grant is not written; nothing is read')
{
  const { context, owner } = await fresh('drift', { frontmost: FINDER })
  session.noteCheckedActApp(owner, 'tree', TEXTEDIT)
  const before = fakeDriver().acts.length
  const drifted = await call({ action: 'tree' }, context)
  check('the read refuses naming the drift', drifted.outcome === 'failed' && drifted.result === 'tree refused: the screen moved from TextEdit (com.example.TextEdit) to Finder (com.example.Finder) between the permission check and the read — nothing read; re-issue', drifted.result)
  check('nothing reached the driver and nothing was granted', fakeDriver().acts.length === before && session.appApproved(owner, FINDER.identity) === false && session.appApproved(owner, TEXTEDIT.identity) === false)
  session.forgetDesktopOwner(owner)
}

section('§5 the terminal running this session: its tree can be read (the keystroke guard is not a reading guard)')
{
  const { context, owner } = await fresh('terminal', { frontmost: TERMINAL, tree: [{ role: 'AXWindow', title: 'mercury', frame: { x: 0, y: 700, width: 1440, height: 200 }, children: [{ role: 'AXTextArea', title: 'shell', value: '$ mercury', frame: { x: 0, y: 700, width: 1440, height: 200 } }] }] })
  const ask = await permission({ action: 'tree' }, context)
  check('the tree of the terminal asks by its name like any application', ask.behavior === 'ask' && (ask.message ?? '').includes('in Terminal (com.example.Terminal)'), JSON.stringify(ask))
  const read = await call({ action: 'tree' }, context)
  check('and reads the terminal\'s own window and shell text', read.outcome === 'succeeded' && read.result.includes('  AXWindow "mercury" @0,700 1440×200') && read.result.includes('    AXTextArea "shell" value="$ mercury"'), read.result)
  const typed = await permission({ action: 'type', text: 'rm -rf /' }, context)
  check('control: a keystroke into the terminal is still refused after the read', typed.behavior === 'deny' && (typed.message ?? '').includes('type refused'), JSON.stringify(typed))
  check('no keystroke reached the driver', inputActs().length === 0)
  session.forgetDesktopOwner(owner)
}

section('§6 Accessibility not granted: the read says so with the remedy and reads nothing')
{
  const { context, owner } = await fresh('no-ax', { permissions: { session: 'desktop', screenCapture: 'granted', input: 'denied', reason: 'Accessibility is off for this terminal' } })
  const read = await call({ action: 'tree' }, context)
  check('the read fails naming Accessibility and the remedy', read.outcome === 'failed' && read.result.startsWith('tree failed: Accessibility is not granted — Accessibility is off for this terminal') && read.result.includes('—'), read.result)
  check('nothing was granted', session.appApproved(owner, TEXTEDIT.identity) === false)
  session.forgetDesktopOwner(owner)
}

section('§7 the words and the road')
{
  const prompt = await ComputerTool.prompt({ getToolPermissionContext: async () => ({}) as never, tools: [], agents: [] } as never)
  check('the prompt teaches tree: the application in front, read-only, role/title/value/frame, bounded with the cut said, no clipboard, no input', /action:"tree" \(depth\?, limit\?\)/.test(prompt) && /read-only/.test(prompt) && /role, title, value and frame/.test(prompt) && /a cut is said/.test(prompt) && /no clipboard, no input/.test(prompt), prompt)
  check('the prompt says tree asks like an act', /never ask; tree asks like an act\./.test(prompt))
  const tool = sourceText('src/tools/ComputerTool/ComputerTool.ts')
  const addon = sourceText('native/desktop/src/mac.rs')
  check('the tool reads no clipboard and the macOS reader touches no pasteboard', !/pbpaste|NSPasteboard|clipboardy|readClipboard|getClipboard/i.test(tool) && !/NSPasteboard|UIPasteboard|pbpaste/.test(addon))
  check('the macOS reader walks the Accessibility API (AXUIElement, AXChildren, AXRole, AXTitle, AXValue, AXPosition, AXSize) and posts no event', /AXUIElementCreateApplication\(pid\)/.test(addon.slice(addon.indexOf('pub fn accessibility_tree'))) && ['"AXChildren"', '"AXRole"', '"AXTitle"', '"AXValue"', '"AXPosition"', '"AXSize"'].every(key => addon.includes(key)) && !/CGEventPost/.test(addon.slice(addon.indexOf('pub fn accessibility_tree'), addon.indexOf('fn parent_of'))))
  check('the native driver reads the tree on the same subprocess road as the frontmost read, with a kill timeout', /accessibilityTree\(Number\(process\.argv\[2\]\)/.test(sourceText('src/services/desktop/nativeDriver.ts')) && /TREE_SUBPROCESS_TIMEOUT_MS/.test(sourceText('src/services/desktop/nativeDriver.ts')))
  check('the addon contract carries accessibilityTree among its required exports', (await import('../../src/services/desktop/pack.ts')).DESKTOP_ADDON_EXPORTS.includes('accessibilityTree' as never))
}

section('§8 live: the real tree of the application in front through the native driver (MERCURY_SUITE_DESKTOP_LIVE=1)')
if (LIVE === '1' || LIVE === 'acts') {
  delete process.env.MERCURY_DESKTOP_DRIVER
  resetDesktopDriverForTest()
  const native = await import('../../src/services/desktop/nativeDriver.ts')
  const load = native.resolveNativeDesktopDriver()
  check('the native driver resolves', load.state === 'ok', load.state === 'ok' ? '' : load.note)
  if (load.state === 'ok') {
    const permissions = await load.driver.permissions()
    const front = await load.driver.frontmostApplication()
    if (permissions.ok && permissions.value.input === 'granted' && front.ok) {
      const started = Date.now()
      const tree = await load.driver.accessibilityTree(front.value, { depth: 4, count: 60 }, new AbortController().signal)
      check(`the front application (${front.value.name}) answers its tree within the budget`, tree.ok && tree.value.elements.length >= 1 && Date.now() - started < 12_000, tree.ok ? `${tree.value.elements.length} elements` : tree.error.note)
      if (tree.ok) {
        check('the root is the application element', tree.value.elements[0]?.role === 'AXApplication' && tree.value.elements[0]?.depth === 0, JSON.stringify(tree.value.elements[0]))
        check('depths never exceed 4 and the count never exceeds 60', tree.value.elements.every(e => e.depth <= 4) && tree.value.elements.length <= 60)
        console.log(`  · ${tree.value.elements.length} elements, truncated ${tree.value.truncated}: ${tree.value.elements.slice(0, 6).map(e => `${e.role}${e.title ? ` ${JSON.stringify(e.title.slice(0, 30))}` : ''}`).join(' | ')}`)
      }
      const nobody = await load.driver.accessibilityTree({ ...front.value, pid: 999_999, name: 'Nobody' }, { depth: 2, count: 10 }, new AbortController().signal)
      check('a process that is not there answers a refusal, not an empty tree', !nobody.ok && /no accessibility element/.test(nobody.error.note), JSON.stringify(nobody))
    } else {
      console.log(`  [WARN] live tree skipped: ${permissions.ok ? `input ${permissions.value.input}` : permissions.error.note}; front ${front.ok ? front.value.name : front.error.note}`)
    }
  }
} else {
  console.log('  [WARN] live leg skipped: MERCURY_SUITE_DESKTOP_LIVE is unset')
}

finish('prove-computer-tree')
