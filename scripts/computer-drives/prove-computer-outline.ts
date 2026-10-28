import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir } from '../computer/computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn } from '../computer/computerToolKit.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resetDesktopDriverForTest, resolveDesktopDriver } = await import('../../src/services/desktop/resolveDriver.ts')
const { processPreMappedToolResultBlock } = await import('../../src/utils/toolResultStorage.ts')
const frame = { x: 100, y: 100, width: 800, height: 600 }
const button = { role: 'AXButton', title: 'Save', frame: { x: 200, y: 200, width: 80, height: 24 } }
const dialog = { role: 'AXApplicationDialog', title: 'Routine', frame, children: [
  { role: 'AXGroup', frame, children: [button,
    { role: 'AXStaticText', value: 'Hello', frame: { x: 120, y: 250, width: 30, height: 20 } },
    { role: 'AXStaticText', value: ' ', frame: { x: 150, y: 250, width: 4, height: 20 } },
    { role: 'AXStaticText', value: 'world', frame: { x: 154, y: 250, width: 30, height: 20 } },
    { role: 'AXButton', title: 'Hidden', frame: { x: 200, y: 200, width: 0, height: 0 } },
    { role: 'AXButton', title: 'Outside', frame: { x: 2000, y: 2000, width: 40, height: 24 } },
    { role: 'AXButton (AXCloseButton)', frame: { x: 150, y: 150, width: 16, height: 16 } },
    { role: 'AXTextArea', value: 'Repeated text', frame, children: [{ role: 'AXGroup', frame, children: [{ role: 'AXStaticText', value: 'Repeated text', frame }] }] },
  ] },
] }
let nested: Record<string, unknown> = dialog
for (let i = 0; i < 16; i++) nested = { role: 'AXGroup', frame, children: [nested] }
const scene = {
  frontmost: { identity: 'com.example.Outline', name: 'Outline', pid: 4200, title: 'Window', windowId: '42', bounds: frame },
  tree: [
    { role: 'AXWindow', title: 'Window', focused: true, frame, children: [nested] },
    { role: 'AXMenuBar', frame: { x: 0, y: 0, width: 1440, height: 24 }, children: [{ role: 'AXMenuItem', title: 'History placeholder', frame: { x: 0, y: 900, width: 0, height: 0 } }] },
  ],
}
const scenePath = join(scratchDir('outline'), 'scene.json')
writeFileSync(scenePath, JSON.stringify(scene))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scenePath
resetDesktopDriverForTest()
const context = toolContext()
let calls = 0
async function call(input: Record<string, unknown>) {
  return resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`outline-${++calls}`, 'Computer', input) as never))
}
const tree = await call({ action: 'tree' })
check('default outline reaches a dialog beneath sixteen wrappers', tree.outcome === 'succeeded' && tree.result.includes('AXApplicationDialog "Routine"') && tree.result.includes('AXButton "Save"'), tree.result)
check('numbered kept-depth rows omit wrappers and geometry by default', /\n    \[\d+\] AXApplicationDialog "Routine"\n      \[\d+\] AXButton "Save"/.test(tree.result) && !tree.result.includes('AXGroup') && !tree.result.includes('@') && !tree.result.includes('px'), tree.result)
check('adjacent static-text fragments make one readable row', /AXStaticText "Hello world"/.test(tree.result) && tree.result.split('AXStaticText').length === 2, tree.result)
check('hidden and outside-window rows are absent by default', !tree.result.includes('Hidden') && !tree.result.includes('Outside'), tree.result)
check('unnamed interactive subroles survive the wrapper filter', tree.result.includes('AXButton (AXCloseButton)'), tree.result)
check('duplicate static text stays in its parent exactly once', tree.result.split('Repeated text').length === 2 && tree.result.includes('AXTextArea "Repeated text"'), tree.result)
const duplicateTarget = await call({ action: 'click', target: { role: 'AXStaticText', text: 'Repeated text' } })
check('a suppressed duplicate remains targetable through the underlying tree', duplicateTarget.outcome === 'succeeded', duplicateTarget.result)
const ref = Number(/\[(\d+)\] AXButton "Save"/.exec(tree.result)?.[1])
const clicked = await call({ action: 'click', ref })
check('a numbered row resolves through the target act without a screenshot', clicked.outcome === 'succeeded' && clicked.result.includes('(240, 212) pt'), clicked.result)
const all = await call({ action: 'tree', all: true, scope: 'app' })
check('all:true retains hidden and outside controls but not menu history', all.result.includes('Hidden') && all.result.includes('Outside') && !all.result.includes('History placeholder'), all.result)
check('all:true restores the duplicate static-text row', all.result.includes('AXStaticText "Repeated text"') && all.result.split('Repeated text').length === 3, all.result)
const expired = await call({ action: 'click', ref })
check('an old read cannot silently retarget a number from a new read', expired.outcome === 'failed' && expired.result.includes('0 matches'), expired.result)
const root = Number(/\[(\d+)\] AXApplicationDialog "Routine"/.exec(all.result)?.[1])
const scoped = await call({ action: 'tree', root })
check('root:n starts with the dialog at kept depth zero', /\n\[\d+\] AXApplicationDialog "Routine"\n  \[\d+\] AXButton "Save"/.test(scoped.result) && !scoped.result.includes('AXWindow'), scoped.result)
const named = await call({ action: 'tree', root: { role: 'AXApplicationDialog', name: 'Routine' }, depth: 1 })
check('root selector budgets depth from the dialog', named.outcome === 'succeeded' && /\n  \[\d+\] AXButton "Save"/.test(named.result), named.result)
const found = await call({ action: 'find', target: { role: 'AXButton', name: 'Save' } })
check('find retains the compacted depth, not the raw wrapper indentation', /\n      \[\d+\] AXButton "Save"/.test(found.result) && !found.result.includes('        ['), found.result)
const liveRef = Number(/\[(\d+)\] AXButton "Save"/.exec(found.result)?.[1])
const resolution = resolveDesktopDriver()
if (resolution.state !== 'ok') throw new Error('fixture driver unavailable')
const driver = resolution.driver
const originalTree = driver.accessibilityTree.bind(driver)
driver.accessibilityTree = async (...args) => {
  const answer = await originalTree(...args)
  return answer.ok ? { ...answer, value: { ...answer.value, elements: answer.value.elements.filter(element => element.title !== 'Save') } } : answer
}
const gone = await call({ action: 'click', ref: liveRef })
check('a vanished ref refuses with the existing not-found remedy', gone.outcome === 'failed' && gone.result.includes('0 matches') && gone.result.includes('read tree'), gone.result)
const text = 'visible text '.repeat(4000)
const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'fixture-image' } }
const capped = await processPreMappedToolResultBlock({ type: 'tool_result', tool_use_id: 'outline-image-cap', content: [{ type: 'text', text }, image] }, 'Computer', 20_000)
check('an image cannot bypass the text cap and is retained unchanged', Array.isArray(capped.content) && capped.content.includes(image) && capped.content.some(block => block.type === 'text' && block.text.includes('<persisted-output>') && block.text.includes('root') && block.text.includes('find')) && JSON.stringify(capped.content).length < 20_000, JSON.stringify(capped).slice(0, 400))
finish('prove-computer-outline')
