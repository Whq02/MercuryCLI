import { check, finish } from '../computer/computerProofKit.ts'
import { ownerOf, resultOf, toolContext } from '../computer/computerToolKit.ts'
import type { DesktopApplication, DesktopDriver, DesktopFocusedText, DesktopAnswer, DesktopTreeElement } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver & {
  readElement: (app: DesktopApplication, element: DesktopTreeElement, signal: AbortSignal) => Promise<DesktopAnswer<DesktopFocusedText | null>>
  readClipboard: (signal: AbortSignal) => Promise<DesktopAnswer<string>>
  findApplication: (name: string) => Promise<DesktopAnswer<DesktopApplication>>
  activateApplication: (app: DesktopApplication, signal: AbortSignal) => Promise<DesktopAnswer<DesktopApplication>>
}
let context = toolContext()
const owner = ownerOf(context)
session.forgetDesktopOwner(owner)
const app: DesktopApplication = { identity: 'com.example.Browser', name: 'Browser', pid: 100, windowId: 'browser', title: 'Routine', bounds: { x: 100, y: 100, width: 600, height: 500 } }
let front: DesktopApplication = app
let reads = 0
let activations = 0
let clipReads = 0
const long = `https://example.test/hook/${'a'.repeat(800)}`
const element = { role: 'AXTextField', title: 'Webhook URL', depth: 1, frame: null, value: long.slice(0, 300) }
driver.frontmostApplication = async () => ({ ok: true, value: front })
driver.accessibilityTree = async () => ({ ok: true, value: { elements: [element], truncated: false, reason: null } })
driver.readElement = async () => { reads++; return { ok: true, value: { text: long, title: 'Webhook URL', role: 'AXTextField' } } }
driver.readClipboard = async () => { clipReads++; return { ok: true, value: 'copied value' } }
driver.findApplication = async name => name === 'Browser' || name === app.identity ? { ok: true, value: app } : { ok: false, error: { kind: 'input', note: 'no running application named Missing' } }
driver.activateApplication = async target => { activations++; front = target; return { ok: true, value: target } }
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context))
const input = { action: 'read', target: { name: 'Webhook URL' } }
const permission = await ComputerTool.checkPermissions(input as never, context)
check('read asks for the application before reading', permission.behavior === 'ask' && reads === 0, JSON.stringify(permission))
const read = await call(input)
check('labelled read returns text beyond tree clipping', read.outcome === 'succeeded' && read.result === `read "Webhook URL": ${JSON.stringify(long)}` && !read.imagePath, read.result)
const refApi = await import('../../src/tools/ComputerTool/screenMap.ts') as unknown as { outlineTree?: Function; rememberTreeRefs?: Function }
if (refApi.outlineTree && refApi.rememberTreeRefs) {
  const tree = { elements: [element], truncated: false, reason: null }
  const outline = refApi.outlineTree(tree, app.bounds)
  refApi.rememberTreeRefs(owner, app, tree, outline)
  const reference = outline.elements[0].ref
  const byRef = await call({ action: 'read', ref: reference })
  check('read resolves the outline ref without inventing numbering', byRef.outcome === 'succeeded' && byRef.result.includes(long), byRef.result)
  refApi.rememberTreeRefs(owner, app, tree, refApi.outlineTree(tree, app.bounds))
  const stale = await call({ action: 'read', ref: reference })
  check('a stale read ref returns no value', stale.outcome === 'failed' && !stale.result.includes(long), stale.result)
  const words = { elements: [{ ...element, role: 'AXStaticText', title: 'Hello', value: null }, { ...element, role: 'AXStaticText', title: 'world', value: null }], truncated: false, reason: null }
  const merged = refApi.outlineTree(words, app.bounds)
  refApi.rememberTreeRefs(owner, app, words, merged)
  const originalTree = driver.accessibilityTree
  driver.accessibilityTree = async () => ({ ok: true, value: words })
  const textRef = await call({ action: 'read', ref: merged.elements[0].ref })
  check('merged text refs read their source text in order', textRef.outcome === 'succeeded' && textRef.result.endsWith(': "Hello world"'), textRef.result)
  driver.accessibilityTree = originalTree
} else {
  const noRef = await call({ action: 'read', ref: 1 })
  check('without an outline ref table no ref is invented', noRef.outcome === 'failed' && noRef.result.includes('read tree'), noRef.result)
}
check('new read and focus shapes reach the strict schema', ComputerTool.inputSchema.safeParse(input).success && ComputerTool.inputSchema.safeParse({ action: 'focusApp', focusApp: { name: 'Browser' } }).success)
const clipPermission = await ComputerTool.checkPermissions({ action: 'read', clipboard: true } as never, context)
check('an app grant does not cover the clipboard', clipPermission.behavior === 'ask' && clipReads === 0, JSON.stringify(clipPermission))
const clipDenied = await ComputerTool.checkPermissions({ action: 'read', clipboard: true } as never, toolContext({ deny: ['Computer(clipboard)'] }))
check('clipboard deny wins before any text is read', clipDenied.behavior === 'deny' && clipReads === 0, JSON.stringify(clipDenied))
const clipboard = await call({ action: 'read', clipboard: true })
check('clipboard is read only when explicitly selected', clipboard.outcome === 'succeeded' && clipboard.result === 'read clipboard: "copied value"' && clipReads === 1, clipboard.result)
const wrong = await ComputerTool.validateInput!({ ...input, clipboard: true } as never, context)
check('clipboard and element are mutually exclusive', !wrong.result, JSON.stringify(wrong))
const originalRead = driver.readElement
driver.readElement = async () => ({ ok: true, value: { text: 'x'.repeat(20001), title: 'Webhook URL', role: 'AXTextField' } })
const capped = await call(input)
check('long reads name their cut and keep 20000 characters', capped.outcome === 'succeeded' && capped.result.includes('x'.repeat(20000)) && !capped.result.includes('x'.repeat(20001)) && capped.result.endsWith('truncated: read stops at 20000 characters'), capped.result.slice(-100))
driver.readElement = async () => ({ ok: true, value: { text: '', title: 'Webhook URL', role: 'AXTextField' } })
const empty = await call(input)
check('an empty field is an empty value, not missing', empty.outcome === 'succeeded' && empty.result === 'read "Webhook URL": ""', empty.result)
driver.readElement = async (...args) => { const answer = await originalRead(...args); front = { ...app, windowId: 'other' }; return answer }
const moved = await call(input)
check('window change discards the value', moved.outcome === 'failed' && !moved.result.includes(long) && moved.result.includes('window changed'), moved.result)
driver.readElement = originalRead
front = { identity: 'com.example.Terminal', name: 'Terminal', pid: 200, windowId: 'own', title: 'session', bounds: app.bounds }
driver.ownTerminalApplication = async () => ({ ok: true, value: front })
session.forgetDesktopOwner(owner)
const focus = { action: 'focusApp', focusApp: { name: 'Browser' } }
const focusPermission = await ComputerTool.checkPermissions(focus as never, context)
check('focus from the own terminal asks for the destination app', focusPermission.behavior === 'ask' && focusPermission.message?.includes('Browser') && activations === 0, JSON.stringify(focusPermission))
const focused = await call(focus)
check('focus names the app actually brought in front', focused.outcome === 'succeeded' && focused.result === 'focusApp: Browser — Routine' && activations === 1, focused.result)
const deniedContext = toolContext({ deny: ['Computer(app:com.example.Browser)'] })
const denied = await ComputerTool.checkPermissions(focus as never, deniedContext)
check('focus respects destination deny before activation', denied.behavior === 'deny' && activations === 1, JSON.stringify(denied))
const absent = await call({ action: 'focusApp', focusApp: { name: 'Missing' } })
check('missing running app fails without launching or guessing', absent.outcome === 'failed' && activations === 1, absent.result)
session.forgetDesktopOwner(owner)
context = toolContext()
await ComputerTool.checkPermissions(focus as never, context)
driver.findApplication = async () => ({ ok: true, value: { ...app, identity: 'com.example.Other' } })
const changed = await call(focus)
check('destination identity change after ask refuses', changed.outcome === 'failed' && activations === 1, changed.result)
const prompt = await ComputerTool.prompt()
check('prompt gives the two-act loop breaker', prompt.includes('After the same act twice with an unchanged result, read the screen before acting again.'), prompt)
finish('prove-computer-read-focus')
