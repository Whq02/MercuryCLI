#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/prove-kernel-drain.ts — a cell settles AFTER its output.
//
//  A kernel child speaks over three pipes — fd 1, fd 2 and the fd-3 protocol
//  pipe — and the kernel orders nothing between them: a `done` frame can
//  reach the host ahead of the cell's last stdout bytes, and a host that
//  settled on the frame alone reported an empty stdout for a cell that
//  printed. The law: the runner writes an end mark to fd 1 AND fd 2 after
//  its flush and ahead of `done`; the host settles the cell only once both
//  marks have arrived (a mark split across chunks still counts once, and
//  never leaks into the output), and a runner that never marks (fd 1/2
//  closed or redirected by the cell) settles on the bounded grace.
//
//  Seam: ProcKernel against a scripted runner that deliberately sends `done`
//  first — the race is forced, not hoped for.
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'eval-drain-'))
process.env.MERCURY_CONFIG_DIR = HOME

const { ProcKernel, cellEndMark } = await import('../../src/services/eval/procKernel.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// The scripted runner: hello → ready; exec → started + done on fd 3 FIRST,
// then (per mode) the cell's bytes and marks on fd 1/2 a beat later.
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
  check(`${mode}: the scripted runner handshakes`, ready)
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
  check('the cell settled as done', r.end.kind === 'done' && r.end.status === 'ok', JSON.stringify(r.end))
  check('stdout landed before the settle', r.out === 'late-out', JSON.stringify(r.out))
  check('stderr landed before the settle', r.err === 'late-err', JSON.stringify(r.err))
  check('the marks settled the cell (not the grace)', r.elapsedMs < 1200, `${r.elapsedMs} ms`)
}

section('§2 — a mark split across chunks counts once and never leaks')
{
  const r = await runCell('split', 'cell-split')
  const mark = cellEndMark('cell-split', 'x')
  check('the cell settled as done', r.end.kind === 'done', JSON.stringify(r.end))
  check('stdout is the user bytes alone', r.out === 'split-out', JSON.stringify(r.out))
  check('stderr is the user bytes alone', r.err === 'split-err', JSON.stringify(r.err))
  check('no mark byte leaked', !r.out.includes(mark.slice(0, 1)) && !r.err.includes(mark.slice(0, 1)))
  check('the marks settled the cell (not the grace)', r.elapsedMs < 1200, `${r.elapsedMs} ms`)
}

section('§3 — a runner that never marks settles on the bounded grace')
{
  const r = await runCell('silent', 'cell-silent')
  check('the cell settled as done', r.end.kind === 'done', JSON.stringify(r.end))
  check('nothing was invented', r.out === '' && r.err === '')
  check('the grace is bounded (≈1.5 s, never a hang)', r.elapsedMs >= 1300 && r.elapsedMs < 4000, `${r.elapsedMs} ms`)
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} KERNEL-DRAIN PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL KERNEL-DRAIN PROOFS PASS')
process.exit(0)
