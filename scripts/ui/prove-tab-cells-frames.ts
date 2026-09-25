#!/usr/bin/env bun
import React from 'react'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

process.env.FORCE_COLOR = '3'
process.env.MERCURY_FULLSCREEN = '1'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', ISSUES_EXPLAINER: '', PACKAGE_URL: '', README_URL: '', IS_DEV: false, MERCURY_DEMO: false }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()

const { render, Box, Text, RawAnsi, flushPendingSyncWork } = await import('../../src/ink.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { useTheme } = await import('../../src/components/design-system/ThemeProvider.js')
const { HighlightedCode } = await import('../../src/components/HighlightedCode.js')
const { PermissionDialog } = await import('../../src/components/permissions/PermissionDialog.js')
const { PermissionPrompt } = await import('../../src/components/permissions/PermissionPrompt.js')
const { ConsentFileEditDiff } = await import('../../src/components/permissions/ConsentFileEditDiff.js')
const { consentBodyBudget, consentContentWidth, diffPaintWidth } = await import('../../src/components/permissions/consentBodyBudget.js')
const { expectColorFile } = await import('../../src/components/StructuredDiff/colorDiff.js')
const { stringWidth } = await import('../../src/ink/stringWidth.js')
const { expandTabs } = await import('../../src/ink/tabstops.js')
const { railPlanAt, HELM_BOTH_RAILS_MIN } = await import('../../src/utils/helmGeometry.js')

let failures = 0
let checks = 0
function check(label: string, pass: boolean, detail = ''): void {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}${!pass && detail ? ` — ${detail}` : ''}`)
}
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const squash = (text: string): string => text.replace(/\s+/g, '')
const frameDir = arg('--frames')
if (frameDir) mkdirSync(frameDir, { recursive: true })
const file = (name: string, plain: string[], raw?: string[]): void => {
  if (!frameDir) return
  writeFileSync(join(frameDir, `${name}.txt`), plain.join('\n') + '\n')
  if (raw) writeFileSync(join(frameDir, `${name}.ansi`), raw.join('\n') + '\n')
}
const show = (label: string, plain: string[]): void => {
  console.log(`\n${label}:`)
  for (const line of plain) console.log(line)
  console.log('')
}

const header = 'name\tid\tstage\tpath\tnote'
const noteA = 'held on the tree, uncommitted, pending the ruling; the options are listed on the shared page beside the second commit'
const noteB = `${noteA}, and the census follows the merge`
const names = ['lantern', 'harbour', 'cistern', 'granary', 'orchard', 'pasture', 'rampart', 'saltern', 'terrace', 'vantage', 'weather', 'zephyrs']
const row = (index: number, state: string): string => `${names[index]}\t${'pqrs'[index % 4]}${index + 1}\tstage ${index % 2 === 0 ? 'one' : 'two'}\t/srv/work/${names[index]}\t${index % 2 === 0 ? noteA : noteB} (${state})`
const held = names.map((_, index) => row(index, 'held'))
const folded = names.map((_, index) => row(index, 'folded'))
const source = [header, ...held].join('\n') + '\n'
const longLine = held[1]!

async function mount(columns: number, rows: number, size: { columns: number; rows: number }, body: React.ReactNode, ready: (plain: string) => boolean): Promise<{ raw: string[]; plain: string[] }> {
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const node = React.createElement(AppStateProvider, {
    initialState: getDefaultAppState(),
    children: React.createElement(TerminalSizeContext.Provider, { value: size },
      React.createElement(Box, { flexDirection: 'column', width: columns }, body)),
  })
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  const deadline = Date.now() + 8000
  let settled = 0
  while (Date.now() < deadline && settled < 8) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    if (ready(stripAnsi(instance.lastFrame()))) settled++
  }
  const frame = instance.lastFrame().replace(/\n$/, '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return { raw: frame.split('\n'), plain: stripAnsi(frame).split('\n') }
}

function FileRoad({ width }: { width: number }): React.ReactNode {
  const [themeName] = useTheme()
  const ColorFile = expectColorFile()
  const lines = ColorFile ? (new ColorFile(source, '/srv/work/jobs.tsv').render(themeName, width, false) ?? []) : []
  return React.createElement(RawAnsi, { lines, width })
}

type Edges = { top: number; bottom: number; x0: number; x1: number }
function boxEdges(plain: string[], corner: string, from = 0): Edges {
  const top = plain.findIndex((line, index) => index >= from && line.includes(corner))
  const x0 = top < 0 ? -1 : plain[top]!.indexOf(corner)
  const x1 = top < 0 ? -1 : plain[top]!.lastIndexOf(corner === '┌' ? '┐' : '╮')
  const bottom = top < 0 ? -1 : plain.findIndex((line, index) => index > top && (line[x0] === '└' || line[x0] === '╰'))
  return { top, bottom, x0, x1 }
}

function boxLaws(label: string, plain: string[], edges: Edges, columns: number, outerRight = columns): string[] {
  const { top, bottom, x0, x1 } = edges
  check(`${label}: the box paints with a top and a bottom edge`, top >= 0 && x1 > x0 && bottom > top, `top=${top} x0=${x0} x1=${x1} bottom=${bottom}`)
  if (top < 0 || x1 <= x0 || bottom <= top) return []
  const edgeFaults: string[] = []
  const bleeds: string[] = []
  const inner: string[] = []
  for (let y = top + 1; y < bottom; y++) {
    const line = plain[y]!
    if (line[x0] !== '│' || line[x1] !== '│') edgeFaults.push(`row ${y}: edges read ${JSON.stringify(line[x0] ?? ' ')} at ${x0} and ${JSON.stringify(line[x1] ?? ' ')} at ${x1} — "${line.slice(Math.max(0, x1 - 24), x1 + 1)}"`)
    const after = line.slice(x1 + 1, outerRight)
    if (after.trim() !== '') bleeds.push(`row ${y}: ${JSON.stringify(after.trim().slice(0, 24))} painted right of the border at ${x1 + 1}`)
    inner.push(line.slice(x0 + 1, x1))
  }
  check(`${label}: every row inside the box keeps both border glyphs`, edgeFaults.length === 0, edgeFaults.slice(0, 3).join(' · '))
  check(`${label}: nothing is painted right of the box`, bleeds.length === 0, bleeds.slice(0, 3).join(' · '))
  check(`${label}: no row is wider than the screen`, plain.every(line => stringWidth(line) <= columns), String(Math.max(...plain.map(line => stringWidth(line)))))
  return inner
}

const afterGutter = (line: string): string => line.replace(/^\s*\d+\s{1,2}/, '')

for (const [columns, rows] of [[178, 51], [220, 51]] as const) {
  const transcript = railPlanAt(columns, columns >= HELM_BOTH_RAILS_MIN).centerCols - 2
  const width = transcript - 2
  const digits = String(names.length + 1).length
  const expectedRows = [header, ...held].reduce((n, line) => n + Math.max(1, Math.ceil(stringWidth(expandTabs(line)) / width)), 0)

  {
    const label = `file road ${columns}x${rows}`
    const { raw, plain } = await mount(columns, rows, { columns: transcript, rows },
      React.createElement(Box, { width: transcript, borderStyle: 'single', flexDirection: 'column' }, React.createElement(FileRoad, { width })),
      text => text.includes('zephyrs'))
    file(`${columns}x${rows}-file`, plain, raw)
    show(`${label} (transcript ${transcript} columns, the road's width ${width})`, plain)
    const edges = boxEdges(plain, '┌')
    const inner = boxLaws(label, plain, edges, columns)
    if (inner.length > 0) {
      const innerText = squash(inner.join(''))
      check(`${label}: the over-long line wraps inside the box with every character kept`, innerText.includes(squash(expandTabs(longLine))), `${expandTabs(longLine).slice(0, 48)}…`)
      check(`${label}: the header columns sit at the line's own tab stops`, afterGutter(inner[0]!).startsWith(expandTabs(header)), JSON.stringify(afterGutter(inner[0]!).slice(0, 40)))
      check(`${label}: every line spends exactly the rows its expanded cells need`, inner.length === expectedRows, `${inner.length} rows painted, ${expectedRows} expected`)
    }
  }

  {
    const label = `text view ${columns}x${rows}`
    const { raw, plain } = await mount(columns, rows, { columns: transcript, rows },
      React.createElement(Box, { width: transcript, borderStyle: 'single', flexDirection: 'column' }, React.createElement(HighlightedCode, { code: source.replace(/\n$/, ''), filePath: '/srv/work/jobs.tsv' })),
      text => text.includes('zephyrs'))
    file(`${columns}x${rows}-view`, plain, raw)
    show(`${label} (HighlightedCode, transcript ${transcript} columns)`, plain)
    const edges = boxEdges(plain, '┌')
    const inner = boxLaws(label, plain, edges, columns)
    if (inner.length > 0) {
      const innerText = squash(inner.join(''))
      check(`${label}: the over-long line wraps inside the box with every character kept`, innerText.includes(squash(expandTabs(longLine))), `${expandTabs(longLine).slice(0, 48)}…`)
      check(`${label}: the header columns sit at the line's own tab stops`, afterGutter(inner[0]!).startsWith(expandTabs(header)), JSON.stringify(afterGutter(inner[0]!).slice(0, 40)))
    }
  }

  {
    const label = `consent card ${columns}x${rows}`
    const dir = mkdtempSync(join(tmpdir(), 'tab-cells-'))
    const filePath = join(dir, 'jobs.tsv')
    writeFileSync(filePath, source)
    const edits = [{ old_string: held.join('\n'), new_string: folded.join('\n'), replace_all: false }]
    const budget = consentBodyBudget(rows)
    const paintWidth = diffPaintWidth(consentContentWidth(columns) - 4, [{ oldStart: 1, oldLines: names.length + 1, newStart: 1, newLines: names.length + 1, lines: [] }])
    const straddling = [...held, ...folded].filter(line => stringWidth(line) <= paintWidth && stringWidth(expandTabs(line)) > paintWidth).length
    check(`${label}: the fixture straddles the wrap at the card's paint width (${paintWidth}): changed rows measured within it raw and beyond it expanded`, straddling >= 12, `${straddling} straddling rows`)
    let plain: string[] = []
    let raw: string[] = []
    try {
      const mounted = await mount(columns, rows, { columns, rows },
        React.createElement(PermissionDialog, {
          title: 'Edit file',
          subtitle: 'jobs.tsv',
          children: React.createElement(Box, { flexDirection: 'column' },
            React.createElement(ConsentFileEditDiff, { file_path: filePath, edits }),
            React.createElement(PermissionPrompt, {
              question: React.createElement(Text, { bold: true }, 'Do you want to make this edit to jobs.tsv?'),
              options: [
                { value: 'yes', label: 'Yes' },
                { value: 'yes-session', label: 'Yes, allow all edits during this session' },
                { value: 'no', label: 'No, and tell Mercury what to do differently (esc)', feedbackConfig: { type: 'reject' as const } },
              ],
              onSelect: () => {},
              onCancel: () => {},
            })),
        }),
        text => text.includes('zephyrs') && text.includes('❯ 1.'))
      plain = mounted.plain
      raw = mounted.raw
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    const paneRows = rows - 5
    file(`${columns}x${rows}-card`, plain, raw)
    file(`${columns}x${rows}-card-pane`, [...plain.slice(0, paneRows), `${'▔'.repeat(Math.min(columns, 40))} the pane's edge: the frame band and the status row stand below; rows past it never paint ${'▔'.repeat(Math.min(columns, 40))}`])
    show(`${label} (the card's body budget ${budget} rows; the pane affords the card ${paneRows} rows)`, plain)
    const card = boxEdges(plain, '╭')
    const frame = boxEdges(plain, '╭', card.top + 1)
    const nameRow = frame.top + 1
    check(`${label}: the diff frame paints inside the card with the file's name on its first row`, card.top >= 0 && frame.top > card.top && frame.bottom > nameRow && /\bjobs\.tsv\b/.test(plain[nameRow] ?? ''), `card top ${card.top}, frame top ${frame.top}, bottom ${frame.bottom}, row ${nameRow}: ${JSON.stringify((plain[nameRow] ?? '').trim().slice(0, 30))}`)
    const optionsRow = plain.findIndex(line => line.includes('❯ 1.'))
    check(`${label}: the options paint`, optionsRow > 0, 'no "❯ 1." row')
    if (frame.top > card.top && frame.bottom > nameRow) {
      const between = plain.slice(nameRow + 1, frame.bottom)
      const tailRows = between.filter(line => /more lines? · ctrl\+f expands|ctrl\+f collapses/.test(line)).length
      const bodyRows = between.length - tailRows
      check(`${label}: the body paints no more rows than the budget`, bodyRows <= budget, `the body paints ${bodyRows} rows against a ${budget}-row budget`)
      boxLaws(`${label}: diff frame`, plain, frame, columns, card.x1)
      const hidden = between.find(line => /\+\d+ more line/.test(line))
      const kept = between.filter(line => /│\s+\d+\s+[-+]/.test(line)).length
      check(`${label}: when rows are cut the tail names the hidden lines`, kept < 2 * names.length ? hidden !== undefined : true, `${kept} marked lines painted, no "+N more lines" tail`)
    }
    check(`${label}: the whole card stands on the pane (the options row included)`, plain.length <= paneRows && optionsRow >= 0 && optionsRow < paneRows, `the card is ${plain.length} rows; the pane affords ${paneRows}; the options row lands at row ${optionsRow}`)
  }
}

console.log(`\ntab cells frames: ${failures} failure(s) of ${checks} checks`)
process.exit(failures ? 1 : 0)
