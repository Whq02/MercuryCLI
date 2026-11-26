#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { paintsBootFaceReady } from '../lib/bootFace.ts'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'boot-hint-glyphs-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

const PLAIN = new Set(['·', '↵', '↑', '↓', '←', '→'])
const beyondAscii = (text: string): string[] => Array.from(text).filter(ch => ch.charCodeAt(0) > 0x7e)
const notPlain = (text: string): string[] => beyondAscii(text).filter(ch => !PLAIN.has(ch))
const hex = (chars: string[]): string => chars.map(ch => `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')

const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
const { keyHintLabel, MAC_MODIFIER_GLYPHS } = await import('../../src/screen/widgets/keyHintLabel.ts')
const { stripKeyMapHintOf } = await import('../../src/screen/routes/surfaceRoute.ts')
const { decideWin32ConsoleUtf8, UTF8_CODEPAGE } = await import('../../src/platform/node-runtime/win32Console.ts')


console.log('§2 the composed ready line, both faces, through the splash core')
{
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' }) as {
    composeLockup: (...a: unknown[]) => { lines: string[] }
    composeCompactFace: (...a: unknown[]) => { lines: string[] }
  }
  const plainSegments = [
    { key: '↵', label: '', tone: 'ivory' },
    { key: 'm', label: ' menu', tone: 'faint' },
  ]
  const compactSegments = [
    { key: '>_', label: '', tone: 'faint' },
    plainSegments[0],
    { key: '↑↓', label: '', tone: 'faint' },
    plainSegments[1],
  ]
  const cardRows = [
    { label: 'New Session', ctx: '' },
    { label: 'Continue Last Session', ctx: '' },
  ]
  const keyMap = keyHintLabel(stripKeyMapHintOf('boot-settings', ['boot-settings', 'concourse']), 'windows')
  const plain = core.composeLockup(100, 30, { cardRows, cardSel: 0, hintSegments: plainSegments, tinyHint: '↵', stripLines: () => [], keyMap }).lines.map(strip)
  const compact = core.composeCompactFace(80, 24, { cardRows: cardRows.map(r => ({ label: r.label, ctx: r.ctx })), cardSel: 0, hintSegments: compactSegments, keyMap }).lines.map(strip)
  const hintRows = (lines: string[]): string[] => lines.filter(l => paintsBootFaceReady(l))
  check(`the plain face paints one hint row — "${hintRows(plain)[0]?.trim()}"`, hintRows(plain).length === 1 && hintRows(plain)[0]!.includes('>_'), `${plain.join('\n')}\nchange composeLockup's ready-hint row in assets/splash/splash-core.mjs so the plain face paints exactly one row with '>_' and the ready line`)
  check(`the compact face paints one hint row — "${hintRows(compact)[0]?.trim()}"`, hintRows(compact).length === 1, `${compact.join('\n')}\nchange composeCompactFace's ready-hint row in assets/splash/splash-core.mjs so the compact face paints exactly one ready line`)
  const rows = [...hintRows(plain), ...hintRows(compact)].map(r => r.replace(/^\s*│|│\s*$/g, ''))
  check('the hint rows carry nothing beyond ASCII, the middle dot and the arrows', rows.length === 2 && rows.every(r => notPlain(r).length === 0), `${hex(rows.flatMap(notPlain))} — replace these glyphs in the hint segments painted by assets/splash/splash-core.mjs with ASCII, the middle dot or an arrow (expected 2 hint rows, got ${rows.length})`)
}

console.log('§3 the key-map row off-mac: words for the modifiers, arrows kept')
{
  const mac = stripKeyMapHintOf('boot-settings', ['boot-settings', 'concourse', 'repl'])
  const win = keyHintLabel(mac, 'windows')
  const linux = keyHintLabel(mac, 'linux')
  check(`the Windows key-map row is "${win}"`, win.includes('shift+→') && !MAC_MODIFIER_GLYPHS.some(g => win.includes(g)), `got "${win}" — keyHintLabel in src/screen/widgets/keyHintLabel.ts must turn the Mac modifier glyphs into words (shift+) off-mac and keep the arrows`)
  check('the Linux row folds the same way', linux === win, `linux "${linux}" vs windows "${win}" — keyHintLabel in src/screen/widgets/keyHintLabel.ts must give the same row on both non-mac platforms`)
  check('nothing beyond ASCII, the middle dot and the arrows remains', notPlain(win).length === 0, `${hex(notPlain(win))} — keyHintLabel in src/screen/widgets/keyHintLabel.ts (or stripKeyMapHintOf in src/screen/routes/surfaceRoute.ts) must not emit glyphs beyond ASCII, the middle dot and the arrows`)
}

console.log('§4 the allowed set is Latin-1 and the Arrows block, and the win32 console reads UTF-8')
{
  const inBlocks = [...PLAIN].every(ch => { const cp = ch.codePointAt(0)!; return cp === 0xb7 || (cp >= 0x2190 && cp <= 0x21ff) })
  check('the plain set is the middle dot plus Arrows-block characters', inBlocks, 'PLAIN at the top of this script may only hold U+00B7 and characters in U+2190-U+21FF; the boot hint glyph set is meant to stay that small')
  const decision = decideWin32ConsoleUtf8('win32', true, {})
  check(`a win32 TTY boot switches the console to code page ${UTF8_CODEPAGE}`, decision.engage && UTF8_CODEPAGE === 65001, `engage=${decision.engage} codepage=${UTF8_CODEPAGE} — decideWin32ConsoleUtf8 and UTF8_CODEPAGE in src/platform/node-runtime/win32Console.ts must engage code page 65001 for a win32 TTY`)
}

console.log('§5 mounted Boot face at 120×40 and 80×24 compact (3-token and 4-token): glyphs hold their columns with no middle dot')
{
  const React = await import('react')
  const h = React.createElement
  const { default: ScreenInstance } = await import('../../src/screen/renderer/screenInstance.tsx')
  const { App } = await import('../../src/boot/App.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.tsx')
  const { BootSplashScreen } = await import('../../src/screen/boot-face/BootSplashScreen.tsx')
  const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/platform/settings/config.ts')
  const { updateSettingsForSource } = await import('../../src/platform/settings/settings.ts')
  const { default: instances } = await import('../../src/screen/renderer/instances.ts')
  enableConfigs()
  saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
  saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
  const arg = (name: string): string | undefined => {
    const idx = process.argv.indexOf(name)
    return idx < 0 ? undefined : process.argv[idx + 1]
  }
  const frameDir = arg('--frames')
  if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
  class Out extends EventEmitter {
    isTTY = true
    constructor(public columns: number, public rows: number) { super() }
    write(): boolean { return true }
  }
  class In extends EventEmitter {
    isTTY = true
    isRaw = false
    setEncoding(): this { return this }
    setRawMode(value: boolean): this { this.isRaw = value; return this }
    ref(): this { return this }
    unref(): this { return this }
    read(): null { return null }
    get readableLength(): number { return 0 }
  }
  const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))
  async function captureFace(cols: number, rows: number, sessionDefaults: boolean, tag: string): Promise<string[]> {
    updateSettingsForSource('userSettings', { engine: { sessionDefaults } })
    const stdout = new Out(cols, rows)
    const stdin = new In()
    const ink = new ScreenInstance({ stdout: stdout as never, stdin: stdin as never, stderr: new Out(cols, rows) as never, exitOnCtrlC: false, patchConsole: false })
    instances.set(stdout as never, ink)
    ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, h(BootSplashScreen))))
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const text = stripAnsi(ink.lastFrameText())
      if (text.includes('>_') && text.includes('↵') && text.includes('↑↓')) break
      await sleep(20)
    }
    await sleep(150)
    const lines = stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${tag}.txt`), `${lines.join('\n')}\n`)
    ink.unmount()
    await ink.waitUntilExit()
    instances.delete(stdout as never)
    return lines
  }
  const colOf = (line: string, token: string): number => {
    const idx = line.indexOf(token)
    return idx < 0 ? -1 : Array.from(line.slice(0, idx)).length
  }
  const face120 = await captureFace(120, 40, true, 'boot-120x40-3tok')
  const row120 = face120.find(l => l.includes('>_') && l.includes('↵') && l.includes('↑↓')) ?? ''
  check(
    '120×40 (3-token): glyphs stay at columns 52 / 59 / 65 with no middle dot',
    row120 !== '' && !row120.includes('·') && colOf(row120, '>_') === 52 && colOf(row120, '↵') === 59 && colOf(row120, '↑↓') === 65,
    `row=${JSON.stringify(row120)} cols=${colOf(row120, '>_')}/${colOf(row120, '↵')}/${colOf(row120, '↑↓')} — remove the middle-dot separator in composeHint in assets/splash/splash-core.mjs while keeping each glyph's column`,
  )
  const face120Menu = await captureFace(120, 40, false, 'boot-120x40-4tok')
  const row120Menu = face120Menu.find(l => l.includes('>_') && l.includes('↵') && l.includes('↑↓')) ?? ''
  check(
    '120×40 (4-token, m menu): glyphs stay at columns 46 / 53 / 59 / 70 with no middle dot',
    row120Menu !== '' && !row120Menu.includes('·') && colOf(row120Menu, '>_') === 46 && colOf(row120Menu, '↵') === 53 && colOf(row120Menu, 'm menu') === 59 && colOf(row120Menu, '↑↓') === 70,
    `row=${JSON.stringify(row120Menu)} cols=${colOf(row120Menu, '>_')}/${colOf(row120Menu, '↵')}/${colOf(row120Menu, 'm menu')}/${colOf(row120Menu, '↑↓')} — remove every middle-dot separator in composeHint in assets/splash/splash-core.mjs`,
  )
  const face80 = await captureFace(80, 24, true, 'boot-80x24-3tok')
  const row80 = face80.find(l => l.includes('>_') && l.includes('↵') && l.includes('↑↓')) ?? ''
  const border80 = colOf(row80, '│')
  check(
    '80×24 compact (3-token): glyphs stay at border offsets +2 / +7 / +11 with no middle dot',
    border80 >= 0 && !row80.includes('·') && colOf(row80, '>_') - border80 === 2 && colOf(row80, '↵') - border80 === 7 && colOf(row80, '↑↓') - border80 === 11,
    `row=${JSON.stringify(row80)} offsets=${colOf(row80, '>_') - border80}/${colOf(row80, '↵') - border80}/${colOf(row80, '↑↓') - border80} — remove the middle-dot separator in composeCompactFace in assets/splash/splash-core.mjs`,
  )
  const face80Menu = await captureFace(80, 24, false, 'boot-80x24-4tok')
  const row80Menu = face80Menu.find(l => l.includes('>_') && l.includes('↵') && l.includes('↑↓')) ?? ''
  const border80Menu = colOf(row80Menu, '│')
  check(
    '80×24 compact (4-token, m menu): glyphs stay at border offsets +2 / +7 / +11 / +16 with no middle dot',
    border80Menu >= 0 && !row80Menu.includes('·') && colOf(row80Menu, '>_') - border80Menu === 2 && colOf(row80Menu, '↵') - border80Menu === 7 && colOf(row80Menu, '↑↓') - border80Menu === 11 && colOf(row80Menu, 'm menu') - border80Menu === 16,
    `row=${JSON.stringify(row80Menu)} offsets=${colOf(row80Menu, '>_') - border80Menu}/${colOf(row80Menu, '↵') - border80Menu}/${colOf(row80Menu, '↑↓') - border80Menu}/${colOf(row80Menu, 'm menu') - border80Menu} — remove every middle-dot separator in composeCompactFace in assets/splash/splash-core.mjs`,
  )
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nboot-hint-glyphs: GREEN' : `\nboot-hint-glyphs: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
