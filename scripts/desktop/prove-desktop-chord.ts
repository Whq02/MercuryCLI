#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-chord-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
for (const key of ['MERCURY_DESKTOP_DRIVER', 'MERCURY_COMPUTER_USE', 'MERCURY_HOME']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)
const LIVE = (process.env.MERCURY_SUITE_DESKTOP_LIVE ?? '').trim()
const TEXTEDIT = 'com.apple.TextEdit'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 600) : ''}`)
  if (!cond) failures++
}
const warn = (line: string): void => console.log(`  [WARN] ${line}`)
const finish = (note: string): never => {
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures > 0 ? `\nprove-desktop-chord: RED (${failures})` : `\nprove-desktop-chord: green${note ? ` (${note})` : ''}`)
  process.exit(failures > 0 ? 1 : 0)
}
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

console.log('[1] the leaf: the key event mac.rs builds for a chord, read back instead of posted')
const rustc = Bun.which('rustc')
if (process.platform !== 'darwin') {
  warn('the macOS leaf compiles against CoreGraphics — this leg runs on macOS only')
} else if (rustc === null) {
  warn('rustc is absent — the desktop pack build needs the same toolchain; this leg is skipped')
} else {
  const mac = readFileSync(join(ROOT, 'native/desktop/src/mac.rs'), 'utf8')
  const span = (start: string, end: string): string => {
    const first = mac.indexOf(start)
    const last = mac.indexOf(end, first + start.length)
    if (first < 0 || last <= first) throw new Error(`mac.rs boundary missing: ${start} / ${end}`)
    return mac.slice(first, last)
  }
  const body = [
    span('type CFTypeRef', '#[link(name = "AppKit"'),
    span('const EVENT_SOURCE_HID_SYSTEM_STATE', 'fn rect('),
    span('unsafe fn source()', 'unsafe fn post('),
    span('fn flags_of(', 'unsafe fn tap_code('),
  ].join('\n')
  const source = join(SCRATCH, 'chord.rs')
  const binary = join(SCRATCH, 'chord')
  writeFileSync(source, `${readFileSync(join(import.meta.dir, 'nativeChordFixture.rs'), 'utf8')}\n${body}`)
  writeFileSync(join(SCRATCH, 'keys.rs'), readFileSync(join(ROOT, 'native/desktop/src/keys.rs')))
  const build = spawnSync(rustc, ['--edition=2021', '--test', source, '-o', binary], { encoding: 'utf8', timeout: 120_000, env: process.env })
  check('the key road of mac.rs (flags_of · keycode · key) compiles against a post that reads the event back', build.status === 0, `${build.stdout ?? ''}${build.stderr ?? ''}`)
  if (build.status === 0) {
    const result = spawnSync(binary, ['--test-threads=1'], { encoding: 'utf8', timeout: 60_000, env: process.env })
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
    process.stdout.write(out.split('\n').filter(line => /^test |panicked|assertion|test result/.test(line)).map(line => `    ${line}`).join('\n') + '\n')
    check('a cmd/ctrl/alt chord on a character key carries the modifier flag and no Unicode string; a plain or shifted key keeps its character', result.status === 0, out.split('\n').filter(line => /panicked|assertion/.test(line)).join(' | '))
  }
}

console.log('\n[2] live: a chord through the native driver reaches the frontmost application as its own shortcut')
let liveReason = LIVE === 'acts' ? '' : `MERCURY_SUITE_DESKTOP_LIVE is ${LIVE || 'unset'}, not acts`
if (liveReason === '' && process.platform !== 'darwin') liveReason = 'the TextEdit leg is macOS only'
if (liveReason === '' && spawnSync('pgrep', ['-x', 'TextEdit'], { encoding: 'utf8' }).status === 0) liveReason = 'TextEdit is already running — the operator\'s own windows are never driven'
if (liveReason !== '') {
  warn(`live leg skipped: ${liveReason}`)
  finish(`live leg skipped: ${liveReason}`)
}
const native = await import('../../src/services/desktop/nativeDriver.js')
const resolved = native.resolveNativeDesktopDriver()
if (resolved.state !== 'ok') {
  warn(`live leg skipped: ${resolved.note}`)
  finish('live leg skipped: no native driver')
}
const driver = resolved.driver
const permissions = await driver.permissions()
if (!permissions.ok || permissions.value.session !== 'desktop' || !['granted', 'not-required'].includes(permissions.value.screenCapture) || !['granted', 'not-required'].includes(permissions.value.input)) {
  const why = permissions.ok ? `session ${permissions.value.session}, screen ${permissions.value.screenCapture}, input ${permissions.value.input}` : permissions.error.note
  warn(`live leg skipped: ${why}`)
  finish(`live leg skipped: ${why}`)
}
console.log(`  · driver ${JSON.stringify(driver.describe())}`)
const signal = new AbortController().signal
const frontmost = async (): Promise<{ identity: string; windowId: string | null } | null> => {
  const front = await driver.frontmostApplication()
  return front.ok ? { identity: front.value.identity, windowId: front.value.windowId ?? null } : null
}
const windowCount = (): number | null => {
  const res = spawnSync('osascript', ['-e', 'tell application "TextEdit" to count windows'], { encoding: 'utf8', timeout: 5000 })
  const n = Number((res.stdout ?? '').trim())
  return res.status === 0 && Number.isInteger(n) ? n : null
}
const restoreTo = (await frontmost())?.identity ?? null
const empty = join(SCRATCH, 'chord-empty.txt')
writeFileSync(empty, '')
spawnSync('open', ['-a', 'TextEdit', empty], { encoding: 'utf8', timeout: 10_000 })
let front: { identity: string; windowId: string | null } | null = null
for (let i = 0; i < 20; i++) {
  front = await frontmost()
  if (front?.identity === TEXTEDIT) break
  await sleep(250)
}
try {
  const countBefore = front?.identity === TEXTEDIT ? windowCount() : null
  if (front?.identity === TEXTEDIT) front = await frontmost()
  if (front?.identity !== TEXTEDIT) {
    warn(`TextEdit did not stay in front (front: ${front?.identity ?? 'unknown'}) — the desktop belongs to the operator; the live leg is skipped`)
  } else {
    const windowBefore = front.windowId
    console.log(`  · TextEdit in front · focused window ${windowBefore ?? 'unread'} · ${countBefore ?? '?'} window(s)`)
    const tapped = await driver.keyTap('n', ['super'], signal)
    check('keyTap(n, [super]) answers a receipt', tapped.ok && tapped.value.act === 'keyTap', tapped.ok ? '' : tapped.error.note)
    let landed = false
    let seen = ''
    for (let i = 0; i < 12 && !landed; i++) {
      await sleep(250)
      const now = await frontmost()
      const count = windowCount()
      seen = `front ${now?.identity ?? 'unknown'} · focused window ${now?.windowId ?? 'unread'} · ${count ?? '?'} window(s)`
      if (now?.identity !== TEXTEDIT) continue
      if (now.windowId !== null && windowBefore !== null && now.windowId !== windowBefore) landed = true
      if (count !== null && countBefore !== null && count > countBefore) landed = true
    }
    check('cmd+n through the driver opens a new TextEdit window within 3 s — the chord reached the application as its own shortcut', landed, `after the chord: ${seen}; before: focused window ${windowBefore ?? 'unread'} · ${countBefore ?? '?'} window(s)`)
    console.log(`  · ${seen}`)
  }
} finally {
  spawnSync('osascript', ['-e', 'tell application "TextEdit" to close every window saving no', '-e', 'tell application "TextEdit" to quit'], { encoding: 'utf8', timeout: 15_000 })
  if (restoreTo !== null && restoreTo !== TEXTEDIT) spawnSync('open', ['-b', restoreTo], { encoding: 'utf8', timeout: 10_000 })
}
finish('live')
