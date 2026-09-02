#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/prove-output-bounds.ts
//  PROOF (spec c.4 #5): the bounded sink — 60 KB of stdout yields a
//  truncated model-visible capture with an annotated gap AND a spill
//  artifact whose bytes round-trip exactly; per-line column caps mark their
//  cuts; the display channels carry JSON and IMAGES (base64 PNG) through
//  the kernel protocol; the pure sink's head/tail accounting is byte-exact.
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, within } from './lib.js'

const { work } = setup()
const { BoundedStreamSink, capLines } = await import('../../src/services/eval/outputSink.js')
const { evalKernelManager } = await loadEval()

section('the pure sink: byte-exact head+tail accounting')
{
  const sink = new BoundedStreamSink(100, 40)
  const chunk = 'x'.repeat(300) + '\n'
  sink.push(chunk)
  const cap = sink.finalize()
  check('total bytes counted', cap.totalBytes === 301, String(cap.totalBytes))
  check('marked truncated', cap.truncated)
  check('gap names the elided byte count', /\[\d+ bytes elided/.test(cap.text), cap.text.slice(100, 160))
  const raw = sink.rawCapture()
  check('raw capture is byte-complete', raw.text === chunk && raw.capped === false)
}
{
  const sink = new BoundedStreamSink(1000, 400)
  sink.push('short output\n')
  const cap = sink.finalize()
  check('untruncated stream passes through verbatim', cap.text === 'short output\n' && !cap.truncated)
}
check('per-line cap annotates its cut', capLines('a'.repeat(50), 10).includes('[line truncated: 50 chars]'))

const bridge = refusingBridge()
const run = (code: string) =>
  within(
    'bounds cell',
    60_000,
    evalKernelManager.runCell({
      owner: 'bounds-owner',
      cwd: work,
      input: { language: 'py', code, timeoutSeconds: 60 },
      abortSignal: new AbortController().signal,
      serveBridge: bridge,
    }),
  )

try {
  section('60 KB of stdout → truncated result + byte-complete spill artifact')
  const big = await run("import sys\nfor i in range(6000):\n    sys.stdout.write(f'line-{i:05d}-' + 'x' * 4 + '\\n')\nsys.stdout.flush()\n'done'")
  check('cell ok', big.status === 'ok', JSON.stringify(big.error ?? big.annotations))
  check('stdout marked truncated', big.stdout.truncated)
  check('total bytes counted (60 KB class)', big.stdout.totalBytes >= 60_000, String(big.stdout.totalBytes))
  check('model-visible text is bounded well under the raw size', big.stdout.text.length < big.stdout.totalBytes / 1.5, String(big.stdout.text.length))
  check('head retained (first line present)', big.stdout.text.includes('line-00000-'))
  check('tail retained (last line present)', big.stdout.text.includes('line-05999-'))
  check('spill path annotated + reported', typeof big.spillPath === 'string' && big.annotations.some(a => a.includes('spilled')), big.spillPath)
  const spilled = big.spillPath && existsSync(big.spillPath) ? readFileSync(big.spillPath, 'utf8') : ''
  check('spill artifact readable', spilled.length > 0)
  const expected = Array.from({ length: 6000 }, (_, i) => `line-${String(i).padStart(5, '0')}-xxxx\n`).join('')
  check('spill bytes round-trip EXACTLY', spilled === expected, `${spilled.length} vs ${expected.length}`)

  section('display channels: JSON and PNG cross the protocol')
  const disp = await run(
    "display_json({'answer': 42, 'items': [1, 2, 3]})\nimport base64\npng_1x1 = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==')\ndisplay_image(png_1x1)\n'displayed'",
  )
  check('display cell ok', disp.status === 'ok', JSON.stringify(disp.error ?? disp.annotations))
  const json = disp.displays.find(d => d.mime === 'application/json')
  check('JSON display captured', json !== undefined && json.data.includes('"answer": 42'), json?.data)
  const image = disp.displays.find(d => d.mime === 'image/png')
  check('PNG display captured as base64', image !== undefined && image.b64 === true && (image?.data.length ?? 0) > 50)
} finally {
  await evalKernelManager.disposeAll()
  check('no kernel left behind', evalKernelManager.kernelCount() === 0)
  cleanup()
}
finish('OUTPUT-BOUNDS')
