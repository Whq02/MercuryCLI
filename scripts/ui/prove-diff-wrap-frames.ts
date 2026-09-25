#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

process.env.FORCE_COLOR = '3'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
let highlightingOff = false
const settingsModule = await import('../../src/hooks/useSettings.js')
mock.module('../../src/hooks/useSettings.js', () => ({
  ...settingsModule,
  useSettings: () => ({ syntaxHighlightingDisabled: highlightingOff }),
  useSettingsMaybe: () => undefined,
}))

const { render, Box, flushPendingSyncWork } = await import('../../src/ink.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { FileEditToolUpdatedMessage } = await import('../../src/components/FileEditToolUpdatedMessage.js')
const { stringWidth } = await import('../../src/ink/stringWidth.js')
const { expandTabs } = await import('../../src/ink/tabstops.js')
const { railPlanAt, HELM_BOTH_RAILS_MIN } = await import('../../src/utils/helmGeometry.js')
import type { StructuredPatchHunk } from '../../src/utils/diff.js'

let failures = 0
function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

const noteA = 'held on the tree, uncommitted, pending the ruling; the options are listed on the shared page beside the second commit, and the census is generated after the merge so the report and the frames can be filed beside the receipts page for the owner to read at leisure'
const header = 'name\tid\tstage\tpath\tnote'
const removedShort = 'lantern\tp3\tstage one\t/srv/work/lantern\theld'
const contextLong = 'meadow\tm2\tstage three\t/srv/work/meadow\tmerged with the follow-up note that the report and the frames are filed beside the receipts page and the census is generated after the merge, then the summary is read by the owner before the next batch opens on the main line'
const removedLong = `harbour\tq7\tstage two\t/srv/work/harbour\t${noteA} (held)`
const addedLong = `harbour\tq7\tstage two\t/srv/work/harbour\t${noteA} (folded)`
const addedShort = 'lantern\tp3\tstage one\t/srv/work/lantern\tfolded'
const tail = 'tail\tx\ty\tz\tw'
const hunk: StructuredPatchHunk = {
  oldStart: 1,
  oldLines: 5,
  newStart: 1,
  newLines: 5,
  lines: [` ${header}`, `-${removedShort}`, ` ${contextLong}`, `-${removedLong}`, `+${addedLong}`, `+${addedShort}`, ` ${tail}`],
}
const digits = String(Math.max(hunk.oldStart + hunk.oldLines - 1, hunk.newStart + hunk.newLines - 1)).length

type Cell = { ch: string; bg: string | null }
function cellsOf(raw: string): Cell[] {
  const cells: Cell[] = []
  let bg: string | null = null
  const pattern = /\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g
  let last = 0
  const text = (chunk: string): void => {
    for (const ch of chunk) {
      const width = stringWidth(ch)
      if (width === 0) continue
      cells.push({ ch, bg })
      if (width === 2) cells.push({ ch: '', bg })
    }
  }
  for (let match = pattern.exec(raw); match !== null; match = pattern.exec(raw)) {
    text(raw.slice(last, match.index))
    last = match.index + match[0].length
    if (match[1] === undefined) continue
    const params = match[1] === '' ? ['0'] : match[1].split(';')
    for (let i = 0; i < params.length; i++) {
      const code = params[i]!
      if (code === '0' || code === '49') bg = null
      else if (code === '48') {
        const kind = params[i + 1]
        if (kind === '5') {
          bg = params.slice(i, i + 3).join(';')
          i += 2
        } else if (kind === '2') {
          bg = params.slice(i, i + 5).join(';')
          i += 4
        }
      } else if (/^(4[0-7]|10[0-7])$/.test(code)) bg = code
      else if (code === '38') {
        const kind = params[i + 1]
        i += kind === '5' ? 2 : kind === '2' ? 4 : 0
      }
    }
  }
  text(raw.slice(last))
  return cells
}

async function mount(columns: number, rows: number): Promise<{ raw: string[]; plain: string[]; transcript: number }> {
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
  const transcript = railPlanAt(columns, columns >= HELM_BOTH_RAILS_MIN).centerCols - 2
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const node = React.createElement(TerminalSizeContext.Provider, { value: { columns: transcript, rows } },
    React.createElement(Box, { flexDirection: 'column', width: columns },
      React.createElement(FileEditToolUpdatedMessage, { filePath: '/srv/work/jobs.tsv', structuredPatch: [hunk], firstLine: header, verbose: false })))
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  const frame = instance.lastFrame().replace(/\n$/, '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return { raw: frame.split('\n'), plain: stripAnsi(frame).split('\n'), transcript }
}

const squash = (text: string): string => text.replace(/\s+/g, '')
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })

for (const road of ['highlighted', 'plain'] as const) {
  highlightingOff = road === 'plain'
  const gutterCells = road === 'plain' ? digits + 2 : digits + 3
  for (const [columns, rows] of [[178, 51], [220, 51]] as const) {
    const label = `${road} ${columns}x${rows}`
    const { raw, plain, transcript } = await mount(columns, rows)
    const innerWidth = transcript - 14
    if (frameDir) {
      const name = `${columns}x${rows}${road === 'plain' ? '-plain' : ''}`
      writeFileSync(join(frameDir, `${name}.txt`), plain.join('\n') + '\n')
      writeFileSync(join(frameDir, `${name}.ansi`), raw.join('\n') + '\n')
    }
    console.log(`\n${label} (transcript ${transcript} columns, diff inner width ${innerWidth}):`)
    for (const line of plain) console.log(line)
    console.log('')
    const top = plain.findIndex(line => line.includes('┌'))
    const x0 = top < 0 ? -1 : plain[top]!.indexOf('┌')
    const x1 = top < 0 ? -1 : plain[top]!.indexOf('┐')
    const bottom = top < 0 ? -1 : plain.findIndex((line, index) => index > top && line[x0] === '└')
    check(`${label}: the diff box paints with a top and a bottom edge`, top >= 0 && x1 > x0 && bottom > top, `top=${top} x0=${x0} x1=${x1} bottom=${bottom}`)
    if (top < 0 || x1 <= x0 || bottom <= top) continue
    const expectedBox = road === 'plain' ? innerWidth + 1 : innerWidth + 2
    check(`${label}: the box is exactly the inner width plus its two borders${road === 'plain' ? ' less the plain road\'s one spare cell' : ''}`, x1 - x0 + 1 === expectedBox, `box ${x1 - x0 + 1} cells, expected ${expectedBox}`)
    check(`${label}: the box ends inside the screen`, x1 < columns, `right edge at ${x1}`)
    const edges: string[] = []
    const bleeds: string[] = []
    const bands: string[] = []
    const gaps: string[] = []
    const inner: string[] = []
    let bandedRows = 0
    for (let y = top + 1; y < bottom; y++) {
      const line = plain[y]!
      if (line[x0] !== '│' || line[x1] !== '│') edges.push(`row ${y}: edges read ${JSON.stringify(line[x0] ?? ' ')} at ${x0} and ${JSON.stringify(line[x1] ?? ' ')} at ${x1} — "${line.slice(Math.max(0, x1 - 24), x1 + 1)}"`)
      const after = line.slice(x1 + 1)
      if (after.trim() !== '') bleeds.push(`row ${y}: ${JSON.stringify(after.trim().slice(0, 24))} painted right of the border at ${x1 + 1}`)
      const cells = cellsOf(raw[y]!)
      const past = cells.slice(x1 + 1).filter(cell => cell.bg !== null).length
      const boxCells = cells.slice(x0 + 1, x1)
      const firstBand = boxCells.findIndex(cell => cell.bg !== null)
      const marked = /[-+]/.test(line.slice(x0 + 1, x0 + 1 + gutterCells))
      if (past > 0) bands.push(`row ${y}: the band continues ${past} cells past the border at ${x1}`)
      else if (firstBand >= 0 && boxCells[boxCells.length - 1]!.bg === null) bands.push(`row ${y}: the band stops ${boxCells.length - 1 - boxCells.map(cell => cell.bg !== null).lastIndexOf(true)} cells short of the border`)
      if (firstBand >= 0 && marked) {
        bandedRows++
        const holes = boxCells.slice(firstBand).filter(cell => cell.bg === null).length
        if (holes > 0) gaps.push(`row ${y}: ${holes} unpainted cells inside the band`)
      }
      inner.push(line.slice(x0 + 1 + gutterCells, x1))
    }
    check(`${label}: every row inside the box keeps both border glyphs`, edges.length === 0, edges.slice(0, 3).join(' · '))
    check(`${label}: nothing is painted right of the box`, bleeds.length === 0, bleeds.slice(0, 3).join(' · '))
    check(`${label}: every red or green band ends exactly at the border`, bands.length === 0, bands.slice(0, 3).join(' · '))
    check(`${label}: the removed and added rows carry an unbroken band`, bandedRows >= 4 && gaps.length === 0, gaps.length ? gaps.slice(0, 3).join(' · ') : `${bandedRows} banded rows`)
    check(`${label}: no row is wider than the screen`, plain.every(line => stringWidth(line) <= columns), String(Math.max(...plain.map(line => stringWidth(line)))))
    const innerText = squash(inner.join(''))
    for (const [name, text] of [['the over-long removed line', removedLong], ['the over-long added line', addedLong], ['the long context line', contextLong], ['the short removed line', removedShort], ['the short added line', addedShort]] as const) {
      const expanded = expandTabs(text)
      check(`${label}: ${name} wraps inside the box with every character kept`, innerText.includes(squash(expanded)), `${expanded.slice(0, 40)}…`)
    }
    const headerRow = plain[top + 1]!
    const headerCells = cellsOf(raw[top + 1]!)
    check(`${label}: the header line above the removed block paints neutral with no marker`, headerRow.includes('name') && headerCells.slice(x0 + 1, x1).every(cell => cell.bg === null) && !headerRow.slice(x0 + 1, x0 + 1 + gutterCells).includes('-'), headerRow.slice(x0, x0 + gutterCells + 12))
    check(`${label}: the header columns sit at the line's own tab stops`, headerRow.slice(x0 + 1 + gutterCells, x1).startsWith(expandTabs(header)), JSON.stringify(headerRow.slice(x0 + 1 + gutterCells, x0 + 1 + gutterCells + 40)))
    const contextRow = plain.findIndex((line, index) => index > top && index < bottom && line.includes('meadow'))
    const contextCells = contextRow < 0 ? [] : cellsOf(raw[contextRow]!)
    check(`${label}: the context line inside the removed block carries no removed band and no marker`, contextRow > 0 && contextCells.slice(x0 + 1, x1).every(cell => cell.bg === null) && !plain[contextRow]!.slice(x0 + 1, x0 + 1 + gutterCells).includes('-'), contextRow < 0 ? 'no context row' : plain[contextRow]!.slice(x0, x0 + gutterCells + 12))
  }
}

console.log(`\ndiff wrap frames: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
