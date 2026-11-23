#!/usr/bin/env bun
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const J = (...parts: string[]): string => parts.join('')

const NEEDLES: Array<[string, RegExp]> = [
  ['a terminal multiplexer named where no real session is meant', new RegExp(J('\\b', 'tm', 'ux\\b'), 'i')],
  ['the retired member word', new RegExp(J('(?<!/)\\b', 'team', 'mates?\\b'), 'i')],
  ['the retired capitalised group word', new RegExp(J('\\b', 'Team', 's?\\b'))],
  ['the retired seat-estate word', new RegExp(J('(?<!(?:third|first)[- ])\\b', 'party', '\\b'), 'i')],
]

const ROW_ALLOW: Array<[string, string]> = [
  ['clamped for tmux', 'the colour clamp names the real terminal the session runs inside'],
  ['terminal-overrides', "the same row's remedy for that real terminal"],
]


console.log('— §1c the words the health rows print —')
{
  const globals = globalThis as Record<string, unknown>
  if (globals.MACRO === undefined) globals.MACRO = { VERSION: '1.0.0' }
  const { runHealthReport } = await import('../../src/platform/health/healthReport.ts')
  const cert = await runHealthReport({ depth: 'fast' })
  const fsV = await import('node:fs')
  const osV = await import('node:os')
  const places = [process.cwd(), osV.homedir(), osV.tmpdir(), process.env.MERCURY_CONFIG_DIR ?? '', cert.head.branch ?? ''].filter(place => place.length > 1)
  const real = places.flatMap(place => {
    try {
      return [fsV.realpathSync(place)]
    } catch {
      return []
    }
  })
  const machine = [...new Set([...places, ...real])].sort((a, b) => b.length - a.length)
  const needles = NEEDLES.filter(([, re]) => !(process.env.TMUX !== undefined && re.test('tmux')))
  const said = cert.sections.flatMap(entry => entry.checks.flatMap(row => [row.label, row.evidence, row.fix ?? ''].map(text => ({ id: row.id, text: machine.reduce((rest, place) => rest.split(place).join('…'), text) }))))
  const retired = said.flatMap(piece => needles.filter(([, re]) => re.test(piece.text) && !ROW_ALLOW.some(([fragment]) => piece.text.includes(fragment))).map(([needle]) => `${piece.id} [${needle}] ${piece.text.slice(0, 100)}`))
  check(`the rows of a fast certificate print no retired word in a label, an evidence line or a fix (${said.length} strings; this machine's folders and branch aside, and the multiplexer's name aside inside a real session of it)`, said.length > 0 && retired.length === 0, `${retired.join(' | ')} — reword the label, evidence or fix of each listed row id; runHealthReport in src/platform/health/healthReport.ts assembles the rows`)
}


console.log(failures === 0 ? '\nprove-crew-vocabulary: ALL LAWS HOLD' : `\nprove-crew-vocabulary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
