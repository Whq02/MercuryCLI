import { FakeDesktopDriver, FAKE_SCENE_DEFAULT, type FakeScene } from '../../src/services/desktop/fakeDesktopDriver.ts'
import type { DesktopApplication, DesktopBounds, DesktopDriver, DesktopPoint } from '../../src/services/desktop/driver.ts'

export type Call = Record<string, unknown>
const ROUTINE = 'Example webhook routine'
export const DIALOG = 'Webhook configuration'
export const CARD = `Open routine ${ROUTINE}`
const VALUE_LABELS = ['Webhook URL', 'Webhook key'] as const
export const VALUES = [
  `https://fixture.invalid/ingest/${'example-route-'.repeat(26)}end-of-url`,
  `not-a-real-key-${'example-value-'.repeat(26)}end-of-key`,
] as const
export const CONTROL_BASE = '60c52feca8'
export const CONTROL = { calls: 44, resultCharacters: 114156, resultBytes: 116947, refusals: 11, shapeRefusals: 5, identicalPixelClicks: 10, identicalTriggerClicks: 10 }

const wait = (durationMs: number, until?: Call): Call => ({ action: 'wait', durationMs, ...(until ? { until } : {}) })
const pixel = (x: number, y: number): Call => ({ action: 'click', x, y })
const target = (role: string, name: string): Call => ({ action: 'click', target: { role, name } })
const captured = (input: Call, settleMs: number): Call => ({ ...input, capture: true, settleMs })
const tree = (depth: number, limit: number, scope?: string): Call => ({ action: 'tree', depth, limit, ...(scope ? { scope } : {}) })
const sequence = (steps: Call[], capture = true, settleMs?: number): Call => ({ action: 'sequence', steps, capture, ...(settleMs === undefined ? {} : { settleMs }) })
const navigation = (): Call[] => [target('AXLink', 'Automations'), wait(4000, { text: ROUTINE }), pixel(380, 183)]
const trigger = (): Call => target('AXButton', 'When a webhook fires')
const triggerWait = (durationMs = 3000): Call => wait(durationMs, { role: 'AXButton', name: 'When a webhook fires' })
const escape = (): Call => ({ action: 'key', key: 'Escape' })
const switchKey = process.platform === 'darwin' ? 'cmd+Tab' : 'alt+Tab'

export function controlCalls(): Call[] {
  return [
    { action: 'frontmost' },
    { action: 'screenshot', scale: 0.5 },
    captured(pixel(37, 238), 2500),
    { action: 'displays' },
    { action: 'screenshot', full: true, scale: 0.5 },
    { action: 'screenshot', full: true, scale: 0.5 },
    { ...captured({ action: 'key', key: switchKey }, 1500), full: true, scale: 0.5 },
    { ...captured({ action: 'key', key: switchKey }, 1500), scale: 0.5 },
    { action: 'key', key: switchKey, settleMs: 1500 },
    { action: 'screenshot', full: true, scale: 0.5 },
    { ...captured(pixel(42, 156), 2500), scale: 0.5 },
    captured(pixel(42, 156), 2500),
    { ...wait(3000), capture: true },
    captured(pixel(380, 183), 3000),
    captured(pixel(480, 188), 2500),
    sequence([pixel(42, 141), wait(3000, { text: ROUTINE }), { action: 'click', target: { text: ROUTINE } }, wait(3000, { text: 'When a webhook fires' })]),
    { action: 'screenshot' },
    { ...pixel(380, 183), settleMs: 2500 },
    { action: 'find', target: { text: 'webhook' }, depth: 24, limit: 400 },
    captured(trigger(), 2500),
    sequence([pixel(42, 141), wait(3000, { text: 'On Webhook events' }), pixel(380, 183), triggerWait(), tree(14, 300)], false),
    captured(target('AXPopUpButton', 'More automation actions'), 1500),
    sequence([escape(), wait(800), { action: 'scroll', x: 480, y: 320, dy: 10 }, wait(1200)]),
    captured(pixel(419, 119), 2000),
    sequence([pixel(381, 119), triggerWait(1500), trigger(), wait(2500), tree(20, 500)]),
    sequence([...navigation(), triggerWait(), trigger(), wait(1500), { action: 'find', target: { text: 'http' }, depth: 26, limit: 600 }]),
    sequence([...navigation(), triggerWait(), tree(30, 900, 'window')], false),
    sequence([trigger(), wait(1200), { action: 'find', target: { text: 'key' }, depth: 30, limit: 900 }, { action: 'find', target: { text: 'URL' }, depth: 30, limit: 900 }], true, 300),
    sequence([...navigation(), wait(3000, { role: 'AXPopUpButton', name: 'More automation actions' }), target('AXPopUpButton', 'More automation actions'), wait(1200), tree(30, 900, 'app')]),
    sequence([escape(), wait(700), trigger(), wait(1000), { action: 'screenshot' }], true, 300),
    sequence([escape(), wait(700), trigger(), wait(1200)], true, 300),
    sequence([target('AXButton', 'New Bot'), wait(2000), tree(26, 700)], true, 400),
    captured(pixel(163, 58), 2000),
    captured(pixel(480, 366), 2500),
    captured(pixel(555, 149), 2000),
    sequence([escape(), wait(700), ...navigation(), triggerWait(), trigger(), wait(1500)], true, 400),
    sequence([...navigation(), triggerWait(), trigger(), wait(2000, { text: 'key' }), tree(32, 900, 'window')], true, 300),
    sequence([...navigation(), triggerWait(), trigger(), wait(400)], true, 100),
    sequence([target('AXButton', CARD), triggerWait(), target('AXRadioButton', 'Runs'), wait(2500), tree(40, 900, 'window')], true, 300),
    sequence([target('AXButton', CARD), triggerWait(), target('AXRadioButton', 'Runs'), wait(2500), tree(32, 900, 'window')], true, 300),
    tree(32, 900),
    captured(trigger(), 100),
    sequence([...navigation(), wait(3000, { role: 'AXRadioButton', name: 'Runs' }), target('AXRadioButton', 'Runs'), wait(2500)], true, 300),
    { action: 'screenshot' },
  ]
}

export function targetCalls(): Call[] {
  return [
    { action: 'screenshot', scale: 0.5 },
    { ...captured(target('AXLink', 'Automations'), 0), scale: 0.5, full: true, display: 0 },
    { action: 'tree', root: { role: 'AXWebArea', name: 'Automations' }, depth: 40, limit: 900 },
    { action: 'click', ref: 0, capture: false, verify: true },
    sequence([wait(500, { title: 'Automations' }), { action: 'screenshot' }], true, 0),
    { action: 'read', target: { role: 'AXTextField', name: VALUE_LABELS[0] } },
    { action: 'read', target: { role: 'AXTextField', name: VALUE_LABELS[1] } },
  ]
}

type Node = FakeScene['tree'][number]
const WINDOW: DesktopBounds = { x: 0, y: 30, width: 1920, height: 960 }
const APP: DesktopApplication = { identity: 'org.example.Browser', name: 'Fixture Browser', pid: 4200, title: 'Chat', windowId: 'browser', bounds: WINDOW }
const TERMINAL: DesktopApplication = { identity: 'com.apple.Terminal', name: 'Terminal', pid: 4100, title: 'Fixture terminal', windowId: 'terminal', tty: '/dev/fixture', bounds: WINDOW }
const node = (role: string, title?: string, frame?: DesktopBounds, children?: Node[]): Node => ({ role, ...(title === undefined ? {} : { title }), ...(frame ? { frame } : {}), ...(children ? { children } : {}) })
const frame = (x: number, y: number, width = 200, height = 30): DesktopBounds => ({ x, y, width, height })
const wrap = (depth: number, child: Node): Node => depth === 0 ? child : node('AXGroup', undefined, WINDOW, [wrap(depth - 1, child)])
const inside = (p: DesktopPoint, b: DesktopBounds): boolean => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height

export function installTurnBudgetDesktop(driver: DesktopDriver) {
  let page: 'Chat' | 'Automations' = 'Chat'
  let dialog = false
  let terminal = false
  let changeDuringCapture = false
  let changedWindow = false
  let focused = 'Message'
  let backend: FakeDesktopDriver
  const events: Array<{ action: string; page: string; dialog: boolean }> = []
  const traces: Array<{ action: string; detail: unknown }> = []
  const app = (): DesktopApplication => terminal ? TERMINAL : { ...APP, title: page, windowId: changedWindow ? 'other-window' : APP.windowId }
  const treeForPage = (): Node[] => {
    const card = node('AXButton', CARD, frame(660, 350, 260, 80), [node('AXStaticText', ROUTINE, frame(680, 370))])
    const sidebar = node('AXGroup', 'Navigation', frame(0, 100, 230, 800), [node('AXLink', 'Automations', frame(50, 270, 140, 65)), node('AXButton', 'New Bot', frame(20, 100)), node('AXButton', 'New Bot', frame(20, 170))])
    const words = ['This', ' ', 'is', ' ', 'a', ' ', 'fixture', ' ', 'conversation', ' ', 'with', ' ', 'ordinary', ' ', 'text', ' ', 'only', '.']
    const messages = Array.from({ length: 12 }, (_, i) => wrap(8, node('AXGroup', undefined, frame(260, 160 + i * 35, 800, 32), words.map((word, j) => node('AXStaticText', word, frame(270 + j * 30, 165 + i * 35, 30, 20))))))
    const fields = VALUE_LABELS.map((label, i) => node('AXGroup', undefined, frame(700, 520 + i * 90, 680, 70), [node('AXStaticText', label, frame(710, 520 + i * 90)), { ...node('AXTextField', label, frame(710, 550 + i * 90, 660, 30)), value: VALUES[i] }]))
    const dialogNode = wrap(3, node('AXApplicationDialog', DIALOG, frame(620, 200, 800, 630), [
      { ...node('AXRadioButton', 'Overview', frame(700, 230)), focused: focused === 'Overview' },
      node('AXButton', 'When a webhook fires', frame(920, 350, 330, 90)),
      node('AXPopUpButton', 'More automation actions', frame(1300, 230, 100, 30)),
      node('AXTabGroup', 'Configuration', frame(650, 420, 740, 380), [wrap(4, node('AXGroup', 'Webhook details', frame(680, 490, 700, 260), page === 'Automations' ? fields : [node('AXStaticText', 'Webhook URL and key are in the automation configuration', frame(700, 500))]))]),
    ]))
    const area = node('AXWebArea', page, WINDOW, [sidebar, node('AXStaticText', 'On Webhook events', frame(300, 120)), card, ...(page === 'Chat' ? messages : []), ...(dialog ? [dialogNode] : []), { ...node('AXTextArea', 'Message', frame(280, 860, 1200, 70)), focused: focused === 'Message' }])
    return [
      { ...node('AXWindow', page, WINDOW, [node('AXToolbar', 'Browser controls', frame(0, 30, 1920, 60), [{ ...node('AXTextField', 'Address', frame(200, 45, 1400, 30)), value: `https://fixture.invalid/${page.toLowerCase()}` }]), wrap(7, area)]), focused: true },
      node('AXMenuBar', undefined, frame(0, 990, 1920, 0), Array.from({ length: 351 }, (_, i) => node('AXMenuItem', `Fixture menu item ${i + 1}`, frame(0, 990, 0, 0)))),
    ]
  }
  const refresh = () => {
    const scene: FakeScene = { ...structuredClone(FAKE_SCENE_DEFAULT), displays: [{ index: 0, id: 'fixture-display', originX: 0, originY: 0, width: 1920, height: 1080, scale: 1, primary: true }], frontmost: app(), cursor: { x: 0, y: 0 }, ownTerminal: TERMINAL, tree: treeForPage(), lines: ['Fixture Browser', page, dialog ? DIALOG : ''], switches: [], holdMs: 0 }
    backend = new FakeDesktopDriver(scene, null)
  }
  refresh()
  driver.frontmostApplication = async () => ({ ok: true, value: app() })
  driver.ownTerminalApplication = async () => ({ ok: true, value: TERMINAL })
  driver.displays = (...args) => backend.displays(...args)
  driver.cursor = (...args) => backend.cursor(...args)
  driver.keyboardIdleMs = async () => null
  driver.capture = async (...args) => {
    traces.push({ action: 'capture', detail: app().title })
    const shot = await backend.capture(...args)
    if (changeDuringCapture) changedWindow = true
    return shot
  }
  driver.accessibilityTree = async (application, limits, signal) => {
    const answer = await backend.accessibilityTree(application, limits, signal)
    traces.push({ action: 'tree', detail: limits })
    if (answer.ok) for (const element of answer.value.elements) if (element.value) element.value = element.value.slice(0, 300)
    return answer
  }
  Object.assign(driver, { readElement: async (application: DesktopApplication, element: { role: string; title: string | null; frame: DesktopBounds | null }, signal: AbortSignal) => {
    const tree = await backend.accessibilityTree(application, { depth: 32, count: 2000, scope: 'window' }, signal)
    if (!tree.ok) return tree
    const found = tree.value.elements.find(row => row.role === element.role && row.title === element.title && JSON.stringify(row.frame) === JSON.stringify(element.frame))
    traces.push({ action: 'readElement', detail: element.title })
    return { ok: true, value: found ? { role: found.role, title: found.title, text: found.value ?? found.title ?? '' } : null }
  } })
  driver.click = async (...args) => {
    const answer = await backend.click(...args)
    if (!answer.ok) return answer
    const point = args[0]
    if (inside(point, frame(50, 270, 140, 65))) { page = 'Automations'; dialog = false; focused = 'Automations' }
    else if (inside(point, frame(660, 350, 260, 80))) { dialog = true; focused = 'Overview' }
    else if (inside(point, frame(920, 350, 330, 90))) { page = 'Chat'; focused = 'Message' }
    events.push({ action: `click ${point.x},${point.y}`, page, dialog })
    traces.push({ action: 'click', detail: point })
    refresh()
    return answer
  }
  driver.keyTap = async (...args) => {
    const answer = await backend.keyTap(...args)
    if (!answer.ok) return answer
    if (args[0] === 'tab' && args[1].some(modifier => modifier === 'super' || modifier === 'alt')) terminal = false
    events.push({ action: `key ${args[0]}`, page, dialog })
    traces.push({ action: 'key', detail: args[0] })
    refresh()
    return answer
  }
  driver.scroll = (...args) => backend.scroll(...args)
  return {
    events,
    traces,
    beforeCall(index: number, replay: boolean) {
      if (!replay) return
      if (index === 2) { terminal = true; refresh() }
      if (index === 43) changeDuringCapture = true
    },
    shape() {
      const flatten = (nodes: Node[], depth: number): Array<Node & { depth: number }> => nodes.flatMap(row => [{ ...row, depth }, ...flatten(row.children ?? [], depth + 1)])
      const rows = flatten(treeForPage(), 1)
      return { pages: ['Chat', 'Automations'], webAreaDepth: rows.find(row => row.role === 'AXWebArea')?.depth, dialogDepth: rows.find(row => row.role === 'AXApplicationDialog')?.depth, valueDepth: rows.find(row => row.title === VALUE_LABELS[0] && row.role === 'AXTextField')?.depth, menuRows: rows.filter(row => row.role === 'AXMenuItem').length, valueLengths: VALUES.map(value => value.length) }
    },
  }
}
