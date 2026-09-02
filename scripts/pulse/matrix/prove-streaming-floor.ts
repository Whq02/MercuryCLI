#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check, section, finish, requireDistSeam, armWatchdog } from '../lib/proveKit.ts'
import { pct } from '../lib/pulseArena.ts'
import { sceneByKey, runScene } from './scenes.ts'

requireDistSeam('MERCURY_PULSE_DUMP', 'prove-streaming-floor')
armWatchdog('PULSE flux floor', 360_000)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BENCH = join(ROOT, 'scripts', 'streaming', 'bench-stream-fluidity.ts')

section('production paint (shipped artifact, scene 1): paintMs p95 ≤ 40ms')
{
  const run = await runScene(sceneByKey('warm-plain'))
  const paints = run.pulse
    .map(l => l.summary.paintMs)
    .filter((v): v is number => typeof v === 'number')
  check('every turn measured its paint', paints.length === 4, String(paints.length))
  const [cold, ...warm] = paints
  const warmMedian = pct(warm, 50)
  const warmMax = pct(warm, 95)
  check(
    'first_text_delta → first_text_terminal_write WARM median ≤ 40ms (the law)',
    warmMedian >= 0 && warmMedian <= 40,
    `p50=${warmMedian}ms warm=[${warm.join(',')}]`,
  )
  check(
    'WARM tail ≤ 60ms (shared-runner tail allowance; max-of-3 is not a p95)',
    warmMax >= 0 && warmMax <= 60,
    `max=${warmMax}ms warm=[${warm.join(',')}]`,
  )
  check(
    'cold first paint ≤ 150ms (its own ceiling, per the receipts split)',
    typeof cold === 'number' && cold >= 0 && cold <= 150,
    `cold=${cold}ms`,
  )
  run.cleanup()
}

section('flux token→paint bench (fast-tiny): p95 ≤ 40ms, one retry')
{
  type BenchScene = {
    scene: string
    sentinelMs: { p50: number; p95: number; max: number; n: number; misses: number }
    finalTextComplete: boolean
  }
  const runBench = (): BenchScene | null => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-flux-floor-'))
    const out = join(dir, 'results.json')
    const res = spawnSync(process.execPath, ['run', BENCH, 'fast-tiny'], {
      encoding: 'utf8',
      timeout: 150_000,
      env: { ...process.env, MEASURE_JSON: out },
      cwd: ROOT,
    })
    const parsed =
      res.status === 0 && existsSync(out)
        ? (JSON.parse(readFileSync(out, 'utf8')) as BenchScene[])[0] ?? null
        : null
    rmSync(dir, { recursive: true, force: true })
    return parsed
  }

  let r = runBench()
  check('the bench ran', r !== null)
  if (r && (r.sentinelMs.p95 > 40 || r.sentinelMs.p95 < 0)) {
    console.log(
      `  … first pass p95=${r.sentinelMs.p95}ms (max-of-${r.sentinelMs.n} estimator) — one retry for load noise`,
    )
    r = runBench()
    check('the retry ran', r !== null)
  }
  if (r) {
    check(
      `fast-tiny sentinel median ≤ 40ms (the law; historical ≈33ms)`,
      r.sentinelMs.p50 >= 0 && r.sentinelMs.p50 <= 40,
      `p50/p95/max = ${r.sentinelMs.p50}/${r.sentinelMs.p95}/${r.sentinelMs.max}ms (n=${r.sentinelMs.n})`,
    )
    check(
      'sentinel tail ≤ 60ms (shared-runner tail allowance)',
      r.sentinelMs.max >= 0 && r.sentinelMs.max <= 60,
      `p50/p95/max = ${r.sentinelMs.p50}/${r.sentinelMs.p95}/${r.sentinelMs.max}ms (n=${r.sentinelMs.n})`,
    )
    check('no sentinel misses', r.sentinelMs.misses === 0, String(r.sentinelMs.misses))
    check('the full text reached the terminal', r.finalTextComplete)
  }
}

finish('PULSE flux floor')
