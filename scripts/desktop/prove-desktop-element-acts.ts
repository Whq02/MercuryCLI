#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    { role: 'AXTextField', title: 'Website', value: '', frame: { x: 120, y: 300, width: 400, height: 30 } },
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
  check('an edge-clamped one-point strip at the window edge counts as hidden and is brought in', clamped.ok && clamped.value.scrolled && clamped.value.frame !== null && clamped.value.frame.y !== 699 && inside(clamped.value.frame, window), JSON.stringify(clamped))
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
  const set = await driver.setValue(app, field, 'https://example.com/jane', signal())
  check('a text field takes the value and reads it back', set.ok && set.value.set && set.value.value === 'https://example.com/jane' && set.value.note === null, JSON.stringify(set))
  const read = await driver.readElement(app, field, signal())
  check('readElement on the same field answers the new value', read.ok && read.value?.text === 'https://example.com/jane', JSON.stringify(read))
  const tree = await driver.accessibilityTree(app, { depth: 8, count: 200, scope: 'window' }, signal())
  check('the next tree read carries the value', tree.ok && tree.value.elements.some(e => e.title === 'Website' && e.value === 'https://example.com/jane'), JSON.stringify(tree.ok ? tree.value.elements.filter(e => e.title === 'Website') : tree))
  const again = await driver.setValue(app, field, '', signal())
  check('an empty value clears the field and reads back as null, the tree\'s word for empty', again.ok && again.value.set && again.value.value === null, JSON.stringify(again))
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
  check('an abort during the act answers aborted and sets nothing', !aborted.ok && aborted.error.kind === 'aborted' && afterAbort.ok && afterAbort.value.elements.some(e => e.title === 'Website' && e.value === null), JSON.stringify(aborted))
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

const lib = readFileSync(join(ROOT, 'native', 'desktop', 'src', 'lib.rs'), 'utf8')
check("the fake driver's sentences are the native addon's (lib.rs)", lib.includes(SCROLL_NOTE) && lib.includes(VALUE_NOTE) && lib.includes(NOT_UNIQUE) && lib.includes('a secure field is not read back'))

if (process.platform !== 'darwin') console.log('  [WARN] [4]–[5] drive the native bridge, a macOS road here (the driver refuses the query elsewhere; the Windows pack is exercised on the field box) — skipped on this platform')
else {
console.log('\n[4] the native bridge: a stub addon shows what the driver sends and how it reads the answer')
{
  const pack = await import('../../src/services/desktop/pack.js')
  const native = await import('../../src/services/desktop/nativeDriver.js')
  const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')
  const { createHash } = await import('node:crypto')
  const { mkdirSync } = await import('node:fs')
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
  let fixtureSeq = 0
  const stubPack = (body: string): string => {
    const dir = join(SCRATCH, `pack-${++fixtureSeq}`)
    mkdirSync(dir, { recursive: true })
    const permissions = JSON.stringify({ session: 'desktop', screenCapture: 'granted', input: 'granted', reason: null })
    const source = [
      'const answers = {',
      "  packVersion: () => '0.1.0',",
      `  permissions: () => (${permissions}), requestPermissions: () => (${permissions}),`,
      "  displays: () => ({ displays: [{ index: 0, id: 'fixture-1', originX: 0, originY: 0, width: 1440, height: 900, scale: 2, primary: true }], reason: null }),",
      '  capture: async () => ({ png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), width: 2880, height: 1800, scale: 2, display: 0, displayId: \'fixture-1\', originX: 0, originY: 0, capturedAt: 1 }),',
      "  frontmostApplication: () => ({ identity: 'com.example.editor', name: 'Editor', pid: 4242, title: 'Untitled', bounds: { x: 100, y: 100, width: 800, height: 600 }, reason: null }),",
      "  ownTerminalApplication: () => ({ identity: null, name: null, pid: null, title: null, bounds: null, reason: 'fixture: no terminal' }),",
      "  accessibilityTree: () => ({ elements: [{ depth: 0, role: 'AXApplication', title: 'Editor', value: null, frame: null }], truncated: false, reason: null }),",
      '  cursor: () => ({ x: 720, y: 450, display: 0, reason: null }),',
      '  mouseMove: () => {}, mouseDown: () => {}, mouseUp: () => {}, click: () => {}, drag: async () => {}, scroll: () => {}, keyTap: () => {}, keyDown: () => {}, keyUp: () => {}, typeText: async () => {},',
      '  held: () => ({ buttons: [], keys: [] }), releaseAll: () => ({ buttons: [], keys: [] }), cancel: () => {},',
      `  ${body},`,
      '}',
      'module.exports = answers',
      '',
    ].join('\n')
    writeFileSync(join(dir, 'stub.js'), source)
    const tree = pack.desktopPackTreeDigest(dir)
    const manifest = { name: pack.DESKTOP_PACK_NAME, version: '0.1.0', platform: voicePackPlatform(), addon: 'stub.js', addonSha256: sha256(source), sourceTreeDigest: sha256('fixture sources'), cargo: 'cargo fixture', crates: [{ name: 'napi', version: '3.0.0', license: 'MIT' }], fileCount: tree.fileCount, treeDigest: tree.treeDigest }
    writeFileSync(join(dir, pack.DESKTOP_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
    return dir
  }
  const usePack = (dir: string | null): ReturnType<typeof native.resolveNativeDesktopDriver> => {
    if (dir === null) delete process.env.MERCURY_DESKTOP_PACK_DIR
    else process.env.MERCURY_DESKTOP_PACK_DIR = dir
    native.resetNativeDesktopDriverForTest()
    return native.resolveNativeDesktopDriver()
  }
  const app = { identity: 'com.example.editor', name: 'Editor', pid: process.pid, title: 'Untitled', bounds: { x: 100, y: 100, width: 800, height: 600 } }
  const untitled = { depth: 20, role: 'AXStaticText', title: null, value: 'About', frame: { x: 10, y: 985, width: 100, height: 1 } }
  const shortOfExports = usePack(stubPack("readElement: () => null"))
  check('the export list requires both acts (a pack without them is refused by name)', pack.DESKTOP_ADDON_EXPORTS.includes('scrollToVisible') && pack.DESKTOP_ADDON_EXPORTS.includes('setValue') && shortOfExports.state === 'unavailable' && shortOfExports.note.includes('scrollToVisible()'), JSON.stringify(shortOfExports))
  const echo = usePack(stubPack("scrollToVisible: (pid, element, wheel) => ({ scrolled: true, frame: { x: 1, y: 2, width: 3, height: 4 }, reason: JSON.stringify({ pid, keys: Object.keys(element), wheel }) }), setValue: (pid, element, text) => ({ set: true, value: text, reason: JSON.stringify({ pid, keys: Object.keys(element) }) })"))
  if (echo.state !== 'ok') check('the stub pack resolves', false, echo.note)
  else {
    const scrolled = await echo.driver.scrollToVisible!(app, untitled, signal())
    const sent = scrolled.ok && scrolled.value.note ? (JSON.parse(scrolled.value.note) as { pid: number; keys: string[]; wheel: boolean }) : null
    check('scrollToVisible sends the pid, the element without its null keys, and asks for the wheel fallback', sent !== null && sent.pid === process.pid && !sent.keys.includes('title') && sent.keys.includes('frame') && sent.wheel === true, JSON.stringify(scrolled))
    check('…and reads scrolled and the frame back', scrolled.ok && scrolled.value.scrolled && JSON.stringify(scrolled.value.frame) === JSON.stringify({ x: 1, y: 2, width: 3, height: 4 }), JSON.stringify(scrolled))
    const set = await echo.driver.setValue!(app, untitled, 'hello', signal())
    const sentValue = set.ok && set.value.note ? (JSON.parse(set.value.note) as { pid: number; keys: string[] }) : null
    check('setValue sends the pid, the element without its null keys and the text, and reads the value back', sentValue !== null && sentValue.pid === process.pid && !sentValue.keys.includes('title') && set.ok && set.value.set && set.value.value === 'hello', JSON.stringify(set))
  }
  const refused = usePack(stubPack("scrollToVisible: () => ({ scrolled: false, frame: null, reason: 'the element does not scroll into view through the accessibility API — scroll with the wheel instead' }), setValue: () => ({ set: false, value: 'old', reason: 'the element does not accept a value through the accessibility API — type into it instead' })"))
  if (refused.state !== 'ok') check('the stub pack resolves', false, refused.note)
  else {
    const scrolled = await refused.driver.scrollToVisible!(app, untitled, signal())
    const set = await refused.driver.setValue!(app, untitled, 'x', signal())
    check('an unsupported action answers ok with scrolled false and the sentence; an unsettable value answers set false with the current value and its sentence', scrolled.ok && !scrolled.value.scrolled && scrolled.value.frame === null && scrolled.value.note === SCROLL_NOTE && set.ok && !set.value.set && set.value.value === 'old' && set.value.note === VALUE_NOTE, JSON.stringify([scrolled, set]))
  }
  const broken = usePack(stubPack("scrollToVisible: () => ({ scrolled: 'yes' }), setValue: () => 42"))
  if (broken.state !== 'ok') check('the stub pack resolves', false, broken.note)
  else {
    const scrolled = await broken.driver.scrollToVisible!(app, untitled, signal())
    const set = await broken.driver.setValue!(app, untitled, 'x', signal())
    check('an answer outside the contract is a defect naming the rebuild', !scrolled.ok && scrolled.error.kind === 'defect' && scrolled.error.note.includes('build-desktop') && !set.ok && set.error.kind === 'defect', JSON.stringify([scrolled, set]))
  }
  const unsupported = usePack(stubPack("scrollToVisible: () => { throw new Error('scrolling an element into view is unsupported on this platform (no accessibility actions in this release)') }, setValue: () => { throw new Error('the element is no longer unique in a complete window tree — read tree again') }"))
  if (unsupported.state !== 'ok') check('the stub pack resolves', false, unsupported.note)
  else {
    const scrolled = await unsupported.driver.scrollToVisible!(app, untitled, signal())
    const set = await unsupported.driver.setValue!(app, untitled, 'x', signal())
    check("a platform's unsupported words classify as unavailable; the tree sentence crosses verbatim", !scrolled.ok && scrolled.error.kind === 'unavailable' && scrolled.error.note.startsWith('scrolling an element into view is unsupported on this platform') && !set.ok && set.error.note === NOT_UNIQUE, JSON.stringify([scrolled, set]))
  }

  console.log('\n[5] the packaged addon carries both exports and answers with words, on the child the product runs (the bundled node), against this process, which has no window')
  const resolved = usePack(null)
  const load = pack.loadDesktopAddon()
  check('the packaged addon on this checkout loads with both exports (an older pack is refused by name)', load.state === 'ok' && typeof load.addon.scrollToVisible === 'function' && typeof load.addon.setValue === 'function', load.state === 'ok' ? '' : load.note)
  const permissions = load.state === 'ok' ? load.addon.permissions() : null
  const grantHolds = (grant: string): boolean => grant === 'granted' || grant === 'not-required'
  const node = join(ROOT, 'vendor', 'node', 'extracted', `${process.platform}-${process.arch}`, 'bin', 'node')
  if (resolved.state !== 'ok' || load.state !== 'ok') console.log('  [WARN] the packaged legs are skipped: no addon')
  else if (permissions === null || permissions.session !== 'desktop' || !grantHolds(permissions.screenCapture) || !grantHolds(permissions.input)) console.log(`  [WARN] the packaged legs need a desktop session with both grants and never ask for them (session ${permissions?.session}, screen ${permissions?.screenCapture}, input ${permissions?.input}) — skipped`)
  else if (!existsSync(node)) console.log('  [WARN] the bundled node is absent on this checkout (bun run scripts/vendor/fetch-node.ts) — the packaged legs are skipped')
  else {
    if (resolved.driver.describe().source !== 'workspace') console.log(`  [WARN] the driver resolved from ${resolved.driver.describe().source}, not the checkout pack — the packaged legs still run against it`)
    const thrown = (run: () => unknown): string => { try { run(); return 'answered' } catch (error) { return error instanceof Error ? error.message : String(error) } }
    const scrollWords = thrown(() => load.addon.scrollToVisible(process.pid, { depth: 20, role: 'AXStaticText', value: 'About', frame: { x: 10, y: 985, width: 100, height: 1 } }, true))
    const valueWords = thrown(() => load.addon.setValue(process.pid, { depth: 20, role: 'AXTextField', title: 'URL', frame: { x: 10, y: 10, width: 100, height: 20 } }, 'x'))
    check('on a process without a window both exports answer the reader\'s sentence, never a conversion error or a crash', scrollWords === 'the focused window is unavailable' && valueWords === scrollWords, `${scrollWords} | ${valueWords}`)
    const hostExecPath = process.execPath
    process.execPath = node
    try {
      const scrolled = await resolved.driver.scrollToVisible!(app, untitled, signal())
      const set = await resolved.driver.setValue!(app, untitled, 'x', signal())
      check('through the driver on the bundled node the same sentence arrives as the note, one line, no command line', !scrolled.ok && scrolled.error.note === scrollWords && !set.ok && set.error.note === scrollWords && !scrollWords.includes('\n'), JSON.stringify([scrolled, set]))
      console.log(`  · packaged answers on ${node.slice(ROOT.length + 1)}: ${scrollWords}`)
    } finally {
      process.execPath = hostExecPath
    }
  }
}
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures > 0 ? `\nprove-desktop-element-acts: RED (${failures})` : '\nprove-desktop-element-acts: green')
process.exit(failures > 0 ? 1 : 0)
