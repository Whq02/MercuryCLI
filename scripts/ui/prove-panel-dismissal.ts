import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

process.env.NODE_ENV = 'test'
const root = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const source = (file: string) => ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
function nodes<T extends ts.Node>(file: ts.Node, test: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node): void => { if (test(node)) found.push(node); ts.forEachChild(node, visit) }
  visit(file)
  return found
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
}
const panels: Record<string, [string, string]> = {
  'command-palette': ['MercuryCommandPalette.tsx', 'elevated CommandCenter'],
  'model-picker': ['MercuryModelPicker.tsx', 'own surface'],
  'compact-work': ['tasks/BackgroundTasksDialog.tsx', 'modal slot'],
  'input-atlas': ['MercuryInputAtlas.tsx', 'modal slot'],
  'config': ['MercuryConfig.tsx', 'modal slot'],
  'quick-open': ['MercuryQuickOpen.tsx', 'showcase specimen inside the modal slot'],
  'settings': ['Settings/Settings.tsx', 'own surface'],
  'search': ['MercurySearch.tsx', 'modal slot'],
  'resume': ['MercuryResume.tsx', 'modal slot'],
  'center:${view}': ['mercury-ui/components.tsx', 'elevated CommandCenter or modal slot'],
  'file-open': ['MercuryFileOpen.tsx', 'elevated CommandCenter'],
  'board': ['mercury-ui/useNavigablePanes.ts', 'hosted navigation, modal slot or route'],
  'files-menu': ['MercuryFilesMenu.tsx', 'FilesMenuSlot'],
  'list': ['mercury-ui/useInteractiveList.ts', 'hosted navigation, modal slot or route'],
  'teams-dialog': ['teams/TeamsDialog.tsx', 'Dialog'],
  'content-search': ['MercuryContentSearch.tsx', 'elevated CommandCenter'],
  'feedback-review': ['Feedback.tsx', 'modal slot'],
}
const exemptions: Record<string, [string, string]> = {
  'surface:${kind}': ['SurfaceRouter.tsx', 'full-screen route, no chat outside its frame'],
  'cap-offer': ['CapOfferCard.tsx', 'in-flow capacity offer, not a panel over the chat'],
  'slot-offer': ['SlotOfferCard.tsx', 'in-flow slot offer, not a panel over the chat'],
  'effort-strip': ['SubModelPicker.tsx', 'composer effort strip, not a panel over the chat'],
  'concourse-trust-ask': ['concourse/ConcourseScreen.tsx', 'the ground is the Concourse, not the chat'],
  'concourse-capacity-ask': ['concourse/ConcourseScreen.tsx', 'the ground is the Concourse, not the chat'],
  'concourse-help': ['concourse/ConcourseScreen.tsx', 'the ground is the Concourse, not the chat'],
  'concourse-ground': ['concourse/GroundPicker.tsx', 'the ground is the Concourse, not the chat'],
  'concourse-session-model': ['concourse/RowPickModal.tsx', 'the ground is the Concourse, not the chat'],
  'select': ['CustomSelect/use-select-input.ts', 'a control inside its owning dialog, not an independent frame'],
  'multi-select': ['CustomSelect/use-multi-select-state.ts', 'a control inside its owning dialog, not an independent frame'],
}
const seen = new Set<string>()
for (const path of files(join(root, 'src', 'components'))) {
  const file = source(relative(root, path))
  const names = new Set(nodes(file, ts.isImportSpecifier).filter(n => (n.propertyName ?? n.name).text === 'useRegisterOverlay').map(n => n.name.text))
  for (const call of nodes(file, ts.isCallExpression).filter(n => ts.isIdentifier(n.expression) && names.has(n.expression.text))) {
    const id = call.arguments[0]?.getText(file).slice(1, -1) ?? ''
    const spec = panels[id] ?? exemptions[id]
    const actual = relative(join(root, 'src', 'components'), path).replaceAll('\\', '/')
    check(`registration ${id} has an explicit panel host or exemption`, spec !== undefined && spec[0] === actual, spec?.[1] ?? actual)
    seen.add(id)
  }
}
for (const id of [...Object.keys(panels), ...Object.keys(exemptions)]) check(`census entry ${id} still names live code`, seen.has(id))
function calls(file: string, name: string): ts.CallExpression[] {
  return nodes(source(file), ts.isCallExpression).filter(n => ts.isIdentifier(n.expression) && n.expression.text === name)
}
function jsx(file: string, name: string): (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] {
  return nodes(source(file), (n): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement => (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText() === name)
}
for (const file of ['FullscreenLayout.tsx', 'FilesMenuSlot.tsx', 'MercuryModelPicker.tsx', 'Settings/Settings.tsx', 'design-system/Dialog.tsx', 'mercury-ui/components.tsx']) {
  const path = `src/components/${file}`
  const refs = calls(path, 'useElevatedSurface').map(call => ts.isVariableDeclaration(call.parent) ? call.parent.name.getText() : '')
  const attached = jsx(path, 'Box').flatMap(box => box.attributes.properties.filter((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText() === 'ref'))
  check(`${file} attaches the shared surface seam to its frame`, refs.length > 0 && refs.every(ref => ref !== '' && attached.some(prop => nodes(prop, ts.isIdentifier).some(id => id.text === ref))))
}
for (const file of ['mercury-ui/screens/CrewView.tsx', 'tasks/BackgroundTasksDialog.tsx']) {
  check(`${file} uses the shared command frame`, jsx(`src/components/${file}`, 'CommandCenter').length > 0)
}
for (const file of ['MercuryCommandPalette.tsx', 'MercuryFileOpen.tsx', 'MercuryContentSearch.tsx']) {
  check(`${file} raises its frame outside the modal slot`, jsx(`src/components/${file}`, 'CommandCenter').some(n => n.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText() === 'elevated')))
}
check('the chat hosts its panels in the modal slot', jsx('src/screens/REPL.tsx', 'FullscreenLayout').some(n => n.attributes.properties.some(p => ts.isJsxAttribute(p) && p.name.getText() === 'modal')))

const layer = await import('../../src/ink/recessLayer.js')
const stack = await import('../../src/context/overlayStack.js')
const { nodeCache } = await import('../../src/ink/node-cache.js')
const { handleMouseEvent, default: App } = await import('../../src/ink/components/App.js')
const { createSelectionState } = await import('../../src/ink/geometry/selection.js')
stack.resetOverlayStackForTests()
const outer = {} as never
const inner = {} as never
nodeCache.set(outer, { x: 0, y: 15, width: 120, height: 25 })
nodeCache.set(inner, { x: 2, y: 16, width: 116, height: 23 })
const closeOuter = layer.registerElevatedSurface(outer)
check('a crew or tasks host alone supplies both halves', stack.anyModalOverlayActive() && layer.hasElevatedSurface(), JSON.stringify({ stack: stack.overlayStackSnapshot(), inside: layer.elevatedSurfaceContains(0, 15), outside: layer.elevatedSurfaceContains(0, 14) }))
check('surface registration does not own keyboard focus', stack.topOverlay() === null)
let focusReturns = 0
const input = stack.pushOverlay({ id: 'panel-control', modal: true, onFocusReturn: () => focusReturns++ })
const closeInner = layer.registerElevatedSurface(inner)
check('a frame mounted after its control cannot steal its keys', stack.topOverlay()?.token === input)
check('inner frame edge stays inside', layer.elevatedSurfaceContains(2, 16) === true && layer.elevatedSurfaceContains(117, 38) === true)
check('host padding is outside the inner frame', layer.elevatedSurfaceContains(1, 16) === false && layer.elevatedSurfaceContains(118, 38) === false)
stack.popOverlay(input)
check('surface registration cannot swallow focus return', focusReturns === 1)
closeInner()

let escapes = 0
let beneath = 0
let selections = 0
const selection = createSelectionState()
const app = new App({ selection, stdin: { isTTY: true }, stdout: {}, dispatchClick: () => { beneath++; return false }, getHyperlinkAt: () => { beneath++; return 'https://example.invalid' }, openHyperlink: () => { beneath++ }, dispatchHover: () => {}, notifySelectionChange: () => {}, handleSelectionStart: () => { selections++ }, handleSelectionDrag: () => { selections++ }, handleSelectionRelease: () => { selections++; return false }, handleMultiClick: () => { selections++ } } as never)
app.pressEscape = () => { escapes++ }
const mouse = (action: 'press' | 'release', col: number, row: number, button = 0) => handleMouseEvent(app, { kind: 'mouse', action, col, row, button } as never)
mouse('press', 1, 15)
mouse('press', 2, 15, 32)
mouse('release', 2, 15)
check('outside press, motion and release close once and touch nothing beneath', escapes === 1 && beneath === 0 && selections === 0, JSON.stringify({ escapes, beneath, selections }))
mouse('press', 1, 15)
mouse('release', 1, 15)
check('a second outside click is a second close, never multi-selection', escapes === 2 && selections === 0)
closeOuter()
check('unmount removes both registrations', !stack.anyOverlayActive() && !layer.hasElevatedSurface() && layer.elevatedSurfaceContains(1, 1) === null)
console.log(`${seen.size} registrations; ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
