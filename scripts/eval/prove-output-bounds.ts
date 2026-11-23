#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { check, cleanup, finish, refusingBridge, loadEval, section, setup, within } from './lib.js'

const checkWithHint = (label: string, cond: boolean, detail: string | undefined, hint: string) => check(label, cond, cond ? detail : detail ? `${detail}. ${hint}` : hint)
const { work } = setup()
const { BoundedStreamSink, capLines } = await import('../../src/tools/engines/eval-kernels/outputSink.js')
const { evalKernelManager } = await loadEval()

section('the pure sink: byte-exact head+tail accounting')
{
  const sink = new BoundedStreamSink(100, 40)
  const chunk = 'x'.repeat(300) + '\n'
  sink.push(chunk)
  const cap = sink.finalize()
  checkWithHint('total bytes counted', cap.totalBytes === 301, String(cap.totalBytes), 'BoundedStreamSink in src/tools/engines/eval-kernels/outputSink.ts must count every pushed byte in totalBytes, including bytes it drops')
  checkWithHint('marked truncated', cap.truncated, '', 'finalize in BoundedStreamSink (src/tools/engines/eval-kernels/outputSink.ts) must set truncated when the head and tail limits (100 and 40 here) are exceeded')
  checkWithHint('gap names the elided byte count', /\[\d+ bytes elided/.test(cap.text), cap.text.slice(100, 160), 'finalize in BoundedStreamSink (src/tools/engines/eval-kernels/outputSink.ts) must put a [N bytes elided marker between head and tail')
  const raw = sink.rawCapture()
  checkWithHint('raw capture is byte-complete', raw.text === chunk && raw.capped === false, '', 'rawCapture in BoundedStreamSink (src/tools/engines/eval-kernels/outputSink.ts) must return the full pushed text uncapped for a small stream')
}
{
  const sink = new BoundedStreamSink(1000, 400)
  sink.push('short output\n')
  const cap = sink.finalize()
  checkWithHint('untruncated stream passes through verbatim', cap.text === 'short output\n' && !cap.truncated, '', 'finalize in BoundedStreamSink (src/tools/engines/eval-kernels/outputSink.ts) must return a stream under its limits unchanged and not truncated')
}
checkWithHint('per-line cap annotates its cut', capLines('a'.repeat(50), 10).includes('[line truncated: 50 chars]'), '', 'capLines in src/tools/engines/eval-kernels/outputSink.ts must end a cut line with [line truncated: N chars]')

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
  checkWithHint('cell ok', big.status === 'ok', JSON.stringify(big.error ?? big.annotations), 'runCell in src/tools/engines/eval-kernels/kernelManager.ts failed on the 60 KB stdout cell; this check needs a working python3')
  checkWithHint('stdout marked truncated', big.stdout.truncated, '', 'the stdout capture of runCell must be finalized through BoundedStreamSink in src/tools/engines/eval-kernels/outputSink.ts so a 60 KB stream is marked truncated')
  checkWithHint('total bytes counted (60 KB class)', big.stdout.totalBytes >= 60_000, String(big.stdout.totalBytes), 'totalBytes must count every byte the kernel wrote, not only the kept text; see BoundedStreamSink in src/tools/engines/eval-kernels/outputSink.ts')
  checkWithHint('model-visible text is bounded well under the raw size', big.stdout.text.length < big.stdout.totalBytes / 1.5, String(big.stdout.text.length), 'the head and tail limits of the stdout sink used by runCell are too large; see BoundedStreamSink in src/tools/engines/eval-kernels/outputSink.ts')
  checkWithHint('head retained (first line present)', big.stdout.text.includes('line-00000-'), '', 'the sink must keep the head of the stream; see BoundedStreamSink in src/tools/engines/eval-kernels/outputSink.ts')
  checkWithHint('tail retained (last line present)', big.stdout.text.includes('line-05999-'), '', 'the sink must keep the tail of the stream; see BoundedStreamSink in src/tools/engines/eval-kernels/outputSink.ts')
  checkWithHint('spill path annotated + reported', typeof big.spillPath === 'string' && big.annotations.some(a => a.includes('spilled')), big.spillPath, 'a truncated stdout must set spillPath and add an annotation containing spilled in the cell outcome')
  const spilled = big.spillPath && existsSync(big.spillPath) ? readFileSync(big.spillPath, 'utf8') : ''
  checkWithHint('spill artifact readable', spilled.length > 0, '', 'the file at spillPath must exist and hold the raw stdout')
  const expected = Array.from({ length: 6000 }, (_, i) => `line-${String(i).padStart(5, '0')}-xxxx\n`).join('')
  checkWithHint('spill bytes round-trip EXACTLY', spilled === expected, `${spilled.length} vs ${expected.length}`, 'the spill file must hold every stdout byte unchanged; see rawCapture in src/tools/engines/eval-kernels/outputSink.ts')

  section('display channels: JSON and PNG cross the protocol')
  const disp = await run(
    "display_json({'answer': 42, 'items': [1, 2, 3]})\nimport base64\npng_1x1 = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==')\ndisplay_image(png_1x1)\n'displayed'",
  )
  checkWithHint('display cell ok', disp.status === 'ok', JSON.stringify(disp.error ?? disp.annotations), 'display_json and display_image must be defined in the Python kernel runner that runCell in src/tools/engines/eval-kernels/kernelManager.ts starts')
  const json = disp.displays.find(d => d.mime === 'application/json')
  checkWithHint('JSON display captured', json !== undefined && json.data.includes('"answer": 42'), json?.data, 'the cell outcome displays must carry an application/json entry for display_json')
  const image = disp.displays.find(d => d.mime === 'image/png')
  checkWithHint('PNG display captured as base64', image !== undefined && image.b64 === true && (image?.data.length ?? 0) > 50, '', 'the cell outcome displays must carry an image/png entry with b64 true and the encoded data for display_image')
} finally {
  await evalKernelManager.disposeAll()
  checkWithHint('no kernel left behind', evalKernelManager.kernelCount() === 0, '', 'disposeAll in src/tools/engines/eval-kernels/kernelManager.ts must remove every retained kernel')
  cleanup()
}
finish('OUTPUT-BOUNDS')
