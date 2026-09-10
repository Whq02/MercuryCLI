#!/usr/bin/env bun
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { abortAfter, abortedSignal, check, finish, freshSignal, isPng, scratchDir, section, TWO_DISPLAYS_SCENE } from './computerProofKit.ts'

const fake = await import('../../src/services/desktop/fakeDesktopDriver.ts')
const { FakeDesktopDriver, FAKE_SCENE_DEFAULT, fakeDesktopDriverFromEnvironment, pngDimensions, readFakeActLog, readFakeScene } = fake
const { displaysFingerprint } = await import('../../src/services/desktop/driver.ts')
type FakeScene = import('../../src/services/desktop/fakeDesktopDriver.ts').FakeScene
type DesktopApplication = import('../../src/services/desktop/driver.ts').DesktopApplication

const scratch = scratchDir('fake-driver')
const FINDER: DesktopApplication = { identity: 'com.example.Finder', name: 'Finder', pid: 4300, title: null, bounds: { x: 0, y: 0, width: 600, height: 400 } }
const scene = (overrides: Partial<FakeScene>): FakeScene => ({ ...structuredClone(FAKE_SCENE_DEFAULT), ...overrides })
const errorKind = (answer: { ok: boolean; error?: { kind: string } }): string => (answer.ok ? 'ok' : (answer.error?.kind ?? 'none'))
const errorNote = (answer: { ok: boolean; error?: { note: string } }): string => (answer.ok ? '' : (answer.error?.note ?? ''))

section('§1 the built-in scene')
{
  check('one display, 1440×900 at (0, 0), scale 2, primary, index 0', JSON.stringify(FAKE_SCENE_DEFAULT.displays) === JSON.stringify([{ index: 0, id: 'fixture-1', originX: 0, originY: 0, width: 1440, height: 900, scale: 2, primary: true }]), JSON.stringify(FAKE_SCENE_DEFAULT.displays))
  check('TextEdit in front, titled Untitled, with an 800×600 window at (100, 100)', FAKE_SCENE_DEFAULT.frontmost.name === 'TextEdit' && FAKE_SCENE_DEFAULT.frontmost.identity === 'com.example.TextEdit' && FAKE_SCENE_DEFAULT.frontmost.title === 'Untitled' && JSON.stringify(FAKE_SCENE_DEFAULT.frontmost.bounds) === JSON.stringify({ x: 100, y: 100, width: 800, height: 600 }))
  check('the cursor at (720, 450)', FAKE_SCENE_DEFAULT.cursor.x === 720 && FAKE_SCENE_DEFAULT.cursor.y === 450)
  check('three lines, no switches, no hold', FAKE_SCENE_DEFAULT.lines.length === 3 && FAKE_SCENE_DEFAULT.switches.length === 0 && FAKE_SCENE_DEFAULT.holdMs === 0)
  check('the terminal running the session is named with its own window', FAKE_SCENE_DEFAULT.ownTerminal?.name === 'Terminal' && FAKE_SCENE_DEFAULT.ownTerminal.identity === 'com.example.Terminal' && FAKE_SCENE_DEFAULT.ownTerminal.bounds !== null)
  check('the grants: a desktop session, screen capture and input granted', JSON.stringify(FAKE_SCENE_DEFAULT.permissions) === JSON.stringify({ session: 'desktop', screenCapture: 'granted', input: 'granted', reason: null }))
  const driver = new FakeDesktopDriver(FAKE_SCENE_DEFAULT, null)
  const facts = driver.describe()
  check('describe(): kind fake, source fake, a platform word', facts.kind === 'fake' && facts.source === 'fake' && facts.platform.includes(process.platform) && facts.version.length > 0, JSON.stringify(facts))
  const permissions = await driver.permissions()
  const requested = await driver.requestPermissions()
  check('permissions() and requestPermissions() answer the scene\'s grants', permissions.ok && requested.ok && JSON.stringify(permissions.value) === JSON.stringify(FAKE_SCENE_DEFAULT.permissions) && JSON.stringify(requested.value) === JSON.stringify(permissions.value))
  const displays = await driver.displays()
  check('displays() answers the scene\'s list with the fingerprint of the contract', displays.ok && displays.value.displays.length === 1 && displays.value.fingerprint === displaysFingerprint(FAKE_SCENE_DEFAULT.displays), JSON.stringify(displays))
  const front = await driver.frontmostApplication()
  const terminal = await driver.ownTerminalApplication()
  check('frontmostApplication() answers TextEdit with its bounds; ownTerminalApplication() the terminal', front.ok && front.value.name === 'TextEdit' && front.value.bounds?.width === 800 && terminal.ok && terminal.value?.name === 'Terminal')
  const cursor = await driver.cursor()
  check('cursor() answers the scene\'s point on display 0', cursor.ok && cursor.value.x === 720 && cursor.value.y === 450 && cursor.value.display === 0, JSON.stringify(cursor))
}

section('§2 a capture is a PNG of exactly the display\'s pixel size')
{
  const driver = new FakeDesktopDriver(FAKE_SCENE_DEFAULT, null)
  const before = Date.now()
  const first = await driver.capture(0, freshSignal())
  const after = Date.now()
  check('capture(0) answers ok', first.ok, JSON.stringify(first).slice(0, 300))
  if (first.ok) {
    const c = first.value
    const header = pngDimensions(c.png)
    check('the bytes are a PNG', isPng(c.png))
    check('the header reads 2880×1800 (1440×900 points at scale 2)', header?.width === 2880 && header?.height === 1800, JSON.stringify(header))
    check('width and height are the header\'s, scale 2, display 0, id fixture-1, origin (0, 0)', c.width === 2880 && c.height === 1800 && c.scale === 2 && c.display === 0 && c.displayId === 'fixture-1' && c.originX === 0 && c.originY === 0)
    check('capturedAt is the driver\'s own stamp at the answer', c.capturedAt >= before && c.capturedAt <= after, `${c.capturedAt} outside ${before}..${after}`)
    check('the log carries the capture with its size', driver.acts.length === 1 && driver.acts[0]?.act === 'capture' && driver.acts[0].outcome === 'done' && JSON.stringify(driver.acts[0].detail) === JSON.stringify({ display: 0, width: 2880, height: 1800 }), JSON.stringify(driver.acts))
    const second = await driver.capture(0, freshSignal())
    check('a second capture differs from the first (the capture count is painted)', second.ok && !second.value.png.equals(c.png))
  }
  const missing = await driver.capture(7, freshSignal())
  check('a display the scene lacks refuses with kind display naming the count', errorKind(missing) === 'display' && errorNote(missing).includes('no display 7') && errorNote(missing).includes('the scene has 1'), JSON.stringify(missing))
  const fraction = await driver.capture(0.5, freshSignal())
  check('a fractional display index refuses with kind display', errorKind(fraction) === 'display')
}

section('§3 the cursor follows moves, clicks, drags and scrolls; the receipts name where the act ended')
{
  const driver = new FakeDesktopDriver(FAKE_SCENE_DEFAULT, null)
  const move = await driver.mouseMove({ x: 100, y: 120 }, freshSignal())
  const cursorAfterMove = await driver.cursor()
  check('mouseMove: the receipt is act move at the point; the cursor is there', move.ok && move.value.act === 'move' && move.value.at?.x === 100 && move.value.at.y === 120 && cursorAfterMove.ok && cursorAfterMove.value.x === 100 && cursorAfterMove.value.y === 120)
  const click = await driver.click({ x: 406, y: 150 }, 'left', 1, freshSignal())
  const cursorAfterClick = await driver.cursor()
  check('click: the receipt is act click at the point; the cursor follows', click.ok && click.value.act === 'click' && click.value.at?.x === 406 && cursorAfterClick.ok && cursorAfterClick.value.x === 406 && cursorAfterClick.value.y === 150)
  const drag = await driver.drag({ x: 10, y: 10 }, { x: 300, y: 320 }, 'left', freshSignal())
  const cursorAfterDrag = await driver.cursor()
  const heldAfterDrag = await driver.held()
  check('drag: the receipt ends at the destination, the cursor is there, no button stays held', drag.ok && drag.value.act === 'drag' && drag.value.at?.x === 300 && drag.value.at.y === 320 && cursorAfterDrag.ok && cursorAfterDrag.value.x === 300 && heldAfterDrag.ok && heldAfterDrag.value.buttons.length === 0)
  const scroll = await driver.scroll({ x: 50, y: 60 }, 0, 3, freshSignal())
  const cursorAfterScroll = await driver.cursor()
  check('scroll: the receipt is at the point and the cursor follows', scroll.ok && scroll.value.act === 'scroll' && scroll.value.at?.y === 60 && cursorAfterScroll.ok && cursorAfterScroll.value.x === 50)
  const tap = await driver.keyTap('a', ['shift'], freshSignal())
  check('keyTap: a receipt with no point', tap.ok && tap.value.act === 'keyTap' && tap.value.at === null)
  const away = await driver.mouseMove({ x: 5000, y: 5000 }, freshSignal())
  const cursorAway = await driver.cursor()
  check('a point outside every display answers display null', away.ok && cursorAway.ok && cursorAway.value.display === null, JSON.stringify(cursorAway))
  check('the log names each act in order with its arguments', driver.acts.map(a => a.act).join(',') === 'mouseMove,click,drag,scroll,keyTap,mouseMove' && driver.acts.every((a, i) => a.at === i + 1 && a.outcome === 'done') && JSON.stringify(driver.acts[1]?.detail) === JSON.stringify({ at: { x: 406, y: 150 }, button: 'left', count: 1 }), JSON.stringify(driver.acts))
}

section('§4 held keys and buttons are accounted for and released as one')
{
  const driver = new FakeDesktopDriver(FAKE_SCENE_DEFAULT, null)
  await driver.mouseDown('left', freshSignal())
  await driver.keyDown('shift', freshSignal())
  await driver.keyDown('a', freshSignal())
  const held = await driver.held()
  check('held() lists the button and the keys in the order pressed', held.ok && JSON.stringify(held.value) === JSON.stringify({ buttons: ['left'], keys: ['shift', 'a'] }), JSON.stringify(held))
  await driver.keyUp('a', freshSignal())
  const afterUp = await driver.held()
  check('keyUp removes its key', afterUp.ok && JSON.stringify(afterUp.value.keys) === JSON.stringify(['shift']))
  const released = await driver.releaseAll()
  const empty = await driver.held()
  check('releaseAll answers what it released and leaves nothing held', released.ok && JSON.stringify(released.value) === JSON.stringify({ buttons: ['left'], keys: ['shift'] }) && empty.ok && empty.value.buttons.length === 0 && empty.value.keys.length === 0, JSON.stringify(released))
  const last = driver.acts[driver.acts.length - 1]
  check('the log records the release with what it released', last?.act === 'releaseAll' && JSON.stringify(last.detail) === JSON.stringify({ buttons: ['left'], keys: ['shift'] }), JSON.stringify(last))
  const again = await driver.releaseAll()
  check('a second releaseAll answers empty lists, never a refusal', again.ok && again.value.buttons.length === 0 && again.value.keys.length === 0)
  await driver.mouseUp('left', freshSignal())
  const stillEmpty = await driver.held()
  check('mouseUp on a button not held is a plain receipt', stillEmpty.ok && stillEmpty.value.buttons.length === 0)
}

section('§5 the inputs the driver refuses by name')
{
  const driver = new FakeDesktopDriver(FAKE_SCENE_DEFAULT, null)
  const key = await driver.keyTap('bogus', [], freshSignal())
  check('an unknown key: kind input, no such key', errorKind(key) === 'input' && errorNote(key) === 'no such key: bogus', JSON.stringify(key))
  const modifier = await driver.keyTap('a', ['hyper' as never], freshSignal())
  check('an unknown modifier: kind input naming it', errorKind(modifier) === 'input' && errorNote(modifier) === 'no such modifier: hyper')
  const count = await driver.click({ x: 1, y: 1 }, 'left', 4 as never, freshSignal())
  check('a click count outside 1..3: kind input', errorKind(count) === 'input' && errorNote(count).includes('not 4'))
  const button = await driver.mouseDown('back' as never, freshSignal())
  check('an unknown button: kind input', errorKind(button) === 'input' && errorNote(button) === 'no such button: back')
  const point = await driver.mouseMove({ x: Number.NaN, y: 1 }, freshSignal())
  check('a point that is not finite: kind input', errorKind(point) === 'input' && errorNote(point).includes('finite'))
  const delta = await driver.scroll({ x: 1, y: 1 }, Number.NaN, 0, freshSignal())
  check('a scroll delta that is not finite: kind input', errorKind(delta) === 'input')
  const down = await driver.keyDown('nope', freshSignal())
  const up = await driver.keyUp('nope', freshSignal())
  check('keyDown and keyUp refuse an unknown key the same way', errorKind(down) === 'input' && errorKind(up) === 'input')
  check('a refused input logs nothing', driver.acts.length === 0)
  const empty = await driver.typeText('', {}, freshSignal())
  check('typing nothing is a receipt and no act', empty.ok && empty.value.act === 'type' && driver.acts.length === 0)
  const typed = await driver.typeText('hello', { gapMs: 9 }, freshSignal())
  const byDefault = await driver.typeText('world', {}, freshSignal())
  check('typing records the text whole with its gap, 4 ms when none is given', typed.ok && byDefault.ok && JSON.stringify(driver.acts[0]?.detail) === JSON.stringify({ text: 'hello', gapMs: 9 }) && JSON.stringify(driver.acts[1]?.detail) === JSON.stringify({ text: 'world', gapMs: 4 }), JSON.stringify(driver.acts))
}

section('§6 the application in front switches after the given number of acts')
{
  const driver = new FakeDesktopDriver(scene({ switches: [{ afterActs: 2, frontmost: FINDER }] }), null)
  const before = await driver.frontmostApplication()
  await driver.capture(0, freshSignal())
  const afterCapture = await driver.frontmostApplication()
  await driver.click({ x: 1, y: 1 }, 'left', 1, freshSignal())
  const afterOne = await driver.frontmostApplication()
  await driver.keyTap('enter', [], freshSignal())
  const afterTwo = await driver.frontmostApplication()
  check('TextEdit before any act and after a capture (a read is not an act)', before.ok && before.value.name === 'TextEdit' && afterCapture.ok && afterCapture.value.name === 'TextEdit')
  check('TextEdit after one act, Finder after two, with Finder\'s own bounds', afterOne.ok && afterOne.value.name === 'TextEdit' && afterTwo.ok && afterTwo.value.identity === 'com.example.Finder' && afterTwo.value.bounds?.width === 600, JSON.stringify(afterTwo))
}

section('§7 the hold and the abort signal')
{
  const held = scene({ holdMs: 400 })
  const driver = new FakeDesktopDriver(held, null)
  const aborted = await driver.click({ x: 10, y: 10 }, 'left', 1, abortAfter(100))
  check('an abort during the hold answers the aborted record, never a throw', errorKind(aborted) === 'aborted' && errorNote(aborted).includes('interrupted'), JSON.stringify(aborted))
  check('the log carries the click as aborted', driver.acts.length === 1 && driver.acts[0]?.act === 'click' && driver.acts[0].outcome === 'aborted')
  const cursor = await driver.cursor()
  check('an aborted click moves nothing', cursor.ok && cursor.value.x === 720 && cursor.value.y === 450)
  const switching = new FakeDesktopDriver(scene({ holdMs: 400, switches: [{ afterActs: 1, frontmost: FINDER }] }), null)
  await switching.click({ x: 10, y: 10 }, 'left', 1, abortAfter(50))
  const front = await switching.frontmostApplication()
  check('an aborted act does not count towards a switch', front.ok && front.value.name === 'TextEdit')
  const pre = await driver.keyTap('enter', [], abortedSignal())
  check('a signal already aborted answers aborted at once', errorKind(pre) === 'aborted' && driver.acts[driver.acts.length - 1]?.outcome === 'aborted')
  const drag = await driver.drag({ x: 1, y: 1 }, { x: 200, y: 200 }, 'left', abortAfter(100))
  const heldAfter = await driver.held()
  const cursorAfter = await driver.cursor()
  check('an aborted drag answers aborted, releases its button and leaves the cursor at the start', errorKind(drag) === 'aborted' && heldAfter.ok && heldAfter.value.buttons.length === 0 && cursorAfter.ok && cursorAfter.value.x === 1 && cursorAfter.value.y === 1, JSON.stringify({ drag, heldAfter, cursorAfter }))
  const capture = await driver.capture(0, abortAfter(100))
  check('a capture aborted during the hold answers aborted', errorKind(capture) === 'aborted')
  const completed = await driver.click({ x: 10, y: 10 }, 'left', 1, freshSignal())
  check('with no abort the held act completes after the hold', completed.ok && driver.acts[driver.acts.length - 1]?.outcome === 'done')
  const type = await driver.typeText('abc', {}, abortAfter(100))
  check('typing aborted during the hold answers aborted and logs the act as aborted', errorKind(type) === 'aborted' && driver.acts[driver.acts.length - 1]?.act === 'typeText' && driver.acts[driver.acts.length - 1]?.outcome === 'aborted')
}

section('§8 the grants come from the scene and refuse the way the native driver does')
{
  const noCapture = new FakeDesktopDriver(scene({ permissions: { session: 'desktop', screenCapture: 'denied', input: 'granted', reason: 'no screen recording grant' } }), null)
  const capture = await noCapture.capture(0, freshSignal())
  const click = await noCapture.click({ x: 1, y: 1 }, 'left', 1, freshSignal())
  check('screen capture denied: capture refuses with kind permission, the reason and a remedy; acts still run', errorKind(capture) === 'permission' && errorNote(capture).includes('no screen recording grant') && !capture.ok && typeof capture.error.remedy === 'string' && click.ok, JSON.stringify(capture))
  const noInput = new FakeDesktopDriver(scene({ permissions: { session: 'desktop', screenCapture: 'granted', input: 'denied', reason: 'no accessibility grant' } }), null)
  const captureOk = await noInput.capture(0, freshSignal())
  const act = await noInput.keyTap('a', [], freshSignal())
  const dragged = await noInput.drag({ x: 1, y: 1 }, { x: 2, y: 2 }, 'left', freshSignal())
  check('input denied: every act refuses with kind permission and the reason; captures still answer', captureOk.ok && errorKind(act) === 'permission' && errorNote(act).includes('no accessibility grant') && errorKind(dragged) === 'permission' && noInput.acts.length === 1)
  const notRequired = new FakeDesktopDriver(scene({ permissions: { session: 'desktop', screenCapture: 'not-required', input: 'not-required', reason: null } }), null)
  const plain = await notRequired.click({ x: 1, y: 1 }, 'left', 1, freshSignal())
  check('a grant the platform does not require holds', plain.ok)
  const headless = new FakeDesktopDriver(scene({ permissions: { session: 'no-display', screenCapture: 'unknown', input: 'unknown', reason: 'no window server' } }), null)
  const headlessCapture = await headless.capture(0, freshSignal())
  const headlessAct = await headless.mouseMove({ x: 1, y: 1 }, freshSignal())
  check('a session that is not a desktop refuses captures and acts with kind session', errorKind(headlessCapture) === 'session' && errorKind(headlessAct) === 'session' && errorNote(headlessAct) === 'no window server')
}

section('§9 close() releases and ends the driver')
{
  const driver = new FakeDesktopDriver(FAKE_SCENE_DEFAULT, null)
  await driver.keyDown('shift', freshSignal())
  await driver.close()
  const held = await driver.held()
  const click = await driver.click({ x: 1, y: 1 }, 'left', 1, freshSignal())
  const capture = await driver.capture(0, freshSignal())
  const release = await driver.releaseAll()
  check('close releases what was held, later acts and captures refuse with kind unavailable, releaseAll still answers', held.ok && held.value.keys.length === 0 && errorKind(click) === 'unavailable' && errorKind(capture) === 'unavailable' && release.ok, JSON.stringify({ click, capture }))
}

section('§10 the scene file: read, defaulted, refused by name')
{
  const two = readFakeScene(TWO_DISPLAYS_SCENE)
  check('the two-display fixture reads', two.state === 'ok', JSON.stringify(two))
  if (two.state === 'ok') {
    check('its second display sits at originX -1920, 1920×1080 at scale 1, index 1', two.scene.displays[1]?.originX === -1920 && two.scene.displays[1].width === 1920 && two.scene.displays[1].scale === 1 && two.scene.displays[1].index === 1)
    check('a field the file omits keeps the built-in value (permissions)', JSON.stringify(two.scene.permissions) === JSON.stringify(FAKE_SCENE_DEFAULT.permissions))
    const driver = new FakeDesktopDriver(two.scene, null)
    const capture = await driver.capture(1, freshSignal())
    check('capture(1) is 1920×1080 with the negative origin', capture.ok && capture.value.width === 1920 && capture.value.height === 1080 && capture.value.originX === -1920 && capture.value.display === 1 && capture.value.displayId === 'fixture-2', JSON.stringify(capture).slice(0, 200))
    const cursor = await driver.cursor()
    check('the cursor at (-960, 540) is on display 1', cursor.ok && cursor.value.display === 1)
    await driver.mouseMove({ x: 100, y: 100 }, freshSignal())
    const moved = await driver.cursor()
    check('a move onto the primary answers display 0', moved.ok && moved.value.display === 0)
    const front = await driver.frontmostApplication()
    const terminal = await driver.ownTerminalApplication()
    check('the fixture\'s applications carry X11-shaped identities', front.ok && front.value.identity === 'editor' && terminal.ok && terminal.value?.identity === 'xterm')
  }
  const partial = join(scratch, 'partial.json')
  writeFileSync(partial, JSON.stringify({ holdMs: 5, lines: ['one'] }))
  const partialRead = readFakeScene(partial)
  check('a partial scene takes the built-in values for the rest', partialRead.state === 'ok' && partialRead.scene.holdMs === 5 && partialRead.scene.lines.length === 1 && partialRead.scene.displays.length === 1 && partialRead.scene.frontmost.name === 'TextEdit')
  const cases: Array<[string, unknown, string]> = [
    ['empty displays', { displays: [] }, 'displays must be a non-empty list'],
    ['a display whose index is not its position', { displays: [{ index: 3, id: 'x', originX: 0, originY: 0, width: 10, height: 10, scale: 1, primary: true }] }, 'displays[0].index must be 0'],
    ['a display with a zero scale', { displays: [{ index: 0, id: 'x', originX: 0, originY: 0, width: 10, height: 10, scale: 0, primary: true }] }, 'displays[0].scale must be a positive number'],
    ['an application without a name', { frontmost: { identity: 'x', name: '', pid: null, title: null, bounds: null } }, 'frontmost.name must be a non-empty string'],
    ['a cursor without y', { cursor: { x: 1 } }, 'cursor must be a record with finite x and y'],
    ['lines that are not strings', { lines: [1] }, 'lines must be a list of strings'],
    ['a switch with a fractional act count', { switches: [{ afterActs: 1.5, frontmost: FINDER }] }, 'switches[0].afterActs must be a whole number'],
    ['a negative hold', { holdMs: -1 }, 'holdMs must be a number of milliseconds, zero or more'],
    ['a session kind outside the contract', { permissions: { session: 'elsewhere', screenCapture: 'granted', input: 'granted', reason: null } }, 'permissions.session must be one of desktop, no-display, wayland, locked, service, unknown'],
    ['a grant outside the contract', { permissions: { session: 'desktop', screenCapture: 'maybe', input: 'granted', reason: null } }, 'permissions.screenCapture must be one of granted, denied, not-required, unknown'],
    ['a terminal without bounds fields', { ownTerminal: { identity: 'x', name: 'x', pid: 1, title: null, bounds: { x: 1 } } }, 'ownTerminal.bounds.y must be a finite number'],
    ['a list instead of an object', [1, 2], 'the scene must be a JSON object'],
  ]
  for (const [label, value, problem] of cases) {
    const path = join(scratch, `${label.replace(/[^a-z0-9]+/gi, '-')}.json`)
    writeFileSync(path, JSON.stringify(value))
    const read = readFakeScene(path)
    check(`${label} refuses by name`, read.state === 'unavailable' && read.note.includes(path) && read.note.includes(problem), JSON.stringify(read))
  }
  const notJson = join(scratch, 'not-json.json')
  writeFileSync(notJson, '{ nope')
  const notJsonRead = readFakeScene(notJson)
  check('a file that is not JSON refuses naming the file', notJsonRead.state === 'unavailable' && notJsonRead.note.includes('is not JSON') && notJsonRead.note.includes(notJson))
  const absent = readFakeScene(join(scratch, 'absent.json'))
  check('an absent file refuses naming the file', absent.state === 'unavailable' && absent.note.includes('cannot be read'))
}

section('§11 the environment: the scene flag, the log flag, the log on disk')
{
  delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  delete process.env.MERCURY_DESKTOP_FAKE_LOG
  const plain = fakeDesktopDriverFromEnvironment()
  check('no flags: the built-in scene, no log', plain.state === 'ok' && (await plain.driver.displays()).ok && JSON.stringify((await plain.driver.displays())).includes('fixture-1') && !JSON.stringify(await plain.driver.displays()).includes('fixture-2'))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = TWO_DISPLAYS_SCENE
  const log = join(scratch, 'logs', 'acts.jsonl')
  process.env.MERCURY_DESKTOP_FAKE_LOG = log
  const resolved = fakeDesktopDriverFromEnvironment()
  check('the scene flag selects the file', resolved.state === 'ok' && JSON.stringify(await resolved.driver.displays()).includes('fixture-2'))
  check('the log file is not created at construction', !existsSync(log))
  if (resolved.state === 'ok') {
    await resolved.driver.click({ x: 5, y: 5 }, 'right', 2, freshSignal())
    await resolved.driver.capture(0, freshSignal())
    await resolved.driver.releaseAll()
    check('after acts the log exists and reads back as the driver\'s own list', existsSync(log) && JSON.stringify(readFakeActLog(log)) === JSON.stringify(resolved.driver.acts), JSON.stringify(readFakeActLog(log)))
    check('the log rows carry the act, the ordinal, the outcome and the arguments', readFakeActLog(log)[0]?.act === 'click' && readFakeActLog(log)[0]?.at === 1 && readFakeActLog(log)[0]?.outcome === 'done' && JSON.stringify(readFakeActLog(log)[0]?.detail) === JSON.stringify({ at: { x: 5, y: 5 }, button: 'right', count: 2 }))
  }
  const broken = join(scratch, 'broken.json')
  writeFileSync(broken, JSON.stringify({ displays: [] }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = broken
  const refused = fakeDesktopDriverFromEnvironment()
  check('a malformed scene file makes the driver unavailable, naming the flag, the file and the field', refused.state === 'unavailable' && refused.note.startsWith('MERCURY_DESKTOP_FAKE_SCENE:') && refused.note.includes(broken) && refused.note.includes('displays must be a non-empty list'), JSON.stringify(refused))
  check('an absent log reads as an empty list', readFakeActLog(join(scratch, 'no-such.jsonl')).length === 0)
  delete process.env.MERCURY_DESKTOP_FAKE_SCENE
  delete process.env.MERCURY_DESKTOP_FAKE_LOG
}

section('§12 determinism: the same scene and the same acts give the same log and the same bytes')
{
  const small = scene({ displays: [{ index: 0, id: 'small', originX: 0, originY: 0, width: 320, height: 200, scale: 1, primary: true }] })
  const run = async (): Promise<{ acts: string; png: Buffer }> => {
    const driver = new FakeDesktopDriver(small, null)
    await driver.click({ x: 10, y: 10 }, 'left', 1, freshSignal())
    await driver.typeText('twice', {}, freshSignal())
    await driver.scroll({ x: 20, y: 20 }, 0, -2, freshSignal())
    const capture = await driver.capture(0, freshSignal())
    await driver.releaseAll()
    return { acts: JSON.stringify(driver.acts), png: capture.ok ? capture.value.png : Buffer.alloc(0) }
  }
  const first = await run()
  const second = await run()
  check('the act logs are byte-identical', first.acts === second.acts && first.acts.length > 0)
  check('the captures are byte-identical PNGs of the display size', first.png.length > 0 && first.png.equals(second.png) && pngDimensions(first.png)?.width === 320 && pngDimensions(first.png)?.height === 200)
  const mutated = new FakeDesktopDriver(small, null)
  await mutated.click({ x: 10, y: 10 }, 'left', 1, freshSignal())
  await mutated.typeText('twice', {}, freshSignal())
  await mutated.scroll({ x: 20, y: 20 }, 0, -2, freshSignal())
  small.lines.push('a line added after construction')
  const untouched = await mutated.capture(0, freshSignal())
  check('the driver keeps its own copy of the scene', untouched.ok && untouched.value.png.equals(first.png))
}

finish('prove-computer-fake-driver')
