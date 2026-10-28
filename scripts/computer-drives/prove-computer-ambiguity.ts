import { check, finish } from '../computer/computerProofKit.ts'
import { resultOf, toolContext } from '../computer/computerToolKit.ts'
import type { DesktopTree, DesktopTreeElement } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver } = await import('../../src/services/desktop/resolveDriver.ts')
const { targetPoint } = await import('../../src/tools/ComputerTool/fastRoad.ts')
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver
const context = toolContext()
const row = (title: string, x: number, depth = 0, role = 'AXButton'): DesktopTreeElement => ({ title, role, depth, value: null, frame: { x, y: 200, width: 40, height: 20 } })
const tree: DesktopTree = { elements: [row('Routine', 200), row('Routine', 300)], truncated: false, reason: null }
driver.accessibilityTree = async () => ({ ok: true, value: tree })
const call = async (target: Record<string, unknown>) => resultOf(await ComputerTool.call({ action: 'click', target } as never, context))
const ambiguous = await call({ text: 'Routine' })
check('ambiguous refusal names both candidates', ambiguous.outcome === 'failed' && ambiguous.result.includes('[1] AXButton "Routine" (220,210)pt') && ambiguous.result.includes('[2] AXButton "Routine" (320,210)pt'), ambiguous.result)
const nth = await call({ text: 'Routine', nth: 2 })
check('nth selects without guessing a pixel', nth.outcome === 'succeeded' && nth.result.includes('(320, 210) pt'), nth.result)
for (const value of [0, -1, 1.5]) {
  const invalid = await ComputerTool.validateInput!({ action: 'click', target: { text: 'Routine', nth: value } } as never, context)
  check('invalid nth refuses', !invalid.result, JSON.stringify(invalid))
}
const missingNth = await call({ text: 'Routine', nth: 3 })
check('out of range nth refuses with available candidates', missingNth.outcome === 'failed' && missingNth.result.includes('[2] AXButton'), missingNth.result)
tree.elements = [row('When a webhook fires', 200, 0), row('When a webhook fires', 200, 1, 'AXStaticText')]
const parent = await call({ text: 'webhook' })
check('interactive parent wins over its own label', parent.outcome === 'succeeded', parent.result)
tree.elements.push(row('When a webhook fires', 200, 0, 'AXStaticText'))
const sibling = await call({ text: 'webhook' })
check('an unrelated label does not permit an implicit choice', sibling.outcome === 'failed' && sibling.result.includes('ambiguous'), sibling.result)
tree.elements = [row('Save', 200), row('Save as', 300), row('Saved items', 350), row('Close', 400), row('Delete', 450)]
const absent = await call({ name: 'Svae' })
check('not found lists the nearest three text matches', absent.outcome === 'failed' && absent.result.includes('nearest 3') && absent.result.includes('"Save"') && absent.result.includes('"Save as"') && absent.result.includes('"Saved items"') && !absent.result.includes('"Delete"'), absent.result)
tree.elements = Array.from({ length: 12 }, (_, index) => row('Open', 100 + index * 10))
const many = await call({ name: 'Open' })
check('candidate list stops at eight', many.result.includes('[8]') && !many.result.includes('[9]'), many.result)
const map = { toolUseId: '', display: 0, displayId: 'fixture', originX: 100, originY: 100, pointWidth: 400, pointHeight: 400, imageWidth: 200, imageHeight: 200, capturedAt: 0 }
const mapped = (targetPoint as Function)(tree, { name: 'Open' }, map)
check('candidate pixels use the screenshot frame', 'refusal' in mapped && mapped.refusal.includes('[1] AXButton "Open" (10,55)px'), JSON.stringify(mapped))
finish('prove-computer-ambiguity')
