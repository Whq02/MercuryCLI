#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'eval-drain-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { ProcKernel, cellEndMark } = await import('../../src/tools/engines/eval-kernels/procKernel.js')

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const RUNNER = `
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
let token = null
const emit = f => fs.writeSync(3, JSON.stringify(Object.assign(f, { token })) + '\\n')
const MODE = process.env.DRAIN_MODE
rl.on('line', line => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.t === 'hello') { token = m.token; emit({ t: 'ready' }); return }
  if (m.t === 'bye') { process.exit(0) }
  if (m.t !== 'exec') return
  emit({ t: 'started', id: m.id })
  emit({ t: 'done', id: m.id, status: 'ok' })
  const mark = '\\x1fmercury-eval-end ' + m.id + ' ' + token + '\\x1f'
  if (MODE === 'late') {
    setTimeout(() => { fs.writeSync(1, 'late-out' + mark); fs.writeSync(2, 'late-err' + mark) }, 150)
  } else if (MODE === 'split') {
    const half = Math.floor(mark.length / 2)
    setTimeout(() => {
      fs.writeSync(1, 'split-out' + mark.slice(0, half))
      fs.writeSync(2, 'split-err' + mark.slice(0, half))
      setTimeout(() => { fs.writeSync(1, mark.slice(half)); fs.writeSync(2, mark.slice(half)) }, 120)
    }, 100)
  }
  // 'silent': no bytes, no marks — the grace settles the cell.
})
`

type Run = { out: string; err: string; end: { kind: string; status?: string }; elapsedMs: number }
async function runCell(mode: 'late' | 'split' | 'silent', cellId: string): Promise<Run> {
  const kernel = new ProcKernel({
    command: process.execPath,
    args: ['-e', RUNNER],
    cwd: HOME,
    env: { PATH: process.env.PATH ?? '', DRAIN_MODE: mode },
  })
  const ready = await kernel.handshake(HOME, 10_000)
  check(`${mode}: the scripted runner handshakes`, ready, '', 'ProcKernel.handshake in src/tools/engines/eval-kernels/procKernel.ts did not get a ready frame on fd 3 from the scripted runner in this file')
  let out = ''
  let err = ''
  const t0 = Date.now()
  const end = await kernel.exec(cellId, '', {
    onStdout: c => {
      out += c
    },
    onStderr: c => {
      err += c
    },
    onDisplay: () => {},
    onResult: () => {},
    onError: () => {},
    onBridge: () => {},
  })
  const elapsedMs = Date.now() - t0
  await kernel.dispose()
  return { out, err, end, elapsedMs }
}

section('§1 — `done` outruns the data pipes: the cell still settles with its bytes')
{
  const r = await runCell('late', 'cell-late')
  check('the cell settled as done', r.end.kind === 'done' && r.end.status === 'ok', JSON.stringify(r.end), 'ProcKernel.exec in src/tools/engines/eval-kernels/procKernel.ts must settle the cell on its done frame once both end marks have arrived')
  check('stdout landed before the settle', r.out === 'late-out', JSON.stringify(r.out), 'ProcKernel in src/tools/engines/eval-kernels/procKernel.ts must hold the settle until the stdout end mark arrives, so bytes written after done are kept')
  check('stderr landed before the settle', r.err === 'late-err', JSON.stringify(r.err), 'ProcKernel in src/tools/engines/eval-kernels/procKernel.ts must hold the settle until the stderr end mark arrives, so bytes written after done are kept')
  check('the marks settled the cell (not the grace)', r.elapsedMs < 1200, `${r.elapsedMs} ms`, 'the cell must settle on the end marks; see the mark handling and END_MARK_GRACE_MS in src/tools/engines/eval-kernels/procKernel.ts')
}

section('§2 — a mark split across chunks counts once and never leaks')
{
  const r = await runCell('split', 'cell-split')
  const mark = cellEndMark('cell-split', 'x')
  check('the cell settled as done', r.end.kind === 'done', JSON.stringify(r.end), 'ProcKernel.exec in src/tools/engines/eval-kernels/procKernel.ts must settle the cell even when an end mark is split across chunks')
  check('stdout is the user bytes alone', r.out === 'split-out', JSON.stringify(r.out), 'the end-mark scanner in src/tools/engines/eval-kernels/procKernel.ts must strip a mark split across stdout chunks and keep the user bytes')
  check('stderr is the user bytes alone', r.err === 'split-err', JSON.stringify(r.err), 'the end-mark scanner in src/tools/engines/eval-kernels/procKernel.ts must strip a mark split across stderr chunks and keep the user bytes')
  check('no mark byte leaked', !r.out.includes(mark.slice(0, 1)) && !r.err.includes(mark.slice(0, 1)), JSON.stringify({ out: r.out, err: r.err }), 'the end-mark scanner in src/tools/engines/eval-kernels/procKernel.ts must not pass any part of a mark through to the cell output')
  check('the marks settled the cell (not the grace)', r.elapsedMs < 1200, `${r.elapsedMs} ms`, 'a split mark must still settle the cell once both halves arrive; see the mark handling and END_MARK_GRACE_MS in src/tools/engines/eval-kernels/procKernel.ts')
}

section('§3 — a runner that never marks settles on the bounded grace')
{
  const r = await runCell('silent', 'cell-silent')
  check('the cell settled as done', r.end.kind === 'done', JSON.stringify(r.end), 'a runner that never writes marks must still settle after END_MARK_GRACE_MS in src/tools/engines/eval-kernels/procKernel.ts')
  check('nothing was invented', r.out === '' && r.err === '', JSON.stringify({ out: r.out, err: r.err }), 'the grace settle in src/tools/engines/eval-kernels/procKernel.ts must not add bytes to stdout or stderr')
  check('the grace is bounded (≈1.5 s, never a hang)', r.elapsedMs >= 1300 && r.elapsedMs < 4000, `${r.elapsedMs} ms`, 'END_MARK_GRACE_MS in src/tools/engines/eval-kernels/procKernel.ts sets how long a cell with no marks waits before it settles')
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} KERNEL-DRAIN PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL KERNEL-DRAIN PROOFS PASS')
process.exit(0)
