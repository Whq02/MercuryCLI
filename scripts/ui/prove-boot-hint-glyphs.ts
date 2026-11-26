#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paintsBootFaceReady } from '../lib/bootFace.ts'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'boot-hint-glyphs-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
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

console.log(failures === 0 ? '\nboot-hint-glyphs: GREEN' : `\nboot-hint-glyphs: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
