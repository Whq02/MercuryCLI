#!/usr/bin/env bun
import { vshotBudgetMs } from '../lib/captureDriver.ts'
const MARKER = '#'
if (process.env.DIFF_WIDTH_CHILD) {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '1.0.0',
    ISSUES_EXPLAINER: '', PACKAGE_URL: '', README_URL: '', IS_DEV: false, IS_DEMO: false,
  }
  Bun.plugin({
    name: 'stub-color-diff-napi-echo',
    setup(build) {
      build.module('color-diff-napi', () => ({
        loader: 'object',
        exports: {
          ColorDiff: class {
            render(_theme: string, width: number, _dim: boolean): string[] {
              const out = process.env.DIFF_WIDTH_OUT
              if (out) { try { require('node:fs').appendFileSync(out, width + '\n') } catch {} }
              const line = MARKER.repeat(Math.max(1, width))
              return [line, line, line]
            }
          },
          ColorFile: class {},
          getSyntaxTheme: () => ({}),
        },
      }))
      build.onLoad({ filter: /hooks\/useSettings\.(ts|js)$/ }, () => ({
        contents: 'export function useSettings(){ return {} }', loader: 'js',
      }))
      build.onLoad({ filter: /components\/HighlightedCode\.(tsx|js)$/ }, () => ({
        contents: 'export function HighlightedCode(){ return null }', loader: 'js',
      }))
    },
  })

  const React = await import('react')
  const { render, Box, Text } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
  }
  const { PermissionDialog } = await import('../../src/components/permissions/PermissionDialog.js')
  const { FileWriteToolDiff } = await import(
    '../../src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.js'
  )
  const { FileEditToolDiff } = await import('../../src/components/FileEditToolDiff.js')

  const target = '/tmp/hb0200-edit-target.txt'
  const oldContent = 'alpha\nbeta\ngamma\ndelta'
  const newContent = 'alpha\nbeta CHANGED\ngamma\ndelta\nepsilon'

  const which = process.env.DIFF_WIDTH_WHICH ?? 'write'
  const content =
    which === 'write'
      ? React.createElement(FileWriteToolDiff, {
          file_path: '/tmp/hb0200-test.txt', content: newContent, fileExists: true, oldContent,
        })
      : React.createElement(FileEditToolDiff, {
          file_path: target,
          edits: [{ old_string: 'beta', new_string: 'beta CHANGED', replace_all: false }],
        })

  const el = React.createElement(
    PermissionDialog,
    { title: `${which === 'write' ? 'Write' : 'Edit'} file`, innerPaddingX: 0 },
    content,
  )
  const { Suspense } = React
  await render(React.createElement(Suspense, { fallback: React.createElement(Text, null, '…') }, el))
  await new Promise(r => setTimeout(r, 900))
  process.exit(0)
}

import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveProofHome } from '../lib/proofHome.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = new URL('./vshot.py', import.meta.url).pathname
const CONFIG_HOME = resolveProofHome([process.cwd()])
if (!existsSync(VSHOT)) {
  console.error('vshot.py missing — the render-verify harness (scripts/ui/vshot.py) is required')
  process.exit(1)
}
writeFileSync('/tmp/hb0200-edit-target.txt', 'alpha\nbeta\ngamma\ndelta\n')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const expectWidth = (which: string, cols: number): number => {
  if (which === 'write') return Math.max(1, cols - 4)
  const railed = cols > 80
  return Math.max(1, cols - 2 - (railed ? 2 : 0))
}

const markerRuns = (grid: string): number[] => {
  const runs: number[] = []
  for (const line of grid.split('\n'))
    for (const run of line.match(new RegExp(`${MARKER}+`, 'g')) ?? []) runs.push(run.length)
  return runs
}

console.log('============================================================')
console.log(' HB-0200 render-verify: permission diff width in the Mercury chrome')
console.log('============================================================')

const capture = (which: string, cols: number, rows: number): { grid: string; widthOut: string } => {
  const tag = `${which}-${cols}`
  const widthOut = `/tmp/hb0200-width-${tag}.txt`
  try { require('node:fs').rmSync(widthOut) } catch {}
  const cfg = `/tmp/vs-diffwidth-${tag}.json`
  writeFileSync(cfg, JSON.stringify({
    argv: [process.execPath, SELF],
    sends: [], total: 15, cols, rows,
    out: `/tmp/diffwidth-${tag}.json`,
  }))
  const grid = execFileSync('/usr/bin/python3', [VSHOT, cfg], {
    encoding: 'utf-8',
    timeout: vshotBudgetMs(30000),
    env: {
      ...process.env,
    MERCURY_CONFIG_DIR: CONFIG_HOME,
      DIFF_WIDTH_CHILD: '1', DIFF_WIDTH_WHICH: which,
      DIFF_WIDTH_OUT: widthOut, NODE_ENV: 'test',    },
  })
  return { grid, widthOut }
}

for (const which of ['write', 'edit']) {
  {
    for (const [cols, rows] of [[80, 24], [120, 30]] as const) {
      const tag = `${which}@${cols}`
      try {
        const { grid, widthOut } = capture(which, cols, rows)
        const want = expectWidth(which, cols)
        const recorded = (() => {
          try { return readFileSync(widthOut, 'utf-8').trim().split('\n').map(Number) } catch { return [] }
        })()
        const allMatch = recorded.length > 0 && recorded.every(w => w === want)
        check(`${tag}: ColorDiff.render width == ${want} (real chain, all hunks)`, allMatch,
          recorded.length ? `recorded ${[...new Set(recorded)].join(',')}` : 'none recorded')
        const runs = markerRuns(grid)
        check(`${tag}: diff body rendered in the dialog`, runs.length > 0, `${runs.length} marker rows`)
        const lines = grid.split('\n')
        const railRows = lines.filter(l => l[0] === '│').length
        check(`${tag}: dialog rail │ at column 0`, railRows > 0, `${railRows} rows`)
      } catch (e: unknown) {
        check(`${tag}: capture succeeded`, false, String(e).slice(0, 120))
      }
    }
  }
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0200 render-verify — diff width fits the Mercury chrome')
  process.exit(0)
} else {
  console.log(` ❌ HB-0200 render-verify — ${failures} check(s) failed`)
  process.exit(1)
}
