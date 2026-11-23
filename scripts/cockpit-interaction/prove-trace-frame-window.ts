#!/usr/bin/env bun
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'tracewin-home-')))
process.env.NODE_ENV = 'test'
process.env['FORCE_COLOR'] = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const trace = await import('../../src/screen/renderer/root/frame-trace.ts')
const React = (await import('react')).default
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { FrameSection } = await import('../../src/commands/trace/TraceView.js')

console.log('§1 the cap is an exported fact')
{
  check(
    'FRAME_TRACE_RING_CAP is exported and matches the ring bound',
    (trace as { FRAME_TRACE_RING_CAP?: number }).FRAME_TRACE_RING_CAP === 256,
    '',
    'export FRAME_TRACE_RING_CAP = 256 from src/screen/renderer/root/frame-trace.ts, equal to its ring bound',
  )
}

console.log('\n§2 the frames header states count/cap and the live span')
{
  trace._resetFrameTraceForTesting()
  for (let i = 0; i < 5; i++) {
    trace.recordFrameTrace({ durationMs: 4 + i, flickers: [] })
  }
  const mountable = typeof FrameSection === 'function' ? FrameSection : (): null => null
  const frame = await renderToString(React.createElement(mountable, {} as never), 120)
  const header = frame.split('\n').find(l => l.includes('p50')) ?? ''
  check('the header carries n=<rows>/<cap>', header.includes('n=5/256'), header.trim().slice(0, 100), 'FrameSection in src/commands/trace/TraceView.tsx must print n=<rows>/<FRAME_TRACE_RING_CAP> in the line with p50')
  check(
    'and the live span the ring covers (last <s>)',
    /last \d+(\.\d+)?[sm] /.test(header) || /last \d+(\.\d+)?[sm]\b/.test(header),
    header.trim().slice(0, 100),
    'FrameSection in src/commands/trace/TraceView.tsx must print last <span> (frameSpanLabel) after n=<rows>/<cap>',
  )
}

console.log(failures === 0 ? '\nprove-trace-frame-window: all green' : `\nprove-trace-frame-window: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
