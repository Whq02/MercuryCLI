#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-owner-')))
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
const driver = await import('../../src/services/desktop/driver.js')
const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.js')

const PLATFORM = voicePackPlatform()
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

interface StubAnswers {
  permissions?: Record<string, unknown>
  throws?: Record<string, string>
  abort?: string[]
}

type Calls = Record<string, number>
const calls = (): Calls => (globalThis as Record<string, unknown>).__desktopStubCalls as Calls

function stubSource(answers: StubAnswers, exports: readonly string[]): string {
  const permissions = JSON.stringify(answers.permissions ?? { session: 'desktop', screenCapture: 'granted', input: 'granted', reason: null })
  const throws = JSON.stringify(answers.throws ?? {})
  const lines = [
    'const calls = (globalThis.__desktopStubCalls = globalThis.__desktopStubCalls || {})',
    `const throws = ${throws}`,
    `const abortActs = ${JSON.stringify(answers.abort ?? [])}`,
    'const count = name => { calls[name] = (calls[name] || 0) + 1; if (abortActs.includes(name)) queueMicrotask(() => globalThis.__desktopAbortController.abort()); if (throws[name]) throw new Error(throws[name]) }',
    'const answers = {',
    "  packVersion: () => { count('packVersion'); return '0.1.0' },",
    `  permissions: () => { count('permissions'); return ${permissions} },`,
    `  requestPermissions: () => { count('requestPermissions'); return ${permissions} },`,
    "  displays: () => { count('displays'); return { displays: [{ index: 0, id: 'fixture-1', originX: 0, originY: 0, width: 1440, height: 900, scale: 2, primary: true }, { index: 1, id: 'fixture-2', originX: -1920, originY: 0, width: 1920, height: 1080, scale: 1, primary: false }], reason: null } },",
    "  capture: async () => { count('capture'); return { png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), width: 2880, height: 1800, scale: 2, display: 0, displayId: 'fixture-1', originX: 0, originY: 0, capturedAt: 1 } },",
    "  frontmostApplication: () => { count('frontmostApplication'); return { identity: 'com.example.editor', name: 'Editor', pid: 4242, title: 'Untitled', bounds: { x: 100, y: 100, width: 800, height: 600 }, reason: null } },",
    "  ownTerminalApplication: () => { count('ownTerminalApplication'); return { identity: null, name: null, pid: null, title: null, bounds: null, reason: 'fixture: no terminal' } },",
    "  cursor: () => { count('cursor'); return { x: 720, y: 450, display: 0, reason: null } },",
    "  mouseMove: () => { count('mouseMove') },",
    "  mouseDown: () => { count('mouseDown') },",
    "  mouseUp: () => { count('mouseUp') },",
    "  click: () => { count('click') },",
    "  drag: async () => { count('drag') },",
    "  scroll: () => { count('scroll') },",
    "  keyTap: () => { count('keyTap') },",
    "  keyDown: () => { count('keyDown') },",
    "  keyUp: () => { count('keyUp') },",
    "  typeText: async () => { count('typeText') },",
    "  held: () => { count('held'); return { buttons: [], keys: [] } },",
    "  releaseAll: () => { count('releaseAll'); return { buttons: [], keys: [] } },",
    "  cancel: () => { count('cancel') },",
    '}',
    'module.exports = {}',
    `for (const name of ${JSON.stringify(exports)}) module.exports[name] = answers[name]`,
    '',
  ]
  return lines.join('\n')
}

let fixtureSeq = 0
function fixturePack(opts: { answers?: StubAnswers; exports?: readonly string[]; platform?: string; addonSha?: string; dropAddon?: boolean } = {}): string {
  const dir = join(SCRATCH, `pack-${++fixtureSeq}`)
  mkdirSync(dir, { recursive: true })
  const source = stubSource(opts.answers ?? {}, opts.exports ?? pack.DESKTOP_ADDON_EXPORTS)
  writeFileSync(join(dir, 'stub.js'), source)
  const tree = pack.desktopPackTreeDigest(dir)
  const manifest = {
    name: pack.DESKTOP_PACK_NAME,
    version: '0.1.0',
    platform: opts.platform ?? PLATFORM,
    addon: 'stub.js',
    addonSha256: opts.addonSha ?? sha256(source),
    sourceTreeDigest: sha256('fixture sources'),
    cargo: 'cargo fixture',
    crates: [{ name: 'napi', version: '3.0.0', license: 'MIT' }],
    fileCount: tree.fileCount,
    treeDigest: tree.treeDigest,
  }
  writeFileSync(join(dir, pack.DESKTOP_PACK_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  if (opts.dropAddon) rmSync(join(dir, 'stub.js'))
  return dir
}

function usePack(dir: string): void {
  process.env.MERCURY_DESKTOP_PACK_DIR = dir
  native.resetNativeDesktopDriverForTest()
  ;(globalThis as Record<string, unknown>).__desktopStubCalls = {}
}

const stderrLines: string[] = []
const realWrite = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  stderrLines.push(String(chunk))
  return true
}) as typeof process.stderr.write

console.log('[1] the pin names itself')
{
  const empty = join(SCRATCH, 'empty')
  mkdirSync(empty, { recursive: true })
  usePack(empty)
  const resolution = pack.resolveDesktopPackDir()
  check('an empty MERCURY_DESKTOP_PACK_DIR answers unavailable, naming the pin and refusing a silent fallback', resolution.state === 'unavailable' && resolution.note.includes('MERCURY_DESKTOP_PACK_DIR') && resolution.note.includes('no silent fallback'), JSON.stringify(resolution))
  const load = native.resolveNativeDesktopDriver()
  check('the native driver answers unavailable with the same note and no remedy', load.state === 'unavailable' && load.note === resolution.note && load.remedy === null, JSON.stringify(load))
}

console.log('\n[2] a pack of another platform')
{
  const dir = fixturePack({ platform: 'fixture-os-fixture-arch' })
  const result = pack.checkDesktopPackDir(dir)
  check('reads as a mismatch naming both platforms', result.state === 'mismatch' && result.note.includes('fixture-os-fixture-arch') && result.note.includes(PLATFORM), JSON.stringify(result))
}

console.log('\n[3] a manifest whose addon file is missing')
{
  const dir = fixturePack({ dropAddon: true })
  const result = pack.checkDesktopPackDir(dir)
  check('reads as a mismatch naming the file', result.state === 'mismatch' && result.note.includes('stub.js'), JSON.stringify(result))
}

console.log('\n[4] a manifest whose digest disagrees with the addon')
{
  const dir = fixturePack({ addonSha: sha256('other bytes') })
  const result = pack.checkDesktopPackDir(dir, { digest: true })
  check('reads as a mismatch naming both digest prefixes', result.state === 'mismatch' && result.note.includes(sha256('other bytes').slice(0, 12)) && result.note.includes('expected') && result.note.includes('got'), JSON.stringify(result))
  check('…and passes without the digest', pack.checkDesktopPackDir(dir).state === 'ok')
}

console.log('\n[5] the absent note fits the install')
check('a release install says the build shipped without it and names the update', pack.desktopPackAbsentNote(null).startsWith('absent — this build shipped without it') && pack.desktopPackAbsentNote(null).includes('mercury update'))
check('a checkout names the build command', pack.desktopPackAbsentNote('/x').includes('build-desktop.ts') && pack.desktopPackAbsentNote('/x').includes('cargo'))

console.log('\n[6] a stub short of one export')
{
  const dir = fixturePack({ exports: pack.DESKTOP_ADDON_EXPORTS.filter(name => name !== 'cancel') })
  usePack(dir)
  const load = pack.loadDesktopAddon()
  check('the loader refuses, naming the missing export and the build command', load.state === 'unavailable' && load.note.includes('cancel()') && load.note.includes('build-desktop.ts'), JSON.stringify(load))
  const resolved = native.resolveNativeDesktopDriver()
  check('the native driver carries the refusal with no remedy', resolved.state === 'unavailable' && resolved.note === load.note && resolved.remedy === null, JSON.stringify(resolved))
}

console.log('\n[7] the driver refuses a capture before the addon can fail silently')
{
  const dir = fixturePack({ answers: { permissions: { session: 'desktop', screenCapture: 'denied', input: 'granted', reason: 'fixture: the grant is missing' } } })
  usePack(dir)
  const resolved = native.resolveNativeDesktopDriver()
  check('the stub pack resolves through the pin', resolved.state === 'ok' && resolved.driver.describe().source === 'override' && resolved.driver.describe().kind === 'native', resolved.state === 'ok' ? '' : resolved.note)
  if (resolved.state === 'ok') {
    const shot = await resolved.driver.capture(0, new AbortController().signal)
    check('capture answers a permission refusal with the grant words as the remedy', !shot.ok && shot.error.kind === 'permission' && shot.error.remedy === native.desktopGrantWords() && shot.error.note.includes('fixture: the grant is missing'), JSON.stringify(shot))
    check('…and never called the addon capture', (calls().capture ?? 0) === 0, JSON.stringify(calls()))
    check('…but asked the platform once to register the grants', (calls().requestPermissions ?? 0) === 1, JSON.stringify(calls()))
    const again = await resolved.driver.capture(0, new AbortController().signal)
    check('a second refused capture asks no second time', !again.ok && again.error.kind === 'permission' && (calls().requestPermissions ?? 0) === 1, JSON.stringify(calls()))
    const move = await resolved.driver.mouseMove({ x: 1, y: 1 }, new AbortController().signal)
    check('an act rides the input grant, which this stub answers granted', move.ok && move.value.act === 'move' && (calls().mouseMove ?? 0) === 1, JSON.stringify(move))
    const facts = await native.describeDesktopDriver()
    check('the doctor facts are not ready and carry the grant words as the fix', !facts.ready && facts.fix === native.desktopGrantWords() && facts.line.includes('screen: denied') && facts.detail.includes('driving now: none'), JSON.stringify(facts))
    check('the doctor and the permission reads never ask the platform', (calls().requestPermissions ?? 0) === 1, JSON.stringify(calls()))
  }
}

console.log('\n[8] the driver validates before the call and classifies what the addon throws')
{
  const dir = fixturePack({ answers: { throws: { click: 'boom', mouseMove: 'no such key: x' } } })
  usePack(dir)
  const resolved = native.resolveNativeDesktopDriver()
  if (resolved.state !== 'ok') check('the stub pack resolves', false, resolved.note)
  else {
    const d = resolved.driver
    const signal = new AbortController().signal
    const badKey = await d.keyTap('hyperspace', [], signal)
    check('a key outside the table is refused before the addon sees it', !badKey.ok && badKey.error.kind === 'input' && badKey.error.note === 'no such key: hyperspace' && (calls().keyTap ?? 0) === 0, JSON.stringify(badKey))
    const badModifier = await d.keyTap('a', ['hyper' as never], signal)
    check('a modifier outside the table is refused by name', !badModifier.ok && badModifier.error.kind === 'input' && badModifier.error.note === 'no such modifier: hyper', JSON.stringify(badModifier))
    const badCount = await d.click({ x: 1, y: 1 }, 'left', 4 as never, signal)
    check('a click count outside 1..3 is refused', !badCount.ok && badCount.error.kind === 'input' && (calls().click ?? 0) === 0, JSON.stringify(badCount))
    const badPoint = await d.mouseMove({ x: Number.NaN, y: 1 }, signal)
    check('a non-finite point is refused', !badPoint.ok && badPoint.error.kind === 'input' && (calls().mouseMove ?? 0) === 0, JSON.stringify(badPoint))
    const boom = await d.click({ x: 1, y: 1 }, 'left', 1, signal)
    check('a thrown reason with no known head becomes a defect record, nothing thrown', !boom.ok && boom.error.kind === 'defect' && boom.error.note === 'boom', JSON.stringify(boom))
    const input = await d.mouseMove({ x: 1, y: 1 }, signal)
    check('a thrown "no such" reason becomes an input record', !input.ok && input.error.kind === 'input' && input.error.note === 'no such key: x', JSON.stringify(input))
    const empty = await d.typeText('', {}, signal)
    check('typing nothing is a receipt without a call', empty.ok && empty.value.act === 'type' && (calls().typeText ?? 0) === 0, JSON.stringify(empty))
    const badGap = await d.typeText('a', { gapMs: 2.5 }, signal)
    check('a fractional gap is refused by name', !badGap.ok && badGap.error.kind === 'input' && badGap.error.note.includes('gapMs'), JSON.stringify(badGap))
    const aborted = new AbortController()
    aborted.abort()
    const early = await d.typeText('abc', {}, aborted.signal)
    check('a signal already aborted answers aborted before the addon is called', !early.ok && early.error.kind === 'aborted' && (calls().typeText ?? 0) === 0, JSON.stringify(early))
    const front = await d.frontmostApplication()
    check('the frontmost application maps its identity, name, pid, title and bounds', front.ok && front.value.identity === 'com.example.editor' && front.value.name === 'Editor' && front.value.pid === 4242 && front.value.title === 'Untitled' && front.value.bounds?.width === 800, JSON.stringify(front))
    const previousTerm = process.env.TERM_PROGRAM
    process.env.TERM_PROGRAM = 'iTerm.app'
    const own = await d.ownTerminalApplication()
    check('only a macOS terminal receives the bundle-identity fallback', own.ok && (process.platform === 'darwin' ? own.value?.identity === 'com.googlecode.iterm2' && own.value.name === 'iTerm.app' : own.value === null), JSON.stringify(own))
    process.env.TERM_PROGRAM = 'something-else'
    const unknown = await d.ownTerminalApplication()
    check('an unknown terminal program answers null, never a guess', unknown.ok && unknown.value === null, JSON.stringify(unknown))
    if (previousTerm === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousTerm
    const shot = await d.capture(1, signal)
    check('a capture maps the record and stamps capturedAt with the driver\'s clock', shot.ok && shot.value.displayId === 'fixture-1' && shot.value.width === 2880 && shot.value.scale === 2 && shot.value.capturedAt > 1_000_000_000_000, JSON.stringify(shot.ok ? { ...shot.value, png: shot.value.png.length } : shot))
    const list = await d.displays()
    check('displays keep the addon\'s order and gain a fingerprint', list.ok && list.value.displays[1]?.originX === -1920 && /^[0-9a-f]{16}$/.test(list.value.fingerprint), JSON.stringify(list))
    await d.close()
    const closed = await d.cursor()
    check('a closed driver refuses by name and released everything at close', !closed.ok && closed.error.kind === 'unavailable' && (calls().releaseAll ?? 0) === 1, JSON.stringify(closed))
  }
  check('nothing reached stderr through the refusals', stderrLines.length === 0, stderrLines.join('|').slice(0, 300))
}

console.log('\n[9] an answer outside the contract is a defect naming the field')
{
  const dir = fixturePack({ answers: { permissions: { session: 'elsewhere', screenCapture: 'granted', input: 'granted', reason: null } } })
  usePack(dir)
  const resolved = native.resolveNativeDesktopDriver()
  if (resolved.state !== 'ok') check('the stub pack resolves', false, resolved.note)
  else {
    const permissions = await resolved.driver.permissions()
    check('permissions with a session outside the union is a defect naming the field and the build command', !permissions.ok && permissions.error.kind === 'defect' && permissions.error.note.includes('session "elsewhere"') && permissions.error.note.includes('build-desktop.ts'), JSON.stringify(permissions))
    const move = await resolved.driver.mouseMove({ x: 1, y: 1 }, new AbortController().signal)
    check('an act refuses on the same defect before the addon is called', !move.ok && move.error.kind === 'defect' && (calls().mouseMove ?? 0) === 0, JSON.stringify(move))
  }
}

console.log('\n[10] the pure arithmetic of the contract')
{
  const displays = [
    { index: 0, id: 'a', originX: 0, originY: 0, width: 1440, height: 900, scale: 2, primary: true },
    { index: 1, id: 'b', originX: -1920, originY: 0, width: 1920, height: 1080, scale: 1, primary: false },
  ]
  const first = driver.displaysFingerprint(displays)
  const again = driver.displaysFingerprint(displays.map(d => ({ ...d })))
  const moved = driver.displaysFingerprint(displays.map((d, i) => (i === 1 ? { ...d, originX: -1921 } : d)))
  check('the fingerprint is stable across calls and changes when an origin changes', first === again && first !== moved && /^[0-9a-f]{16}$/.test(first), `${first} ${again} ${moved}`)
  const point = driver.capturePixelToPoint({ scale: 2, originX: -1920, originY: 0 }, 100, 50)
  check('a screenshot pixel maps to its global point through the scale and the origin', point.x === -1870 && point.y === 25, JSON.stringify(point))
}

console.log('\n[11] the doctor row')
{
  const report = await import('../../src/utils/healthReport.js')
  const rowOf = async (): Promise<{ status: string; fix?: string; evidence: string; section: string } | null> => {
    const cert = await report.runHealthReport({ depth: 'fast' })
    for (const section of cert.sections) {
      const row = section.checks.find(c => c.id === 'iface-computer-use')
      if (row) return { status: String(row.status), ...(row.fix ? { fix: row.fix } : {}), evidence: String(row.evidence), section: section.title }
    }
    return null
  }
  usePack(fixturePack({ answers: { permissions: { session: 'desktop', screenCapture: 'denied', input: 'denied', reason: 'fixture: both grants missing' } } }))
  const denied = await rowOf()
  check('a denied grant is info with the fix beside it, in the INTERFACE section; the switch unset reads on', denied !== null && denied.section === 'INTERFACE' && denied.status === 'info' && denied.fix === native.desktopGrantWords() && denied.evidence.includes('computer use on'), JSON.stringify(denied))
  check('the doctor row opens no dialog: the grant request is never made for it', (calls().requestPermissions ?? 0) === 0, JSON.stringify(calls()))
  usePack(fixturePack())
  const registered = FLAG_REGISTRY.some(row => row.env === 'MERCURY_COMPUTER_USE')
  process.env.MERCURY_COMPUTER_USE = '1'
  const granted = await rowOf()
  if (registered) {
    check('granted, a desktop session and the switch on read ok', granted !== null && granted.status === 'ok' && granted.evidence.includes('computer use on') && granted.fix === undefined, JSON.stringify(granted))
  } else {
    warn('the MERCURY_COMPUTER_USE row is not in this tree yet: the switch reads off, so the row stays info')
    check('granted and a desktop session without the switch read info with no fix', granted !== null && granted.status === 'info' && granted.evidence.includes('computer use off') && granted.fix === undefined, JSON.stringify(granted))
  }
  process.env.MERCURY_COMPUTER_USE = '0'
  const off = await rowOf()
  check('the switch =0 keeps the row at info', off !== null && off.status === 'info' && off.evidence.includes('computer use off'), JSON.stringify(off))
  delete process.env.MERCURY_COMPUTER_USE
}

console.log('\n[12] an interrupted async native act never answers success')
{
  usePack(fixturePack({ answers: { abort: ['drag'] } }))
  const controller = new AbortController()
  ;(globalThis as Record<string, unknown>).__desktopAbortController = controller
  const resolved = native.resolveNativeDesktopDriver()
  if (resolved.state !== 'ok') check('the abort stub resolves', false, resolved.note)
  else {
    const result = await resolved.driver.drag({ x: 0, y: 0 }, { x: 10, y: 10 }, 'left', controller.signal)
    check('an abort before the async reply stays an aborted result', !result.ok && result.error.kind === 'aborted', JSON.stringify(result))
    check('the signal crossed to native cancel exactly once', (calls().cancel ?? 0) === 1, JSON.stringify(calls()))
  }
  delete (globalThis as Record<string, unknown>).__desktopAbortController
}

console.log('\n[13] a daemon worker reads the cockpit terminal, never the daemon ancestry')
{
  const { getSessionId } = await import('../../src/bootstrap/state.js')
  const { concourseWorkersPath, focusConcourseSession, blurConcourseSession } = await import('../../src/daemon/concourseSupervisor.js')
  const statePath = concourseWorkersPath()
  mkdirSync(join(SCRATCH, 'daemon'), { recursive: true })
  const sessionId = String(getSessionId())
  writeFileSync(statePath, JSON.stringify({ version: 1, workers: { fixture: { runnerId: 'fixture', sessionId, pid: process.pid } } }))
  const previousRole = process.env.MERCURY_CONCOURSE_WORKER
  const previousTerm = process.env.TERM_PROGRAM
  usePack(fixturePack())
  process.env.MERCURY_CONCOURSE_WORKER = '1'
  process.env.TERM_PROGRAM = 'Apple_Terminal'
  try {
    const resolved = native.resolveNativeDesktopDriver()
    if (resolved.state !== 'ok') check('the worker stub pack resolves', false, resolved.note)
    else {
      const d = resolved.driver
      const missing = await d.ownTerminalApplication()
      check('no cockpit fact means unknown, not the daemon TERM_PROGRAM', missing.ok && missing.value === null)
      focusConcourseSession(sessionId, `operator:${process.pid}`, undefined, { identity: 'com.example.CockpitTerminal', name: 'Cockpit terminal' })
      const own = await d.ownTerminalApplication()
      check('the worker reads the focused cockpit identity from the durable record', own.ok && own.value?.identity === 'com.example.CockpitTerminal' && own.value.name === 'Cockpit terminal', JSON.stringify(own))
      check('the worker never consults its add-on ancestry for this identity', (calls().ownTerminalApplication ?? 0) === 0, JSON.stringify(calls()))
      focusConcourseSession(sessionId, `operator:${process.pid}`, undefined, { identity: 'com.example.OtherTerminal', name: 'Other terminal' })
      const changed = await d.ownTerminalApplication()
      check('re-focusing in a different terminal refreshes the identity', changed.ok && changed.value?.identity === 'com.example.OtherTerminal')
      blurConcourseSession(sessionId, `operator:${process.pid}`)
      const blurred = await d.ownTerminalApplication()
      check('a blurred session cannot reuse the former terminal identity', blurred.ok && blurred.value === null)
    }
  } finally {
    if (previousRole === undefined) delete process.env.MERCURY_CONCOURSE_WORKER
    else process.env.MERCURY_CONCOURSE_WORKER = previousRole
    if (previousTerm === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previousTerm
  }
}

process.stderr.write = realWrite
rmSync(SCRATCH, { recursive: true, force: true })
if (failures > 0) {
  console.log(`\nprove-desktop-owner: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-desktop-owner: green')
process.exit(0)
