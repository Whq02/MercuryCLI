#!/usr/bin/env bun
// gate-watch: src/components/HighlightedCode.tsx src/components/HighlightedCode/Fallback.tsx src/ink/components/NoSelect.tsx
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'

pinSourceRef()
const HOME = pinScratchHome('code-gutter-holds')
delete process.env.MERCURY_HOME
Object.assign(process.env, { MERCURY_FULLSCREEN: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_REDUCED_MOTION: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none', BROWSER: '/usr/bin/true' })
delete process.env.NODE_ENV

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const h = React.createElement
const { Box } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { HighlightedCode } = await import('../../src/components/HighlightedCode.tsx')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const WORD = 'word'
const lineOf = (n: number, cells: number): string => {
  const head = `L${n}`
  const body = Array.from({ length: Math.ceil(cells / (WORD.length + 1)) }, () => WORD).join(' ')
  return `${head} ${body}`.slice(0, cells)
}
type Scene = { name: string; width: number; lines: string[] }
const SCENES: Scene[] = [
  { name: 'five lines, one of them wrapping to two rows', width: 60, lines: [lineOf(1, 20), lineOf(2, 90), lineOf(3, 20), lineOf(4, 30), lineOf(5, 12)] },
  { name: 'five lines, one of them four hundred cells long', width: 60, lines: [lineOf(1, 20), lineOf(2, 400), lineOf(3, 20), lineOf(4, 56), lineOf(5, 12)] },
  { name: 'twelve lines under a two-digit gutter, three of them long', width: 72, lines: Array.from({ length: 12 }, (_, i) => lineOf(i + 1, i % 4 === 1 ? 200 : 24)) },
  { name: 'every line longer than the box', width: 48, lines: Array.from({ length: 4 }, (_, i) => lineOf(i + 1, 130)) },
]

for (const scene of SCENES) {
  console.log(`\n${scene.name} (a box of ${scene.width} cells)`)
  const digits = String(scene.lines.length).length
  const gutter = digits + 2
  const element = h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Box, { width: scene.width, flexDirection: 'column' }, h(HighlightedCode, { code: scene.lines.join('\n'), filePath: 'note.txt' })))
  const mounted = await mountOffscreen(element, 100, 60)
  try {
    await settledFrame(mounted, frame => frame.includes(`L${scene.lines.length} `))
    const rows = mounted.lines().filter(row => row.trim() !== '')
    const heads = scene.lines.map((_, i) => rows.findIndex(row => new RegExp(`^ *${i + 1} +L${i + 1} `).test(row)))
    check('every line paints its number and its first word on one row', heads.every(at => at >= 0), JSON.stringify(heads))
    const starts = scene.lines.map((_, i) => (heads[i]! < 0 ? -1 : rows[heads[i]!]!.indexOf(`L${i + 1} `)))
    check(`the code starts in column ${gutter} on every line: the number, right-aligned in ${digits}, then two spaces`, starts.every(at => at === gutter), `${JSON.stringify(starts)}\n${rows.slice(0, 8).join('\n')}`)
    const numbered = scene.lines.map((_, i) => (heads[i]! < 0 ? '' : rows[heads[i]!]!.slice(0, gutter)))
    check('the gutter reads the same on a line that wraps and on one that does not', numbered.every((cell, i) => cell === `${String(i + 1).padStart(digits)}  `), JSON.stringify(numbered))
    const continued = rows.filter((_, at) => !heads.includes(at))
    check('a wrapped line continues under its own first word, never under the gutter', continued.length > 0 && continued.every(row => row.length - row.trimStart().length === gutter), JSON.stringify(continued.slice(0, 4).map(row => row.slice(0, 16))))
    check(`no row runs past the box's ${scene.width} cells`, rows.every(row => Array.from(row).length <= scene.width), String(Math.max(...rows.map(row => Array.from(row).length))))
    const wordsWritten = scene.lines.reduce((sum, line) => sum + line.split(' ').filter(word => word === WORD).length, 0)
    const wordsPainted = rows.join(' ').split(' ').filter(word => word === WORD).length
    check('every word of every line is on the frame', wordsPainted === wordsWritten, `${wordsPainted} of ${wordsWritten}`)
  } finally {
    mounted.unmount()
  }
}

console.log(`\ncode-gutter-holds: ${checks} checks, ${failures} failed`)
await releaseScratchHome(HOME)
process.exit(failures === 0 ? 0 : 1)
