import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir, section } from './computerProofKit.ts'
import { allowEverything, ownerOf, resultOf, toolContext, toolUseTurn } from './computerToolKit.ts'
import type { DesktopDriver, DesktopTreeElement } from '../../src/services/desktop/driver.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const scratch = scratchDir('file-fill')
const bounds = { x: 0, y: 30, width: 1920, height: 956 }
const app = { identity: 'com.example.Browser', name: 'Browser', pid: 4242, windowId: 'form', title: 'Job application — Example Careers', bounds }
const control = (role: string, title: string, y: number, extra: Record<string, unknown> = {}) => ({ role, title, frame: { x: 400, y, width: 500, height: 32 }, ...extra })
const resume = join(scratch, 'resume.pdf')
writeFileSync(resume, '%PDF-1.4\n')
const scene = join(scratch, 'scene.json')
writeFileSync(scene, JSON.stringify({
  displays: [{ index: 0, id: 'form', originX: 0, originY: 0, width: 1920, height: 1080, scale: 2, primary: true }],
  frontmost: app,
  cursor: { x: 50, y: 50 },
  lines: ['Careers'],
  tree: [{ role: 'AXWindow', title: app.title, focused: true, frame: bounds, children: [
    { role: 'AXWebArea', title: app.title, frame: { x: 0, y: 120, width: 1920, height: 866 }, children: [
      { role: 'AXStaticText', value: 'Tell us about yourself', frame: { x: 400, y: 200, width: 500, height: 20 } },
      control('AXTextField', 'First Name', 300),
      control('AXTextArea', 'Why us', 360, { value: 'old answer' }),
      control('AXTextField', 'Legacy', 420, { settable: false }),
      control('AXSecureTextField', 'Password', 480, { settable: true }),
      control('AXCheckBox', 'Agree', 540, { value: '0' }),
      control('AXPopUpButton', 'Country', 600, { value: 'United Kingdom' }),
      { role: 'AXGroup', title: 'Resume', frame: { x: 400, y: 660, width: 500, height: 80 }, children: [control('AXButton', 'Upload File', 680)] },
      control('AXTextArea', 'Below the fold', 985, { frame: { x: 400, y: 985, width: 500, height: 1 }, visibleFrame: { x: 400, y: 760, width: 500, height: 32 } }),
      control('AXTextArea', 'Collapsed', 985, { frame: { x: 400, y: 985, width: 500, height: 1 } }),
    ] },
  ] }],
}))
process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
resetDesktopDriverForTest()
const resolved = resolveDesktopDriver()
if (resolved.state !== 'ok') throw new Error(resolved.note)
const driver = resolved.driver as DesktopDriver & { acts: { act: string; detail: Record<string, unknown> }[] }
const context = toolContext()
session.forgetDesktopOwner(ownerOf(context))
let serial = 0
const call = async (input: Record<string, unknown>) => resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`file-fill-${++serial}`, 'Computer', input) as never))
const validate = async (input: Record<string, unknown>) => ComputerTool.validateInput!(input as never, context)
const acts = (from: number) => driver.acts.slice(from).filter(a => a.act !== 'accessibilityTree' && a.act !== 'capture' && a.act !== 'releaseAll').map(a => a.act === 'keyTap' ? `keyTap ${[...(a.detail.modifiers as string[]), a.detail.key].join('+')}` : a.act)
const upload = { role: 'AXButton', name: 'Upload File' }
const hostPlatform = process.platform
const asPlatform = (platform: NodeJS.Platform) => Object.defineProperty(process, 'platform', { value: platform, configurable: true })
const goToChord = (platform: string) => (platform === 'darwin' ? 'keyTap super+shift+g,' : platform === 'win32' ? '' : 'keyTap control+l,')
const selectAllChord = (platform: string) => (platform === 'darwin' ? 'keyTap super+a' : 'keyTap control+a')

section('§1 file: one step through the native dialog, with words when the dialog never opened')
{
  for (const [label, input, needle] of [
    ['no path', { action: 'file', target: upload }, 'path'],
    ['a relative path', { action: 'file', target: upload, path: 'resume.pdf' }, 'absolute'],
    ['a path that is not a file', { action: 'file', target: upload, path: join(scratch, 'missing.pdf') }, 'not a file'],
    ['a directory', { action: 'file', target: upload, path: scratch }, 'not a file'],
    ['no control', { action: 'file', path: resume }, 'requires x and y'],
  ] as const) {
    const verdict = await validate(input)
    check(`${label} is refused naming the fault`, verdict.result === false && verdict.message.includes(needle), JSON.stringify(verdict))
  }
  check('a control and an existing absolute path are accepted', (await validate({ action: 'file', target: upload, path: resume })).result === true)
  const originalTree = driver.accessibilityTree.bind(driver)
  let dialog: 'never' | 'opens' | 'stays' | 'one-enter' | 'unreadable' = 'opens'
  const sheet: DesktopTreeElement = { depth: 2, role: 'AXSheet', title: 'Open', value: null, frame: { x: 500, y: 200, width: 900, height: 600 } }
  driver.accessibilityTree = async (...args) => {
    const answer = await originalTree(...args)
    if (!answer.ok || dialog === 'never') return answer
    const clicked = driver.acts.findIndex(a => a.act === 'click' && (a.detail.at as { y: number }).y === 696)
    if (clicked < 0) return answer
    if (dialog === 'unreadable') return { ok: false, error: { kind: 'unavailable', note: 'this platform reads no tree' } }
    const enters = driver.acts.slice(clicked).filter(a => a.act === 'keyTap' && a.detail.key === 'enter').length
    const typed = driver.acts.slice(clicked).some(a => a.act === 'typeText')
    if (dialog === 'opens' && typed && enters >= 2) return answer
    if (dialog === 'one-enter' && typed && enters >= 1) return answer
    return { ...answer, value: { ...answer.value, elements: [...answer.value.elements, sheet] } }
  }
  let from = driver.acts.length
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    asPlatform(platform)
    dialog = 'opens'
    driver.acts.length = 0
    from = driver.acts.length
    const uploaded = await call({ action: 'file', target: upload, path: resume, capture: false })
    check(`${platform}: the upload goes click → dialog → the platform's road to the path → Enter → Enter → dialog gone`, uploaded.outcome === 'succeeded' && uploaded.result.includes('the dialog opened and closed') && uploaded.result.includes('resume.pdf') && acts(from).join(',') === `click,${goToChord(platform)}typeText,keyTap enter,keyTap enter`, `${uploaded.result}\n${acts(from).join(',')}`)
    check(`${platform}: the typed text is the path and nothing else`, driver.acts.slice(from).filter(a => a.act === 'typeText').map(a => a.detail.text).join('|') === resume)
    dialog = 'one-enter'
    driver.acts.length = 0
    from = driver.acts.length
    const oneEnter = await call({ action: 'file', target: upload, path: resume, capture: false })
    check(`${platform}: a dialog that closes on the first Enter gets exactly one Enter, so no key lands on the page behind`, oneEnter.outcome === 'succeeded' && acts(from).join(',') === `click,${goToChord(platform)}typeText,keyTap enter`, `${oneEnter.result}\n${acts(from).join(',')}`)
  }
  asPlatform(hostPlatform)
  driver.acts.length = 0
  dialog = 'never'
  from = driver.acts.length
  const lost = await call({ action: 'file', target: upload, path: resume, durationMs: 200, capture: false })
  check('a click that opens no dialog fails with words and types nothing (the lost upload click)', lost.outcome === 'failed' && lost.result.includes('opened no file dialog within 200ms') && lost.result.includes('nothing typed') && acts(from).join(',') === 'click', `${lost.result}\n${acts(from).join(',')}`)
  from = driver.acts.length
  const stopped = await call({ action: 'sequence', steps: [{ action: 'file', target: upload, path: resume, durationMs: 200 }, { action: 'type', text: 'next field' }], capture: false, settleMs: 0 })
  check('inside a sequence the failed upload stops the sequence before the next keys', stopped.outcome === 'failed' && stopped.result.includes('0/2') && !acts(from).includes('typeText'), stopped.result)
  driver.acts.length = 0
  dialog = 'stays'
  from = driver.acts.length
  const stuck = await call({ action: 'file', target: upload, path: resume, capture: false })
  check('a dialog that stays open after the path fails with words naming it', stuck.outcome === 'failed' && stuck.result.includes('still open') && stuck.result.includes('resume.pdf'), stuck.result)
  driver.acts.length = 0
  dialog = 'unreadable'
  from = driver.acts.length
  const unread = await call({ action: 'file', target: upload, path: resume, durationMs: 200, capture: false })
  check('a tree that cannot be read after the click is unknown, not "no dialog": the words say so and nothing is typed', unread.outcome === 'failed' && unread.result.includes('could not be read') && unread.result.includes('unknown') && !unread.result.includes('opened no file dialog') && acts(from).join(',') === 'click', `${unread.result}\n${acts(from).join(',')}`)
  driver.accessibilityTree = originalTree
  driver.acts.length = 0
  const ownTerminal = driver.ownTerminalApplication.bind(driver)
  driver.ownTerminalApplication = async () => ({ ok: true, value: { ...app } })
  from = driver.acts.length
  const guardedFill = await call({ action: 'fill', target: { role: 'AXTextField', name: 'First Name' }, text: 'never', capture: false })
  const guardedFile = await call({ action: 'file', target: upload, path: resume, capture: false })
  check('fill and file are keystroke acts to the own-terminal guard: both refused in the terminal running this session, nothing sent', guardedFill.outcome === 'failed' && guardedFile.outcome === 'failed' && guardedFill.result.includes('terminal running this session') && guardedFile.result.includes('terminal running this session') && acts(from).length === 0, `${guardedFill.result}\n${guardedFile.result}`)
  driver.ownTerminalApplication = ownTerminal
}

section('§2 fill: the value set through the accessibility API, keystrokes when the element refuses, the value read back')
{
  for (const [label, input, needle] of [
    ['no target', { action: 'fill', text: 'Jane' }, 'target or ref'],
    ['a point instead of a target', { action: 'fill', x: 1, y: 1, text: 'Jane' }, 'fill does not take x'],
    ['no text', { action: 'fill', target: { role: 'AXTextField', name: 'First Name' } }, 'text'],
  ] as const) {
    const verdict = await validate(input)
    check(`${label} is refused naming the fault`, verdict.result === false && verdict.message.includes(needle), JSON.stringify(verdict))
  }
  let from = driver.acts.length
  const filled = await call({ action: 'fill', target: { role: 'AXTextField', name: 'First Name' }, text: 'Jane', capture: false })
  check('a text field takes its value without a click or a keystroke and reads it back', filled.outcome === 'succeeded' && filled.result.includes('value "Jane"') && acts(from).join(',') === 'setValue', `${filled.result}\n${acts(from).join(',')}`)
  const replaced = await call({ action: 'fill', target: { role: 'AXTextArea', name: 'Why us' }, text: 'A long answer\nwith two lines', capture: false })
  check('a text area is replaced, not appended to', replaced.outcome === 'succeeded' && replaced.result.includes('value "A long answer\\nwith two lines"'), replaced.result)
  for (const platform of ['darwin', 'linux'] as const) {
    asPlatform(platform)
    from = driver.acts.length
    const typed = await call({ action: 'fill', target: { role: 'AXTextField', name: 'Legacy' }, text: `typed on ${platform}`, capture: false })
    check(`${platform}: an element that refuses a value is clicked, selected with the platform's chord and typed into, says so and reads the typed value back`, typed.outcome === 'succeeded' && typed.result.includes('by keystrokes') && typed.result.includes(`value "typed on ${platform}"`) && acts(from).join(',') === `setValue,click,${selectAllChord(platform)},typeText`, `${typed.result}\n${acts(from).join(',')}`)
  }
  asPlatform(hostPlatform)
  const secret = await call({ action: 'fill', target: { role: 'AXSecureTextField', name: 'Password' }, text: 'hunter2', capture: false })
  check('a secure field is set and never read back', secret.outcome === 'succeeded' && secret.result.includes('value not read back') && secret.result.includes('secure field') && !secret.result.includes('hunter2'), secret.result)
  from = driver.acts.length
  const clamped = await call({ action: 'fill', target: { role: 'AXTextArea', name: 'Below the fold' }, text: 'scrolled in', capture: false })
  check('an edge-clamped field is scrolled into view and filled in one act, and the words say so', clamped.outcome === 'succeeded' && clamped.result.includes('value "scrolled in"') && clamped.result.includes('scrolled into view first (action)') && acts(from).join(',') === 'scrollToVisible,setValue', `${clamped.result} · ${acts(from).join(',')}`)
  from = driver.acts.length
  const collapsed = await call({ action: 'fill', target: { role: 'AXTextArea', name: 'Collapsed' }, text: 'never', capture: false })
  check('a field that stays a strip after the scroll is refused honestly before anything is set', collapsed.outcome === 'failed' && collapsed.result.includes('was scrolled (action) and is still clipped: the target is squashed to a strip') && collapsed.result.includes('collapsed or covered') && acts(from).join(',') === 'scrollToVisible', `${collapsed.result} · ${acts(from).join(',')}`)
  const setValue = driver.setValue
  driver.setValue = undefined as never
  for (const platform of ['darwin', 'linux'] as const) {
    asPlatform(platform)
    from = driver.acts.length
    const without = await call({ action: 'fill', target: { role: 'AXTextField', name: 'First Name' }, text: 'Janet', capture: false })
    check(`${platform}: a driver without setValue takes the keystroke road with the platform's chord and reads the value back`, without.outcome === 'succeeded' && without.result.includes('by keystrokes') && without.result.includes('value "Janet"') && acts(from).join(',') === `click,${selectAllChord(platform)},typeText`, `${without.result}\n${acts(from).join(',')}`)
  }
  asPlatform(hostPlatform)
  driver.setValue = setValue
}

section('§3 fields: the controls of a form with role, name and value, sized for forms')
{
  const read = await call({ action: 'fields' })
  const rows = read.result.split('\n').filter(line => /^\[\d+\]/.test(line))
  check('fields lists every control once, flat, with its value', read.outcome === 'succeeded' && read.result.includes('fields: Browser — 8 controls') && rows.length === 8, read.result)
  check('a text field carries the value fill set last, by keystrokes or by the API', rows.some(row => /^\[\d+\] AXTextField "First Name" "Janet"$/.test(row)) && rows.some(row => /^\[\d+\] AXTextField "Legacy" "typed on linux"$/.test(row)), read.result)
  check('an empty field reads as an empty value, not as missing', rows.some(row => /^\[\d+\] AXTextArea "Collapsed" ""$/.test(row)), read.result)
  check('a secure field shows no value', rows.some(row => /^\[\d+\] AXSecureTextField "Password" \(secure\)$/.test(row)) && !read.result.includes('hunter2'), read.result)
  check('choice controls carry their state', rows.some(row => /^\[\d+\] AXCheckBox "Agree" "0"$/.test(row)) && rows.some(row => /^\[\d+\] AXPopUpButton "Country" "United Kingdom"$/.test(row)), read.result)
  check('buttons, static text and groups are not controls of the form', !read.result.includes('Upload File') && !read.result.includes('Tell us') && !read.result.includes('AXGroup'), read.result)
  const ref = Number(/\[(\d+)\] AXTextArea "Why us"/.exec(read.result)?.[1])
  const byRef = await call({ action: 'fill', ref, text: 'by ref', capture: false })
  check('a fields row number is a ref fill can take', byRef.outcome === 'succeeded' && byRef.result.includes('value "by ref"'), byRef.result)
  const capped = await call({ action: 'fields', limit: 2 })
  check('limit caps the rows and says the list goes on', capped.outcome === 'succeeded' && capped.result.split('\n').filter(line => /^\[\d+\]/.test(line)).length === 2 && capped.result.includes('truncated: more controls'), capped.result)
  const rooted = await call({ action: 'fields', root: { role: 'AXGroup', name: 'Resume' } })
  check('root narrows the read to that subtree', rooted.outcome === 'succeeded' && rooted.result.includes('0 controls'), rooted.result)
  session.forgetDesktopOwner(ownerOf(context))
  const permission = await ComputerTool.checkPermissions({ action: 'fields' } as never, context)
  check('fields asks like tree and is a read', permission.behavior === 'ask' && ComputerTool.isReadOnly({ action: 'fields' } as never) === true, JSON.stringify(permission))
}
finish('prove-computer-file-fill')
