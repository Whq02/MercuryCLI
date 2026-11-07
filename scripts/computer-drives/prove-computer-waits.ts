import { check, finish, section } from '../computer/computerProofKit.ts'
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
for (const until of [{ gone: true }, { title: '' }, { url: '', text: 'Ready' }, { title: 'Ready', name: 'Ready' }, { dialog: false }, { dialog: true, focus: 'AXTextField' }, { focus: '' }, { focus: 'AXTextField', gone: true }]) {
  const verdict = await ComputerTool.validateInput!({ action: 'wait', until } as never, context)
  check('ill-formed condition refuses before polling', !verdict.result, JSON.stringify(until))
}

section('a dialog condition and a focus condition: the stop line for a click whose effect the model assumes')
{
  const { allowEverything, toolUseTurn } = await import('../computer/computerToolKit.ts')
  let dialogOpen = false
  let focusedRole: string | null = null
  driver.accessibilityTree = async () => {
    polls++
    const elements = [...structuredClone(tree.elements)]
    if (dialogOpen) elements.push({ depth: 1, role: 'AXGroup (AXApplicationDialog)', title: 'Open', value: null, frame: { x: 200, y: 200, width: 600, height: 400 } })
    return { ok: true, value: { ...structuredClone(tree), elements, focused: focusedRole ? { depth: 2, role: focusedRole, title: 'Name', value: '', frame: { x: 10, y: 10, width: 100, height: 20 }, focused: true } : null } }
  }
  for (const until of [{ dialog: true }, { focus: 'AXTextField' }, { dialog: true, gone: true }]) {
    const parsed = ComputerTool.inputSchema.safeParse({ action: 'wait', until })
    check(`${JSON.stringify(until)} is a legal condition`, parsed.success, JSON.stringify(parsed))
  }
  const noDialog = await call({ dialog: true }, 20)
  check('dialog: true times out while no dialog is open and says so', noDialog.outcome === 'failed' && noDialog.result.includes('timed out') && noDialog.result.includes('dialog open'), noDialog.result)
  const closed = await call({ dialog: true, gone: true }, 20)
  check('dialog gone passes at once while none is open', closed.outcome === 'succeeded' && closed.result.includes('dialog gone'), closed.result)
  dialogOpen = true
  const opened = await call({ dialog: true }, 20)
  check('dialog: true passes once a dialog element is in the tree', opened.outcome === 'succeeded' && opened.result.includes('dialog open'), opened.result)
  const stillOpen = await call({ dialog: true, gone: true }, 20)
  check('dialog gone times out while the dialog stays', stillOpen.outcome === 'failed' && stillOpen.result.includes('dialog gone'), stillOpen.result)
  dialogOpen = false
  const unfocused = await call({ focus: 'AXTextField' }, 20)
  check('focus times out while nothing of that role has focus', unfocused.outcome === 'failed' && unfocused.result.includes('focus AXTextField'), unfocused.result)
  focusedRole = 'AXButton'
  const otherRole = await call({ focus: 'AXTextField' }, 20)
  check('focus on another role does not pass', otherRole.outcome === 'failed', otherRole.result)
  focusedRole = 'AXTextField'
  const focused = await call({ focus: 'axtextfield' }, 20)
  check('focus passes on the focused role, case-insensitively', focused.outcome === 'succeeded' && focused.result.includes('focus axtextfield'), focused.result)
  let typed = 0
  const typeText = driver.typeText.bind(driver)
  driver.typeText = async (...args) => { typed++; return typeText(...args) }
  const steps = [{ action: 'key', key: 'Enter' }, { action: 'wait', until: { dialog: true }, durationMs: 20 }, { action: 'type', text: '/tmp/resume.pdf' }]
  const sequence = async () => resultOf(await ComputerTool.call({ action: 'sequence', steps, capture: false, settleMs: 0 } as never, context, allowEverything, toolUseTurn('waits-sequence', 'Computer', { action: 'sequence', steps }) as never))
  const stopped = await sequence()
  check('a sequence stops at the unmet dialog condition before typing (the lost upload click)', stopped.outcome === 'failed' && stopped.result.includes('1/3') && stopped.result.includes('timed out') && typed === 0, stopped.result)
  dialogOpen = true
  const carried = await sequence()
  check('with the dialog open the same sequence types into it', carried.outcome === 'succeeded' && carried.result.includes('3/3') && typed === 1, carried.result)
  driver.typeText = typeText
  const schema = (ComputerTool.inputJSONSchema as { properties: { until: { description: string }; steps: { description: string } } }).properties
  const prompt = await ComputerTool.prompt({ getToolPermissionContext: async () => context.getAppState().toolPermissionContext, tools: [], agents: [] })
  check('the words tell the model when to reach for until', /dialog/.test(schema.until.description) && /focus/.test(schema.until.description) && /click whose effect you assume/.test(prompt) && /stops at its timeout/.test(prompt) && /wait-until timeout/.test(schema.steps.description), `${schema.until.description}\n${prompt}`)
}
finish('prove-computer-waits')
