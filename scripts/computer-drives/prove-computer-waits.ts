import { check, finish } from '../computer/computerProofKit.ts'
import { resultOf, toolContext } from '../computer/computerToolKit.ts'
import type { DesktopTree } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver } = await import('../../src/services/desktop/resolveDriver.ts')
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver
const context = toolContext()
const front = await driver.frontmostApplication()
if (!front.ok) throw new Error(front.error.note)
let title = 'Loading'
driver.frontmostApplication = async () => ({ ok: true, value: { ...front.value, title } })
const tree: DesktopTree = { elements: [{ depth: 0, role: 'AXButton', title: 'Ready', value: null, frame: null }, { depth: 0, role: 'AXTextField', title: 'Address and search bar', value: 'https://example.test/ready', frame: null }], truncated: false, reason: null, webContent: 'available' }
let polls = 0
driver.accessibilityTree = async () => { polls++; if (polls > 1) title = 'Routine settings'; return { ok: true, value: structuredClone(tree) } }
const call = async (until: Record<string, unknown>, durationMs = 500) => resultOf(await ComputerTool.call({ action: 'wait', until, durationMs, capture: false } as never, context))
for (const until of [{ text: 'Ready' }, { role: 'AXButton', name: 'Ready' }, { title: 'Routine settings' }, { url: 'example.test/ready' }]) {
  const parsed = ComputerTool.inputSchema.safeParse({ action: 'wait', until })
  const waited = await call(until)
  check(`${JSON.stringify(until)} is accepted and names its passing condition`, parsed.success && waited.outcome === 'succeeded' && Object.values(until).every(value => waited.result.includes(String(value))), waited.result)
}
const gone = await call({ name: 'Loading', gone: true })
check('gone succeeds only after absence is observed', gone.outcome === 'succeeded' && gone.result.includes('gone "Loading"'), gone.result)
const present = await call({ name: 'Ready', gone: true }, 20)
check('gone times out when the element remains and names last tree size', present.outcome === 'failed' && present.result.includes('timed out') && present.result.includes('gone "Ready"') && present.result.includes('last tree: 2 elements'), present.result)
for (const incomplete of ['truncated', 'pending', 'absent'] as const) {
  tree.truncated = incomplete === 'truncated'
  tree.webContent = incomplete === 'truncated' ? 'available' : incomplete
  const answer = await call({ name: 'Missing', gone: true }, 20)
  check(`${incomplete} tree cannot establish gone`, answer.outcome === 'failed', answer.result)
}
tree.truncated = false
tree.webContent = 'available'
tree.elements[1]!.role = 'AXStaticText'
const pageUrl = await call({ url: 'example.test/ready' }, 20)
check('a URL in page prose is not the current page URL', pageUrl.outcome === 'failed', pageUrl.result)
for (const until of [{ gone: true }, { title: '' }, { url: '', text: 'Ready' }, { title: 'Ready', name: 'Ready' }]) {
  const verdict = await ComputerTool.validateInput!({ action: 'wait', until } as never, context)
  check('ill-formed condition refuses before polling', !verdict.result, JSON.stringify(until))
}
finish('prove-computer-waits')
