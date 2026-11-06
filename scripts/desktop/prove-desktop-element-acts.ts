#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-acts-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.NODE_ENV = 'test'
process.env.BROWSER = '/usr/bin/true'
for (const key of ['MERCURY_DESKTOP_PACK_DIR', 'MERCURY_DESKTOP_DRIVER', 'MERCURY_COMPUTER_USE', 'MERCURY_HOME']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}

const fake = await import('../../src/services/desktop/fakeDesktopDriver.js')
type Scene = typeof fake.FAKE_SCENE_DEFAULT
type Node = Scene['tree'][number]

const signal = (): AbortSignal => new AbortController().signal
const SCROLL_NOTE = 'the element does not scroll into view through the accessibility API — scroll with the wheel instead'
const VALUE_NOTE = 'the element does not accept a value through the accessibility API — type into it instead'
const NOT_UNIQUE = 'the element is no longer unique in a complete window tree — read tree again'

function scene(): Scene {
  const s = structuredClone(fake.FAKE_SCENE_DEFAULT)
  const window = s.tree[0]!
  window.children!.push(
    { role: 'AXButton', title: 'Submit', frame: { x: 400, y: 1400, width: 120, height: 32 } },
    { role: 'AXButton', title: 'Clamped', frame: { x: 400, y: 699, width: 120, height: 1 } },
    { role: 'AXStaticText', value: 'About', frame: { x: 120, y: 2000, width: 300, height: 20 }, actions: ['AXPress'] },
    { role: 'AXTextField', title: 'LinkedIn URL*', value: '', frame: { x: 120, y: 300, width: 400, height: 30 } },
    { role: 'AXTextField (AXSecureTextField)', title: 'Password', frame: { x: 120, y: 340, width: 400, height: 30 } },
    { role: 'AXGroup', title: 'Editor', frame: { x: 120, y: 400, width: 400, height: 200 }, settable: true },
    { role: 'AXButton', title: 'Twin', frame: { x: 600, y: 300, width: 80, height: 30 } },
    { role: 'AXButton', title: 'Twin', frame: { x: 600, y: 300, width: 80, height: 30 } },
  )
  return s
}
const element = (node: Node, depth = 2) => ({ depth, role: node.role, title: node.title ?? null, value: node.value ?? null, frame: node.frame ?? null })
const inside = (frame: { x: number; y: number; width: number; height: number } | null, box: { x: number; y: number; width: number; height: number }): boolean => frame !== null && frame.y >= box.y && frame.y + frame.height <= box.y + box.height && frame.x >= box.x && frame.x + frame.width <= box.x + box.width

console.log('[1] scrollToVisible through the fake driver')
{
  const s = scene()
  const window = s.tree[0]!.frame!
  const driver = new fake.FakeDesktopDriver(s, null)
  const app = s.frontmost
  const submit = element(s.tree[0]!.children![2]!)
  const scrolled = await driver.scrollToVisible(app, submit, signal())
  check('a button below the fold scrolls into the window: scrolled, the frame inside the window, no note', scrolled.ok && scrolled.value.scrolled && inside(scrolled.value.frame, window) && scrolled.value.note === null, JSON.stringify(scrolled))
  const tree = await driver.accessibilityTree(app, { depth: 8, count: 200, scope: 'window' }, signal())
  const row = tree.ok ? tree.value.elements.find(e => e.role === 'AXButton' && e.title === 'Submit') : undefined
  check('the next tree read answers the moved frame (the old frame no longer addresses it)', row !== undefined && scrolled.ok && JSON.stringify(row.frame) === JSON.stringify(scrolled.value.frame) && row.frame!.y !== 1400, JSON.stringify(row))
  const stale = await driver.scrollToVisible(app, submit, signal())
  check('the stale frame is refused with the tree sentence', !stale.ok && stale.error.kind === 'input' && stale.error.note === NOT_UNIQUE, JSON.stringify(stale))
  const clamped = await driver.scrollToVisible(app, element(s.tree[0]!.children![3]!), signal())
  check('an edge-clamped one-point strip (#3211) counts as hidden and is brought in', clamped.ok && clamped.value.scrolled && clamped.value.frame !== null && clamped.value.frame.y !== 699 && inside(clamped.value.frame, window), JSON.stringify(clamped))
  const visible = await driver.scrollToVisible(app, element(s.tree[0]!.children![0]!), signal())
  check('an element already in view keeps its frame', visible.ok && visible.value.scrolled && JSON.stringify(visible.value.frame) === JSON.stringify({ x: 100, y: 128, width: 800, height: 40 }), JSON.stringify(visible))
  const unsupported = await driver.scrollToVisible(app, element(s.tree[0]!.children![4]!), signal())
  check('an element without the action answers scrolled false with the wheel sentence and its frame', unsupported.ok && !unsupported.value.scrolled && unsupported.value.note === SCROLL_NOTE && unsupported.value.frame?.y === 2000, JSON.stringify(unsupported))
  const twin = await driver.scrollToVisible(app, element(s.tree[0]!.children![8]!), signal())
  check('two matching elements refuse with the tree sentence', !twin.ok && twin.error.note === NOT_UNIQUE, JSON.stringify(twin))
  const other = await driver.scrollToVisible({ ...app, identity: 'com.example.other', name: 'Other' }, submit, signal())
  check('an application not in front is refused by name', !other.ok && other.error.kind === 'display' && other.error.note.includes('Other'), JSON.stringify(other))
  const acts = driver.acts.filter(a => a.act === 'scrollToVisible')
  check('every scroll act is recorded, scrolled or not', acts.length === 4 && acts.filter(a => a.detail.scrolled === true).length === 3, JSON.stringify(acts.map(a => a.detail)))
}

console.log('\n[2] setValue through the fake driver')
{
  const s = scene()
  const driver = new fake.FakeDesktopDriver(s, null)
  const app = s.frontmost
  const field = element(s.tree[0]!.children![5]!)
  const set = await driver.setValue(app, field, 'https://www.linkedin.com/in/example', signal())
  check('a text field takes the value and reads it back', set.ok && set.value.set && set.value.value === 'https://www.linkedin.com/in/example' && set.value.note === null, JSON.stringify(set))
  const read = await driver.readElement(app, field, signal())
  check('readElement on the same field answers the new value', read.ok && read.value?.text === 'https://www.linkedin.com/in/example', JSON.stringify(read))
  const tree = await driver.accessibilityTree(app, { depth: 8, count: 200, scope: 'window' }, signal())
  check('the next tree read carries the value', tree.ok && tree.value.elements.some(e => e.title === 'LinkedIn URL*' && e.value === 'https://www.linkedin.com/in/example'), JSON.stringify(tree.ok ? tree.value.elements.filter(e => e.title === 'LinkedIn URL*') : tree))
  const again = await driver.setValue(app, field, '', signal())
  check('an empty value clears the field', again.ok && again.value.set && again.value.value === '', JSON.stringify(again))
  const button = await driver.setValue(app, element(s.tree[0]!.children![2]!), 'x', signal())
  check('a button answers set false with the typing sentence and its current value', button.ok && !button.value.set && button.value.note === VALUE_NOTE && button.value.value === null, JSON.stringify(button))
  const secure = await driver.setValue(app, element(s.tree[0]!.children![6]!), 'hunter2', signal())
  check('a secure field is set but never read back', secure.ok && secure.value.set && secure.value.value === null && secure.value.note === 'a secure field is not read back', JSON.stringify(secure))
  const custom = await driver.setValue(app, element(s.tree[0]!.children![7]!), 'rich', signal())
  check('a scene node marked settable accepts a value whatever its role', custom.ok && custom.value.set && custom.value.value === 'rich', JSON.stringify(custom))
  const missing = await driver.setValue(app, { depth: 2, role: 'AXTextField', title: 'Nowhere', value: null, frame: null }, 'x', signal())
  check('an element not in the tree is refused with the tree sentence', !missing.ok && missing.error.note === NOT_UNIQUE, JSON.stringify(missing))
  const acts = driver.acts.filter(a => a.act === 'setValue')
  check('every set act is recorded with the character count, never the text', acts.length === 5 && acts.every(a => typeof a.detail.chars === 'number' && !JSON.stringify(a.detail).includes('hunter2')), JSON.stringify(acts.map(a => a.detail)))
}

console.log('\n[3] the gates both acts share')
{
  const denied = scene()
  denied.permissions = { session: 'desktop', screenCapture: 'granted', input: 'denied', reason: 'fixture: no input grant' }
  const driver = new fake.FakeDesktopDriver(denied, null)
  const field = element(denied.tree[0]!.children![5]!)
  const scrolled = await driver.scrollToVisible(denied.frontmost, field, signal())
  const set = await driver.setValue(denied.frontmost, field, 'x', signal())
  check('without the input grant both acts refuse with the grant words', !scrolled.ok && scrolled.error.kind === 'permission' && !set.ok && set.error.kind === 'permission', JSON.stringify([scrolled, set]))
  const held = scene()
  held.holdMs = 50
  const slow = new fake.FakeDesktopDriver(held, null)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 5)
  const aborted = await slow.setValue(held.frontmost, field, 'x', controller.signal)
  const afterAbort = await slow.accessibilityTree(held.frontmost, { depth: 8, count: 200, scope: 'window' }, signal())
  check('an abort during the act answers aborted and sets nothing', !aborted.ok && aborted.error.kind === 'aborted' && afterAbort.ok && afterAbort.value.elements.some(e => e.title === 'LinkedIn URL*' && e.value === null), JSON.stringify(aborted))
  const closed = new fake.FakeDesktopDriver(scene(), null)
  await closed.close()
  const afterClose = await closed.scrollToVisible(denied.frontmost, field, signal())
  check('a closed driver refuses', !afterClose.ok && afterClose.error.kind === 'unavailable', JSON.stringify(afterClose))
  const malformed = fake.readFakeScene(join(SCRATCH, 'missing.json'))
  check('a scene file that cannot be read is named', malformed.state === 'unavailable' && malformed.note.includes('cannot be read'), JSON.stringify(malformed))
  writeFileSync(join(SCRATCH, 'actions.json'), JSON.stringify({ tree: [{ role: 'AXWindow', title: 'Untitled', children: [{ role: 'AXButton', title: 'Go', actions: 'nope' }] }] }))
  const badActions = fake.readFakeScene(join(SCRATCH, 'actions.json'))
  check('a scene node whose actions are not a list is refused by path', badActions.state === 'unavailable' && badActions.note.includes('tree[0].children[0].actions'), JSON.stringify(badActions))
  writeFileSync(join(SCRATCH, 'settable.json'), JSON.stringify({ tree: [{ role: 'AXWindow', title: 'Untitled', children: [{ role: 'AXGroup', title: 'Editor', settable: 'yes' }] }] }))
  const badSettable = fake.readFakeScene(join(SCRATCH, 'settable.json'))
  check('a scene node whose settable is not a boolean is refused by path', badSettable.state === 'unavailable' && badSettable.note.includes('tree[0].children[0].settable'), JSON.stringify(badSettable))
  writeFileSync(join(SCRATCH, 'good.json'), JSON.stringify({ tree: [{ role: 'AXWindow', title: 'Untitled', frame: { x: 0, y: 0, width: 800, height: 600 }, children: [{ role: 'AXButton', title: 'Go', frame: { x: 10, y: 900, width: 50, height: 20 }, actions: ['AXPress'] }, { role: 'AXGroup', title: 'Editor', frame: { x: 10, y: 10, width: 50, height: 20 }, settable: true }] }] }))
  const good = fake.readFakeScene(join(SCRATCH, 'good.json'))
  check('a scene file carries actions and settable into the driver', good.state === 'ok' && good.scene.tree[0]!.children![0]!.actions?.[0] === 'AXPress' && good.scene.tree[0]!.children![1]!.settable === true, JSON.stringify(good))
  if (good.state === 'ok') {
    const fromFile = new fake.FakeDesktopDriver(good.scene, null)
    const go = await fromFile.scrollToVisible(good.scene.frontmost, { depth: 1, role: 'AXButton', title: 'Go', value: null, frame: { x: 10, y: 900, width: 50, height: 20 } }, signal())
    const editor = await fromFile.setValue(good.scene.frontmost, { depth: 1, role: 'AXGroup', title: 'Editor', value: null, frame: { x: 10, y: 10, width: 50, height: 20 } }, 'typed', signal())
    check('…and the driver honours them', go.ok && !go.value.scrolled && go.value.note === SCROLL_NOTE && editor.ok && editor.value.set && editor.value.value === 'typed', JSON.stringify([go, editor]))
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures > 0 ? `\nprove-desktop-element-acts: RED (${failures})` : '\nprove-desktop-element-acts: green')
process.exit(failures > 0 ? 1 : 0)
