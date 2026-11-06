#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-bridge-')))
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
const warn = (line: string): void => console.log(`  [WARN] ${line}`)

const pack = await import('../../src/services/desktop/pack.js')
const native = await import('../../src/services/desktop/nativeDriver.js')
const fake = await import('../../src/services/desktop/fakeDesktopDriver.js')
const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')

const PLATFORM = voicePackPlatform()
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const signal = (): AbortSignal => new AbortController().signal
const app = { identity: 'com.example.editor', name: 'Editor', pid: process.pid, title: 'Untitled', bounds: { x: 100, y: 100, width: 800, height: 600 } }
const untitled = { depth: 20, role: 'AXStaticText', title: null, value: 'A line of page text', frame: { x: 10, y: 10, width: 100, height: 20 } }
const bare = { depth: 3, role: 'AXGroup', title: null, value: null, frame: null, focused: false }

let fixtureSeq = 0
function stubPack(body: string): string {
  const dir = join(SCRATCH, `pack-${++fixtureSeq}`)
  mkdirSync(dir, { recursive: true })
  const permissions = JSON.stringify({ session: 'desktop', screenCapture: 'granted', input: 'granted', reason: null })
  const source = [
    'const answers = {',
    "  packVersion: () => '0.1.0',",
    `  permissions: () => (${permissions}),`,
    `  requestPermissions: () => (${permissions}),`,
    "  displays: () => ({ displays: [{ index: 0, id: 'fixture-1', originX: 0, originY: 0, width: 1440, height: 900, scale: 2, primary: true }], reason: null }),",
    '  capture: async () => ({ png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), width: 2880, height: 1800, scale: 2, display: 0, displayId: \'fixture-1\', originX: 0, originY: 0, capturedAt: 1 }),',
    "  frontmostApplication: () => ({ identity: 'com.example.editor', name: 'Editor', pid: 4242, title: 'Untitled', bounds: { x: 100, y: 100, width: 800, height: 600 }, reason: null }),",
    "  ownTerminalApplication: () => ({ identity: null, name: null, pid: null, title: null, bounds: null, reason: 'fixture: no terminal' }),",
    "  accessibilityTree: () => ({ elements: [{ depth: 0, role: 'AXApplication', title: 'Editor', value: null, frame: null }], truncated: false, reason: null }),",
    '  cursor: () => ({ x: 720, y: 450, display: 0, reason: null }),',
    '  mouseMove: () => {}, mouseDown: () => {}, mouseUp: () => {}, click: () => {}, drag: async () => {}, scroll: () => {}, keyTap: () => {}, keyDown: () => {}, keyUp: () => {}, typeText: async () => {},',
    '  held: () => ({ buttons: [], keys: [] }), releaseAll: () => ({ buttons: [], keys: [] }), cancel: () => {},',
    "  scrollToVisible: () => ({ scrolled: false, frame: null, reason: 'fixture: no scroll' }), setValue: () => ({ set: false, value: null, reason: 'fixture: no value' }),",
    `  ${body},`,
    '}',
    'module.exports = answers',
    '',
  ].join('\n')
  writeFileSync(join(dir, 'stub.js'), source)
  const tree = pack.desktopPackTreeDigest(dir)
  const manifest = {
    name: pack.DESKTOP_PACK_NAME,
    version: '0.1.0',
    platform: PLATFORM,
    addon: 'stub.js',
    addonSha256: sha256(source),
    sourceTreeDigest: sha256('fixture sources'),
    cargo: 'cargo fixture',
    crates: [{ name: 'napi', version: '3.0.0', license: 'MIT' }],
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(join(dir, pack.DESKTOP_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  return dir
}

function usePack(dir: string | null): ReturnType<typeof native.resolveNativeDesktopDriver> {
  if (dir === null) delete process.env.MERCURY_DESKTOP_PACK_DIR
  else process.env.MERCURY_DESKTOP_PACK_DIR = dir
  native.resetNativeDesktopDriverForTest()
  return native.resolveNativeDesktopDriver()
}

const oneSentence = (note: string): boolean => !note.includes('\n') && !note.includes('Command failed') && !note.includes(' -e ') && !note.includes('.node') && !note.includes(ROOT) && !note.includes('    at ') && note.length < 300
const grantHolds = (grant: string): boolean => grant === 'granted' || grant === 'not-required'
const bundledNode = (): string | null => {
  const candidate = join(ROOT, 'vendor', 'node', 'extracted', `${process.platform}-${process.arch}`, 'bin', 'node')
  return existsSync(candidate) ? candidate : null
}

if (process.platform !== 'darwin') warn('[1]–[3] drive the native reader, a macOS road (readElement is a macOS export; the driver refuses the query elsewhere) — skipped on this platform')
else {
console.log('[1] what crosses the bridge: a stub addon records the element it received')
{
  const resolved = usePack(stubPack("readElement: (pid, element) => ({ text: JSON.stringify({ pid, keys: Object.keys(element), element }), role: element.role, title: element.title === undefined ? 'absent' : String(element.title) })"))
  if (resolved.state !== 'ok') check('the stub pack resolves', false, resolved.note)
  else {
    const answer = await resolved.driver.readElement!(app, bare, signal())
    const crossed = answer.ok && answer.value ? (JSON.parse(answer.value.text) as { pid: number; keys: string[]; element: Record<string, unknown> }) : null
    check('a null title, value and frame never cross the bridge as keys', crossed !== null && !crossed.keys.includes('title') && !crossed.keys.includes('value') && !crossed.keys.includes('frame'), JSON.stringify(answer))
    check('depth, role and a false focused cross whole', crossed !== null && crossed.element.depth === 3 && crossed.element.role === 'AXGroup' && crossed.element.focused === false && crossed.pid === process.pid, JSON.stringify(crossed))
    check('a missing title is never coerced to an empty string', answer.ok && answer.value?.title === 'absent', JSON.stringify(answer))
    const titled = await resolved.driver.readElement!(app, { depth: 1, role: 'AXTextField', title: 'URL', value: 'old', frame: { x: 1, y: 2, width: 3, height: 4 }, focused: true }, signal())
    const whole = titled.ok && titled.value ? (JSON.parse(titled.value.text) as { keys: string[]; element: Record<string, unknown> }) : null
    check('a titled element crosses whole: title, value, frame and focused intact', whole !== null && whole.keys.length === 6 && whole.element.title === 'URL' && whole.element.value === 'old' && JSON.stringify(whole.element.frame) === JSON.stringify({ x: 1, y: 2, width: 3, height: 4 }) && whole.element.focused === true, JSON.stringify(titled))
  }
}

console.log('\n[2] a native failure answers one sentence, never the command line')
{
  const resolved = usePack(stubPack("readElement: () => { throw new Error('the focused window is unavailable') }"))
  if (resolved.state !== 'ok') check('the stub pack resolves', false, resolved.note)
  else {
    const answer = await resolved.driver.readElement!(app, untitled, signal())
    check('the addon\'s own sentence is the note, verbatim', !answer.ok && answer.error.note === 'the focused window is unavailable', JSON.stringify(answer))
  }
  const denied = usePack(stubPack("readElement: () => { throw new Error('input control is not granted (denied) — Accessibility is not granted to the responsible process') }"))
  if (denied.state !== 'ok') check('the stub pack resolves', false, denied.note)
  else {
    const answer = await denied.driver.readElement!(app, untitled, signal())
    check('a grant refusal thrown in the child classifies as a permission error with the grant words', !answer.ok && answer.error.kind === 'permission' && answer.error.remedy === native.desktopGrantWords() && answer.error.note.startsWith('input control is not granted'), JSON.stringify(answer))
  }
  const crashed = usePack(stubPack('readElement: () => { process.exit(3) }'))
  if (crashed.state !== 'ok') check('the stub pack resolves', false, crashed.note)
  else {
    const answer = await crashed.driver.readElement!(app, untitled, signal())
    check('a reader that dies without an answer is one sentence naming the reader, with no argv, path or stack', !answer.ok && answer.error.note === 'readElement failed: the native reader exited without an answer' && oneSentence(answer.error.note), JSON.stringify(answer))
  }
  const flood = usePack(stubPack("readElement: () => ({ text: 'x'.repeat(17 * 1024 * 1024), role: 'AXStaticText', title: null })"))
  if (flood.state !== 'ok') check('the stub pack resolves', false, flood.note)
  else {
    const answer = await flood.driver.readElement!(app, untitled, signal())
    check('a reader that answers past the 16 MiB buffer says so', !answer.ok && answer.error.note === 'readElement failed: the native reader answered more than 16 MiB', JSON.stringify(answer))
  }
  const silent = usePack(stubPack("readElement: () => { process.stdout.write('not json') }"))
  if (silent.state !== 'ok') check('the stub pack resolves', false, silent.note)
  else {
    const answer = await silent.driver.readElement!(app, untitled, signal())
    check('an unreadable answer is named as such', !answer.ok && answer.error.note === 'readElement returned an unreadable record', JSON.stringify(answer))
  }
}

console.log('\n[3] through the packaged addon, on the child the product runs (the bundled node), against this process, which has no window: an untitled static text reaches the reader and the reader\'s own sentence comes back')
{
  const resolved = usePack(null)
  const load = pack.loadDesktopAddon()
  const permissions = load.state === 'ok' ? load.addon.permissions() : null
  const node = bundledNode()
  if (resolved.state !== 'ok' || resolved.driver.describe().source !== 'workspace' || load.state !== 'ok') warn(`the packaged addon is not on this checkout (${resolved.state === 'ok' ? resolved.driver.describe().source : resolved.note}) — the packaged legs are skipped`)
  else if (permissions === null || permissions.session !== 'desktop' || !grantHolds(permissions.screenCapture) || !grantHolds(permissions.input)) warn(`the packaged legs need a desktop session with both grants and never ask for them (session ${permissions?.session}, screen ${permissions?.screenCapture}, input ${permissions?.input}) — skipped`)
  else if (node === null) warn('the bundled node is absent on this checkout (bun run scripts/vendor/fetch-node.ts) — the packaged legs are skipped')
  else if (!load.addon.readElement) check('the packaged addon exports readElement', false, 'no readElement')
  else {
    let raw = ''
    try { load.addon.readElement(process.pid, untitled); raw = 'answered' } catch (error) { raw = error instanceof Error ? `${(error as Error & { code?: string }).code ?? ''}: ${error.message}` : String(error) }
    check('napi reads a present null title as a value and refuses it (the reason the bridge omits the key)', raw.startsWith('StringExpected: ') && raw.includes('TreeElement.title'), raw)
    const hostExecPath = process.execPath
    process.execPath = node
    try {
      const answer = await resolved.driver.readElement!(app, untitled, signal())
      const note = answer.ok ? '' : answer.error.note
      check('the null-title element reaches the native reader: the answer is the reader\'s own sentence, not StringExpected', !answer.ok && !note.includes('StringExpected') && !note.includes('Failed to convert') && note === 'the focused window is unavailable', JSON.stringify(answer))
      check('that sentence is one line with no command line, addon path or stack', oneSentence(note), note)
      console.log(`  · packaged answer on ${node.slice(ROOT.length + 1)}: ${note}`)
      const withoutFrame = await resolved.driver.readElement!(app, bare, signal())
      check('a null frame and value cross the same road', !withoutFrame.ok && !withoutFrame.error.note.includes('Cannot convert') && oneSentence(withoutFrame.error.note), JSON.stringify(withoutFrame))
      const found = await resolved.driver.findApplication!('no-such-application-zzz')
      check('an answered record still crosses the same road (findApplication names zero matches)', !found.ok && found.error.kind === 'input' && found.error.note.startsWith('0 running applications named no-such-application-zzz'), JSON.stringify(found))
    } finally {
      process.execPath = hostExecPath
    }
  }
}
}

console.log('\n[4] the fake driver reads the same element')
{
  const scene = structuredClone(fake.FAKE_SCENE_DEFAULT)
  scene.tree[0]!.children!.push({ role: 'AXStaticText', value: 'A line of page text', frame: { x: 120, y: 500, width: 300, height: 20 } })
  const driver = new fake.FakeDesktopDriver(scene, null)
  const answer = await driver.readElement(scene.frontmost, { depth: 1, role: 'AXStaticText', title: null, value: 'A line of page text', frame: { x: 120, y: 500, width: 300, height: 20 } }, signal())
  check('an untitled static text reads its value', answer.ok && answer.value?.text === 'A line of page text' && answer.value.title === null, JSON.stringify(answer))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures > 0 ? `\nprove-desktop-element-bridge: RED (${failures})` : '\nprove-desktop-element-bridge: green')
process.exit(failures > 0 ? 1 : 0)
