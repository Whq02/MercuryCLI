import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'
import type { DesktopDriver } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const scratch = scratchDir('root-and-label')
const bounds = { x: 0, y: 30, width: 1920, height: 956 }
const app = { identity: 'com.example.Browser', name: 'Browser', pid: 4242, windowId: 'profile', title: 'Jane Example | Profile', bounds }
const area = (title: string, y: number, child: Record<string, unknown>) => ({ role: 'AXWebArea', title, frame: { x: 0, y, width: 1920, height: 200 }, children: [child] })
const scene = join(scratch, 'scene.json')
writeFileSync(scene, JSON.stringify({
  displays: [{ index: 0, id: 'profile', originX: 0, originY: 0, width: 1920, height: 1080, scale: 2, primary: true }],
  frontmost: app,
  cursor: { x: 50, y: 50 },
  lines: ['Profile'],
  tree: [{ role: 'AXWindow', title: app.title, focused: true, frame: bounds, children: [
    { role: 'AXGroup', frame: bounds, children: [
      area('Jane Example | Profile', 100, { role: 'AXHeading', title: 'Jane Example', frame: { x: 20, y: 110, width: 300, height: 30 } }),
      area('Forum', 300, { role: 'AXStaticText', value: 'Forum posts', frame: { x: 20, y: 310, width: 300, height: 20 } }),
      area('Ads', 500, { role: 'AXLink', title: 'Sponsored', frame: { x: 20, y: 510, width: 100, height: 20 } }),
      area('Messages', 700, { role: 'AXButton', title: 'Compose', frame: { x: 20, y: 710, width: 100, height: 20 } }),
    ] },
  ] }],
}))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
const context = toolContext()
let serial = 0
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`root-${++serial}`, 'Computer', input) as never))
const rows = (result: string) => result.split('\n').filter(line => /^\s*\[\d+\]/.test(line))
const PATH_TOKEN = /\/[^\s'"`)]+/

section('§1 tree root.nth picks the nth of several matching roots')
{
  const ambiguous = await call({ action: 'tree', root: { role: 'AXWebArea' } })
  check('four web areas with no nth still refuse as ambiguous', ambiguous.outcome === 'failed' && ambiguous.result.includes('4 matches') && ambiguous.result.includes('nth'), ambiguous.result)
  const second = await call({ action: 'tree', root: { role: 'AXWebArea', nth: 2 } })
  check('nth 2 roots the read at the second web area', second.outcome === 'succeeded' && rows(second.result)[0]?.includes('AXWebArea "Forum"') === true && second.result.includes('Forum posts') && !second.result.includes('Sponsored') && !second.result.includes('Jane Example | Profile"'), second.result)
  const first = await call({ action: 'tree', root: { role: 'AXWebArea', nth: 1 } })
  check('nth 1 roots the read at the first web area', first.outcome === 'succeeded' && rows(first.result)[0]?.includes('AXWebArea "Jane Example | Profile"') === true && first.result.includes('AXHeading "Jane Example"') && !first.result.includes('Forum'), first.result)
  const outside = await call({ action: 'tree', root: { role: 'AXWebArea', nth: 5 } })
  check('nth 5 of four is refused as outside, not as ambiguous', outside.outcome === 'failed' && outside.result.includes('nth 5 is outside') && !outside.result.includes('ambiguous'), outside.result)
  const named = await call({ action: 'find', root: { role: 'AXWebArea', name: 'Ads' }, target: { role: 'AXLink' } })
  check('a named root still works without nth', named.outcome === 'succeeded' && named.result.includes('Sponsored'), named.result)
  const found = await call({ action: 'find', root: { role: 'AXWebArea', nth: 4 }, target: { role: 'AXButton' } })
  check('find honours root.nth too', found.outcome === 'succeeded' && found.result.includes('Compose') && rows(found.result).length === 1, found.result)
  const missing = await call({ action: 'tree', root: { role: 'AXWebArea', name: 'Nowhere' } })
  check('a root with no match keeps the read-tree remedy, not a nearest-text list', missing.outcome === 'failed' && missing.result.includes('0 matches — read tree or take a screenshot') && !missing.result.includes('nearest'), missing.result)
}

section('§2 label is accepted where a capture is taken and refused where none is')
{
  const steps = [{ action: 'click', target: { role: 'AXButton', name: 'Compose' } }, { action: 'type', text: 'hello' }]
  const accepted = await ComputerTool.validateInput!({ action: 'sequence', steps, capture: true, label: 'top-fields' } as never, context)
  check('a captured sequence takes a label', accepted.result === true, JSON.stringify(accepted))
  const captured = await call({ action: 'sequence', steps, capture: true, label: 'top-fields', settleMs: 0 })
  check('the final capture of the sequence carries the label in its file name', captured.outcome === 'succeeded' && typeof captured.imagePath === 'string' && basename(captured.imagePath).includes('top-fields'), `${captured.imagePath ?? ''}\n${captured.result}`)
  const implicit = await call({ action: 'sequence', steps, label: 'default-capture', settleMs: 0 })
  check('a sequence with no capture field still captures at the end, and the label names that image', implicit.outcome === 'succeeded' && typeof implicit.imagePath === 'string' && basename(implicit.imagePath).includes('default-capture'), `${implicit.imagePath ?? ''}\n${implicit.result}`)
  const waited = await call({ action: 'wait', until: { role: 'AXButton', name: 'Compose' }, durationMs: 500, capture: true, label: 'compose-ready' })
  check('a wait-until capture carries its label', waited.outcome === 'succeeded' && typeof waited.imagePath === 'string' && basename(waited.imagePath).includes('compose-ready'), `${waited.imagePath ?? ''}\n${waited.result}`)
  for (const [label, input] of [
    ['a sequence with capture: false', { action: 'sequence', steps, capture: false, label: 'dropped' }],
    ['a sequence ending in a screenshot step', { action: 'sequence', steps: [...steps, { action: 'screenshot' }], label: 'dropped' }],
    ['a timed wait with neither until nor capture', { action: 'wait', durationMs: 10, label: 'dropped' }],
    ['a wait with capture: false', { action: 'wait', until: { name: 'Compose' }, capture: false, label: 'dropped' }],
    ['a wait step inside a sequence', { action: 'sequence', steps: [...steps, { action: 'wait', durationMs: 10, label: 'dropped' }] }],
    ['a read that takes no capture', { action: 'cursor', label: 'dropped' }],
  ] as const) {
    const verdict = await ComputerTool.validateInput!(input as never, context)
    check(`${label} refuses the label instead of dropping it`, verdict.result === false && verdict.message.includes('label'), JSON.stringify(verdict))
  }
}

section('§3 a native reader failure is one sentence without the command line or the operator paths')
{
  const stack = (head: string, reason: string, code: string) => [
    `${head}: Command failed: /Users/example/.mercury/runtime/builds/0123456789ab-01234567/vendor/node/bin/node -e const a=require(process.argv[1]); Promise.resolve(a[process.argv[2]](...JSON.parse(process.argv[3]))).then(v=>process.stdout.write(JSON.stringify(v??null))) /Users/example/.mercury/runtime/builds/0123456789ab-01234567/vendor/desktop/darwin-arm64/mercury_desktop.node readElement [4242,{"depth":20,"role":"AXStaticText","title":null,"value":"Forum posts","frame":{"x":412,"y":985,"width":735,"height":1},"focused":false}]`,
    '[eval]:1',
    'const a=require(process.argv[1]); Promise.resolve(a[process.argv[2]](...JSON.parse(process.argv[3]))).then(v=>process.stdout.write(JSON.stringify(v??null)))',
    '                                                                    ^',
    '',
    `Error: ${reason}`,
    '    at [eval]:1:69',
    '    at runScriptInThisContext (node:internal/vm:219:10)',
    '    at node:internal/main/eval_string:71:3 {',
    `  code: '${code}'`,
    '}',
    '',
    'Node.js v24.22.1',
  ].join('\n')
  const raw = stack('readElement failed', 'Failed to convert JavaScript value `Null` into rust type `String` on TreeElement.title', 'StringExpected')
  driver.readElement = async () => ({ ok: false, error: { kind: 'defect', note: raw } })
  const read = await call({ action: 'read', target: { role: 'AXStaticText', text: 'Forum posts' } })
  const line = read.result
  check('the read fails with one line', read.outcome === 'failed' && line.startsWith('read failed:') && !line.includes('\n'), line)
  check("the line carries the reader's own reason and code in the one-sentence shape", line.startsWith('read failed: readElement failed — ') && line.includes('TreeElement.title') && line.endsWith('(StringExpected)'), line)
  check('no command line, stack frame or operator path reaches the model', !PATH_TOKEN.test(line) && !line.includes('Command failed') && !line.includes('    at ') && !line.includes('process.argv') && line.length < 400, line)
  const pathed = stack('readElement failed', "Cannot find module '/Users/example/.mercury/runtime/builds/0123456789ab-01234567/vendor/desktop/darwin-arm64/mercury_desktop.node'", 'MODULE_NOT_FOUND')
  driver.readElement = async () => ({ ok: false, error: { kind: 'defect', note: pathed } })
  const stripped = await call({ action: 'read', target: { role: 'AXStaticText', text: 'Forum posts' } })
  check('a path inside the reason is stripped too', stripped.outcome === 'failed' && !PATH_TOKEN.test(stripped.result.replace('<path>', '')) && stripped.result.includes('<path>') && stripped.result.includes('MODULE_NOT_FOUND'), stripped.result)
  const long = stack('readElement failed', `the reader said ${'much '.repeat(120)}more`, 'E_LONG')
  driver.readElement = async () => ({ ok: false, error: { kind: 'defect', note: long } })
  const capped = await call({ action: 'read', target: { role: 'AXStaticText', text: 'Forum posts' } })
  check('an over-long reason is cut to one bounded line', capped.outcome === 'failed' && !capped.result.includes('\n') && capped.result.length <= 'read failed: '.length + 300, `${capped.result.length}: ${capped.result.slice(0, 80)}`)
}

section('§4 the terminal-text road prints a child failure as the same one sentence')
{
  const terminal = { identity: 'com.apple.Terminal', name: 'Terminal', pid: 4100, windowId: 'shell', title: 'shell', bounds: { x: 0, y: 700, width: 1440, height: 200 } }
  const originalFront = driver.frontmostApplication.bind(driver)
  driver.frontmostApplication = async () => ({ ok: true, value: terminal })
  driver.focusedText = async () => ({ ok: false, error: { kind: 'defect', note: `the focused terminal text could not be read: Command failed: /Users/example/.mercury/runtime/builds/0123456789ab-01234567/vendor/node/bin/node -e process.stdout.write(JSON.stringify(require(process.argv[1]).focusedText(Number(process.argv[2])))) /Users/example/.mercury/runtime/builds/0123456789ab-01234567/vendor/desktop/darwin-arm64/mercury_desktop.node 4100\nError: the accessibility element went away\n    at [eval]:1:40 {\n  code: 'GenericFailure'\n}` } })
  const shot = await call({ action: 'screenshot' })
  if (process.platform === 'darwin') check('a terminal screenshot whose focused-text read fails is one line without paths', shot.outcome === 'failed' && !shot.result.includes('\n') && !PATH_TOKEN.test(shot.result) && shot.result.includes('the accessibility element went away') && shot.result.includes('GenericFailure'), shot.result)
  else check('WARN: the terminal road is read on macOS only; this platform took the image road', shot.outcome === 'succeeded', shot.result)
  driver.frontmostApplication = originalFront
  delete (driver as { focusedText?: unknown }).focusedText
}
finish('prove-computer-root-and-label')
