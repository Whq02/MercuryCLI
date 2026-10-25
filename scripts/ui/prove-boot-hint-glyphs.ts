#!/usr/bin/env bun
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'boot-hint-glyphs-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

const PLAIN = new Set(['·', '↵', '↑', '↓', '←', '→'])
const beyondAscii = (text: string): string[] => Array.from(text).filter(ch => ch.charCodeAt(0) > 0x7e)
const notPlain = (text: string): string[] => beyondAscii(text).filter(ch => !PLAIN.has(ch))
const hex = (chars: string[]): string => chars.map(ch => `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')

const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
const { keyHintLabel, MAC_MODIFIER_GLYPHS } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
const { stripKeyMapHintOf } = await import('../../src/context/surfaceRoute.ts')
const { decideWin32ConsoleUtf8, UTF8_CODEPAGE } = await import('../../src/utils/runtime/win32Console.ts')

console.log('§1 the face’s own hint keys, read from the face')
const face = read('src/components/BootSplashScreen.tsx')
const keys = Array.from(face.matchAll(/\{\s*key: '([^']*)', label:/g), m => m[1]!)
const tiny = Array.from(face.matchAll(/tinyHint: '([^']*)'/g), m => m[1]!)
check('the face declares its hint keys and the tiny hint', keys.length >= 3 && tiny.length === 1, `${keys.length} keys, ${tiny.length} tiny`)
check(`every key is plain — ${JSON.stringify([...new Set(keys)])}`, keys.every(k => notPlain(k).length === 0), hex(keys.flatMap(notPlain)))
check(`the tiny hint is plain — ${JSON.stringify(tiny)}`, tiny.every(t => notPlain(t).length === 0), hex(tiny.flatMap(notPlain)))

console.log('§2 the composed ready line, both faces, through the splash core')
{
  const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' }) as {
    composeLockup: (...a: unknown[]) => { lines: string[] }
    composeCompactFace: (...a: unknown[]) => { lines: string[] }
  }
  const plainSegments = [
    { key: '↵ ', label: 'start', tone: 'ivory' },
    { key: 'm', label: ' menu', tone: 'faint' },
  ]
  const compactSegments = [plainSegments[0], { key: '↑↓', label: ' choose', tone: 'faint' }, plainSegments[1]]
  const cardRows = [
    { icon: '▸', label: 'New Session', ctx: 'fresh chat in this repo' },
    { icon: '↻', label: 'Continue Last Session', ctx: '5m ago' },
  ]
  const keyMap = keyHintLabel(stripKeyMapHintOf('boot-settings', ['boot-settings', 'concourse']), 'windows')
  const plain = core.composeLockup(100, 30, { cardRows, cardSel: 0, hintSegments: plainSegments, tinyHint: '↵ start', stripLines: () => [], keyMap }).lines.map(strip)
  const compact = core.composeCompactFace(80, 24, { cardRows: cardRows.map(r => ({ label: r.label, ctx: r.ctx })), cardSel: 0, hintSegments: compactSegments, keyMap }).lines.map(strip)
  const hintRows = (lines: string[]): string[] => lines.filter(l => l.includes('↵ start') || l.includes('↑↓ choose'))
  check(`the plain face paints one hint row — "${hintRows(plain)[0]?.trim()}"`, hintRows(plain).length === 1 && hintRows(plain)[0]!.includes('ready'), plain.join('\n'))
  check(`the compact face paints one hint row — "${hintRows(compact)[0]?.trim()}"`, hintRows(compact).length === 1, compact.join('\n'))
  const rows = [...hintRows(plain), ...hintRows(compact)].map(r => r.replace(/^\s*│|│\s*$/g, ''))
  check('the hint rows carry nothing beyond ASCII, the middle dot and the arrows', rows.length === 2 && rows.every(r => notPlain(r).length === 0), hex(rows.flatMap(notPlain)))
}

console.log('§3 the key-map row off-mac: words for the modifiers, arrows kept')
{
  const mac = stripKeyMapHintOf('boot-settings', ['boot-settings', 'concourse', 'repl'])
  const win = keyHintLabel(mac, 'windows')
  const linux = keyHintLabel(mac, 'linux')
  check(`the Windows key-map row is "${win}"`, win.includes('shift+→') && !MAC_MODIFIER_GLYPHS.some(g => win.includes(g)))
  check('the Linux row folds the same way', linux === win)
  check('nothing beyond ASCII, the middle dot and the arrows remains', notPlain(win).length === 0, hex(notPlain(win)))
}

console.log('§4 the allowed set is Latin-1 and the Arrows block, and the win32 console reads UTF-8')
{
  const inBlocks = [...PLAIN].every(ch => { const cp = ch.codePointAt(0)!; return cp === 0xb7 || (cp >= 0x2190 && cp <= 0x21ff) })
  check('the plain set is the middle dot plus Arrows-block characters', inBlocks)
  const decision = decideWin32ConsoleUtf8('win32', true, {})
  check(`a win32 TTY boot switches the console to code page ${UTF8_CODEPAGE}`, decision.engage && UTF8_CODEPAGE === 65001)
}

console.log(failures === 0 ? '\nboot-hint-glyphs: GREEN' : `\nboot-hint-glyphs: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
