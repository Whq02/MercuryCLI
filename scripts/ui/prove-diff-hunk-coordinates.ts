#!/usr/bin/env bun
import React from 'react'
import { mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { applyPatch, formatPatch, structuredPatch } from 'diff'
import stripAnsi from 'strip-ansi'
import type { StructuredPatchHunk } from '../../src/utils/diff.js'

process.env.FORCE_COLOR = '3'
process.env.MERCURY_FULLSCREEN = '1'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const settingsModule = await import('../../src/hooks/useSettings.js')
mock.module('../../src/hooks/useSettings.js', () => ({
  ...settingsModule,
  useSettings: () => ({ view: { syntaxOff: false } }),
  useSettingsMaybe: () => undefined,
}))
const { render, Box, flushPendingSyncWork } = await import('../../src/ink.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { StructuredDiff } = await import('../../src/components/StructuredDiff.js')
const { ColorDiff } = await import('../../src/native-ts/color-diff/index.js')
const { hunkPatchText } = await import('../../src/components/diff/DiffDialog.js')
const { fetchGitDiffHunksFor } = await import('../../src/utils/gitDiff.js')
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

async function paint(patch: StructuredPatchHunk, plain: boolean): Promise<{ lines: string[]; gutter: number }> {
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode() {}, setEncoding() {}, read() { return null }, unref() {}, ref() {}, pause() {}, resume() {} }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 60, rows: 30 }) as unknown as NodeJS.WriteStream
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const mounted = await render(React.createElement(Box, { width: 60, flexDirection: 'column' },
    React.createElement(StructuredDiff, { patch, width: 60, filePath: 'x.txt', firstLine: null, dim: false, skipHighlighting: plain })),
  { stdin: input, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  try {
    await first
    flushPendingSyncWork()
    const engine = instances.get(stdout) as unknown as { frontFrame: { screen: { width: number; noSelect: Uint8Array } } }
    const screen = engine.frontFrame.screen
    let gutter = 0
    while (gutter < screen.width && screen.noSelect[gutter] === 1) gutter++
    return { lines: stripAnsi(mounted.lastFrame()).trimEnd().split('\n'), gutter }
  } finally {
    mounted.unmount()
    mounted.cleanup()
    stream.destroy()
  }
}

const fixtures: [string, StructuredPatchHunk, number[]][] = [
  ['distinct starts', { oldStart: 8, oldLines: 3, newStart: 20, newLines: 3, lines: [' context', '-old', '+new', ' tail'] }, [20, 9, 21, 22]],
  ['multiple removal runs', { oldStart: 8, oldLines: 4, newStart: 20, newLines: 2, lines: ['-one', ' two', '-three', ' four'] }, [8, 20, 10, 21]],
  ['add only', { oldStart: 8, oldLines: 0, newStart: 20, newLines: 2, lines: ['+one', '+two'] }, [20, 21]],
  ['empty file add', structuredPatch('x', 'x', '', 'added\n').hunks[0]!, [1]],
  ...[9, 10, 99, 100].map(end => [`end ${end}`, { oldStart: end, oldLines: 1, newStart: end, newLines: 1, lines: ['-old', '+new'] }, [end, end]] as [string, StructuredPatchHunk, number[]]),
]
const numbers = (lines: string[]): number[] => lines.map(line => Number(/^\s*(\d+)/.exec(line)?.[1]))
for (const [name, patch, expected] of fixtures) {
  const native = new ColorDiff(patch, undefined, 'x.txt').render('dark', 60, false)!.map(stripAnsi)
  check(`${name}: native numbers match coordinates`, JSON.stringify(numbers(native)) === JSON.stringify(expected))
  for (const plain of [false, true]) {
    const frame = await paint(patch, plain)
    check(`${name}: ${plain ? 'fallback' : 'highlighted'} painted numbers match native`, JSON.stringify(numbers(frame.lines)) === JSON.stringify(expected), JSON.stringify(frame.lines))
    if (!plain) {
      const gutter = native[0]!.indexOf(patch.lines[0]!.slice(1))
      check(`${name}: selection gutter stops before the first content cell`, frame.gutter === gutter, `${frame.gutter} vs ${gutter}`)
    }
  }
}

const repo = mkdtempSync(join(tmpdir(), 'diff-coordinates-'))
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
try {
  git('init', '-q')
  for (const [name, before, after] of [
    ['empty add', '', 'added\n'],
    ['delete all', 'old\n', ''],
    ['insert middle', 'one\ntwo\n', 'one\nnew\ntwo\n'],
    ['delete middle', 'one\nold\ntwo\n', 'one\ntwo\n'],
  ]) {
    writeFileSync(join(repo, 'x.txt'), before!)
    git('add', 'x.txt')
    writeFileSync(join(repo, 'x.txt'), after!)
    const fromGit = (await fetchGitDiffHunksFor({ args: ['--unified=0'], cwd: repo })).get('x.txt')![0]!
    const patch = structuredPatch('x.txt', 'x.txt', before!, after!, undefined, undefined, { context: 0 })
    const expectedHeader = formatPatch(patch).split('\n').find(line => line.startsWith('@@'))
    check(`${name}: git and jsdiff use the same structured coordinates`, JSON.stringify(fromGit) === JSON.stringify(patch.hunks[0]), JSON.stringify({ fromGit, jsdiff: patch.hunks[0] }))
    for (const [source, hunk] of [['git', fromGit], ['jsdiff', patch.hunks[0]!]] as const) {
      const copied = hunkPatchText('x.txt', hunk)
      check(`${name}: ${source} copied header follows unified syntax`, copied.split('\n')[2] === expectedHeader, copied.split('\n')[2])
      check(`${name}: ${source} copied hunk applies to its original`, applyPatch(before!, copied) === after)
    }
  }
} finally {
  rmSync(repo, { recursive: true, force: true })
}
console.log(`\ndiff hunk coordinates: ${failures} failure(s) of ${checks} checks`)
process.exit(failures ? 1 : 0)
