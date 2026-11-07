#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-capture-child-')))
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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 500) : ''}`)
  if (!cond) failures++
}

const pack = await import('../../src/services/desktop/pack.js')
const native = await import('../../src/services/desktop/nativeDriver.js')
const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const EVENTS = join(SCRATCH, 'captures.jsonl')
const CONTROL = join(SCRATCH, 'control.json')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const noop = (name: string): string => `  ${name}: () => undefined,`
const stub = [
  "const fs = require('node:fs')",
  `const EVENTS = ${JSON.stringify(EVENTS)}`,
  `const CONTROL = ${JSON.stringify(CONTROL)}`,
  'const control = () => { try { return JSON.parse(fs.readFileSync(CONTROL, "utf8")) } catch { return {} } }',
  'const sleep = ms => new Promise(r => setTimeout(r, ms))',
  "const image = () => ({ png: Buffer.from(" + JSON.stringify(PNG) + ", 'base64'), width: 2880, height: 1800, scale: 2, display: 0, displayId: 'fixture-1', originX: 0, originY: 0, capturedAt: Date.now() })",
  'let calls = 0',
  'async function take(kind, display, region) {',
  '  const plan = control()',
  '  const seq = (() => { try { return fs.readFileSync(EVENTS, "utf8").split("\\n").filter(Boolean).length } catch { return 0 } })()',
  '  fs.appendFileSync(EVENTS, JSON.stringify({ seq, kind, display, region: region ?? null, pid: process.pid, inChild: process.argv[1] === __filename, at: Date.now() }) + "\\n")',
  '  calls += 1',
  "  const step = Array.isArray(plan.steps) ? plan.steps[seq] ?? plan.steps[plan.steps.length - 1] : 'ok'",
  "  if (step === 'hang') await sleep(8000)",
  "  if (step === 'null') throw new Error(kind === 'region' ? 'the capture region has no image' : `no display ${display} image could be created`)",
  "  if (step === 'huge') return { ...image(), png: Buffer.concat([Buffer.from(" + JSON.stringify(PNG) + ", 'base64'), Buffer.alloc(65 * 1024 * 1024)]) }",
  '  return image()',
  '}',
  "const sync = display => { const plan = control(); const seq = (() => { try { return fs.readFileSync(EVENTS, 'utf8').split('\\n').filter(Boolean).length } catch { return 0 } })(); if ((Array.isArray(plan.steps) ? plan.steps[seq] : undefined) === 'throw') { fs.appendFileSync(EVENTS, JSON.stringify({ seq, kind: 'sync-throw', display, region: null, pid: process.pid, inChild: process.argv[1] === __filename, at: Date.now() }) + '\\n'); throw new Error(`no display ${display} image could be created`) } }",
  'const answers = {',
  "  packVersion: () => '0.1.0',",
  "  permissions: () => ({ session: 'desktop', screenCapture: 'granted', input: 'granted', reason: null }),",
  "  requestPermissions: () => ({ session: 'desktop', screenCapture: 'granted', input: 'granted', reason: null }),",
  "  displays: () => ({ displays: [{ index: 0, id: 'fixture-1', originX: 0, originY: 0, width: 1440, height: 900, scale: 2, primary: true }], reason: null }),",
  "  capture: display => { sync(display); return take('full', display) },",
  "  captureRegion: (display, region) => { sync(display); return take('region', display, region) },",
  "  frontmostApplication: () => ({ identity: 'com.example.editor', name: 'Editor', pid: 4242, title: 'Untitled', bounds: { x: 0, y: 0, width: 800, height: 600 }, reason: null }),",
  "  ownTerminalApplication: () => ({ identity: null, name: null, pid: null, title: null, bounds: null, reason: 'fixture: no terminal' }),",
  "  accessibilityTree: () => ({ elements: [], truncated: false, reason: null }),",
  "  cursor: () => ({ x: 1, y: 1, display: 0, reason: null }),",
  "  held: () => ({ buttons: [], keys: [] }),",
  "  releaseAll: () => ({ buttons: [], keys: [] }),",
  ...['mouseMove', 'mouseDown', 'mouseUp', 'click', 'drag', 'scroll', 'keyTap', 'keyDown', 'keyUp', 'typeText', 'cancel'].map(noop),
  '}',
  'module.exports = {}',
  `for (const name of ${JSON.stringify([...pack.DESKTOP_ADDON_EXPORTS, 'captureRegion'])}) module.exports[name] = answers[name] ?? (() => undefined)`,
  '',
].join('\n')

const dir = join(SCRATCH, 'pack')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'stub.js'), stub)
const tree = pack.desktopPackTreeDigest(dir)
writeFileSync(join(dir, pack.DESKTOP_PACK_MANIFEST_FILE), JSON.stringify({
  name: pack.DESKTOP_PACK_NAME,
  version: '0.1.0',
  platform: voicePackPlatform(),
  addon: 'stub.js',
  addonSha256: sha256(stub),
  sourceTreeDigest: sha256('fixture sources'),
  cargo: 'cargo fixture',
  crates: [{ name: 'napi', version: '3.0.0', license: 'MIT' }],
  fileCount: tree.fileCount,
  treeDigest: tree.treeDigest,
}, null, 2) + '\n')
process.env.MERCURY_DESKTOP_PACK_DIR = dir
native.resetNativeDesktopDriverForTest()
const load = native.resolveNativeDesktopDriver()
if (load.state !== 'ok') {
  console.log(`  [FAIL] the fixture pack did not load: ${load.note}`)
  process.exit(1)
}
const driver = load.driver

interface CaptureEvent { seq: number; kind: string; display: number; region: unknown; pid: number; inChild: boolean; at: number }
const events = (): CaptureEvent[] => (existsSync(EVENTS) ? readFileSync(EVENTS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as CaptureEvent) : [])
const plan = (steps: string[]): void => {
  writeFileSync(CONTROL, JSON.stringify({ steps }))
  writeFileSync(EVENTS, '')
}
const DARWIN = process.platform === 'darwin'
const signal = (): AbortSignal => new AbortController().signal

console.log(`[1] a capture ${DARWIN ? 'runs in a short-lived child of this binary and the connection ends with it' : 'stays in-process off macOS (the eviction is a macOS replayd behaviour)'}`)
{
  plan(['ok'])
  const started = Date.now()
  const answer = await driver.capture(0, signal())
  const elapsed = Date.now() - started
  const seen = events()
  check('the capture answers a PNG with its geometry', answer.ok && answer.value.width === 2880 && answer.value.height === 1800 && answer.value.scale === 2 && answer.value.displayId === 'fixture-1' && answer.value.png[0] === 0x89 && answer.value.png.length === Buffer.from(PNG, 'base64').length, JSON.stringify(answer.ok ? { ...answer.value, png: answer.value.png.length } : answer))
  check('one capture was taken', seen.length === 1 && seen[0]!.kind === 'full' && seen[0]!.display === 0, JSON.stringify(seen))
  if (DARWIN) {
    check('it ran in a child (argv[1] is the addon), never in this process', seen[0]!.inChild === true && seen[0]!.pid !== process.pid, JSON.stringify(seen))
    console.log(`  (one child capture took ${elapsed} ms including the spawn)`)
  } else {
    check('it ran in this process', seen[0]!.inChild === false && seen[0]!.pid === process.pid, JSON.stringify(seen))
  }
  plan(['ok'])
  const region = await driver.captureRegion!(0, { x: 10, y: 20, width: 300, height: 200 }, signal())
  const regionSeen = events()
  check('a region capture carries its bounds to the capture the same way', region.ok && regionSeen.length === 1 && regionSeen[0]!.kind === 'region' && JSON.stringify(regionSeen[0]!.region) === JSON.stringify({ x: 10, y: 20, width: 300, height: 200 }) && (!DARWIN || regionSeen[0]!.inChild), JSON.stringify(regionSeen))
  plan(['ok', 'ok'])
  await driver.capture(0, signal())
  await driver.capture(0, signal())
  const pair = events()
  check(DARWIN ? 'two captures are two children: no process keeps the connection between them' : 'two captures run in this process', pair.length === 2 && (DARWIN ? pair[0]!.pid !== pair[1]!.pid && pair.every(e => e.inChild) : pair.every(e => e.pid === process.pid)), JSON.stringify(pair))
}

if (DARWIN) {
  console.log('[2] a capture past the 2.5 s deadline is killed and retried once in a fresh child')
  {
    plan(['hang', 'ok'])
    const started = Date.now()
    const answer = await driver.capture(0, signal())
    const elapsed = Date.now() - started
    const seen = events()
    check('the retry answers the image', answer.ok && answer.value.width === 2880, JSON.stringify(answer.ok ? 'ok' : answer))
    check('two children took part, the first killed at the deadline (the whole call stays under about 4 s: 2.5 s + a 200–800 ms wait + the retry)', seen.length === 2 && seen[0]!.pid !== seen[1]!.pid && elapsed >= 2_600 && elapsed < 5_500, `${elapsed} ms · ${JSON.stringify(seen)}`)
  }

  console.log('[3] a second miss names the condition (and a session holding this binary when one is found), never "no display 0 image could be created"')
  {
    plan(['hang', 'hang', 'ok'])
    const started = Date.now()
    const answer = await driver.capture(0, signal())
    const elapsed = Date.now() - started
    const seen = events()
    check('the answer is a busy refusal', !answer.ok && answer.error.kind === 'busy', JSON.stringify(answer))
    const note = answer.ok ? '' : answer.error.note
    check('its words name the cancelled connection, the same binary, the granted permission and the remedy, and claim no holder', note.startsWith('macOS cancelled the screen-capture connection twice: another process on this Mercury node binary was capturing at the same moment, or macOS is still settling after an earlier clash (no other Mercury session was found on this binary)') && note.includes('Screen Recording is granted — wait about fifteen seconds and retry') && !note.includes('holds it'), note)
    check('the old sentences are gone from this road', !note.includes('no display') && !note.includes('has no image'), note)
    check('exactly two children were started and both ended at the deadline (no third attempt; about 5–7 s in all)', seen.length === 2 && elapsed >= 5_000 && elapsed < 8_000, `${elapsed} ms · ${JSON.stringify(seen)}`)
  }

  console.log('[3b] a second process on this binary with a writer lock is named as another session, never as a holder')
  {
    const peer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true })
    const project = join(process.env.MERCURY_CONFIG_DIR!, 'projects', '-Users-fixture-project-0123abcd')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'fedcba98-0000-4000-8000-000000000000.jsonl.writer.lock'), JSON.stringify({ owner: 'fixture', pid: peer.pid, acquiredAt: Date.now() }))
    await new Promise(resolve => setTimeout(resolve, 300))
    plan(['hang', 'hang', 'ok'])
    const answer = await driver.capture(0, signal())
    peer.kill('SIGKILL')
    const note = answer.ok ? '' : answer.error.note
    check('the words list that session by its id and pid under "the other Mercury sessions on this binary" and end with the clash remedy', !answer.ok && answer.error.kind === 'busy' && note.includes(`the other Mercury sessions on this binary: session fedcba98… (pid ${peer.pid})`) && note.endsWith('a session whose screenshots keep clashing with this one can be ended'), note)
  }

  console.log('[4] a fast NULL keeps its own words (a display that is gone is not a held connection)')
  {
    plan(['null'])
    const started = Date.now()
    const answer = await driver.capture(0, signal())
    const elapsed = Date.now() - started
    check('the display words come back unchanged, as a display refusal, with no retry', !answer.ok && answer.error.kind === 'display' && answer.error.note === 'no display 0 image could be created' && events().length === 1 && elapsed < 2_000, `${elapsed} ms · ${JSON.stringify(answer)}`)
    plan(['null'])
    const region = await driver.captureRegion!(0, { x: 0, y: 0, width: 10, height: 10 }, signal())
    check('a region NULL keeps its words too', !region.ok && region.error.note === 'the capture region has no image', JSON.stringify(region))
    plan(['throw'])
    const thrown = await driver.capture(0, signal())
    const thrownSeen = events()
    check('an addon that throws synchronously inside the child (no such display) answers its own words as a display refusal, never a command line', !thrown.ok && thrown.error.kind === 'display' && thrown.error.note === 'no display 0 image could be created' && thrownSeen.length === 1 && thrownSeen[0]!.kind === 'sync-throw' && thrownSeen[0]!.inChild === true, JSON.stringify({ thrown, thrownSeen }))
  }

  console.log('[4b] a capture larger than the child\'s 64 MiB answer names that cause')
  {
    plan(['huge'])
    const answer = await driver.capture(0, signal())
    check('the words name the buffer, not a bare exit', !answer.ok && answer.error.note === 'the capture child answered more than 64 MiB', JSON.stringify(answer))
  }

  console.log('[5] an interrupted capture ends its child at once')
  {
    plan(['hang'])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const started = Date.now()
    const answer = await driver.capture(0, controller.signal)
    const elapsed = Date.now() - started
    check('the answer is the aborted answer, well before the deadline', !answer.ok && answer.error.kind === 'aborted' && elapsed < 1_500, `${elapsed} ms · ${JSON.stringify(answer)}`)
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
