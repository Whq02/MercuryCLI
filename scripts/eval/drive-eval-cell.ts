#!/usr/bin/env bun
// ============================================================================
//  scripts/eval/drive-eval-cell.ts — the REAL-BOOT drive (manual, not
//  pooled: `bun run scripts/eval/drive-eval-cell.ts [cols rows]`).
//
//  Boots the BUILT dist under NODE in a real PTY (the streaming arena:
//  hermetic home, trust + key seeds, fixture-routed provider) and drives a
//  live journey: the scripted model calls the Eval tool with a Python cell;
//  default mode raises the consent card; the drive approves it; the REAL
//  kernel runs the cell (stdout + last-expression result render); the
//  closing turn lands. The final screen is printed for eyeballs and
//  needle-asserted. The arena's minimal PATH only carries the 3.9 system
//  python, so the operator pin (MERCURY_EVAL_PYTHON) points the kernel at a
//  floor-satisfying interpreter — exactly the pin's production purpose.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { runArtifactArena, requireDist, grabScreens } from '../streaming/artifactArena.js'

const cols = Number(process.argv[2] ?? 120)
const rows = Number(process.argv[3] ?? 44)

requireDist()

const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim()

const run = await runArtifactArena({
  turns: [
    {
      kind: 'tool_use',
      name: 'Eval',
      preText: 'Running a quick kernel cell to demonstrate retained state.',
      input: {
        language: 'py',
        code: "print('hello from the kernel')\ntotal = sum(range(10))\ntotal",
        title: 'kernel demo',
      },
    },
    { kind: 'text', text: 'The cell ran cleanly; total is 45 and the kernel is retained for follow-ups.' },
  ],
  sends: [
    'after:? for shortcuts:1500:run the demo cell',
    'after:run the demo cell:800:\r',
    // The consent card (default mode): approve the Eval ask once it paints.
    'after:kernel demo:900:\r',
  ],
  seconds: 45,
  cols,
  rows,
  keep: true,
  ...(python ? { extraEnv: { MERCURY_EVAL_PYTHON: python } } : {}),
})

const [finalScreen] = grabScreens(run, cols, rows, [-1])
const text = finalScreen!.rows.join('\n')
console.log('──────────── final screen ────────────')
console.log(text)
console.log('──────────────────────────────────────')
console.log('drive log (replayable):', run.paths.drive)

let failures = 0
const need = (label: string, pattern: RegExp): void => {
  const ok = pattern.test(text)
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] screen carries ${label} (${pattern})`)
}
need('the cell stdout', /hello from the kernel/)
need('the cell title', /kernel demo/)
need('the closing turn', /total is 45/)

// No process left behind: the PTY teardown must have taken the kernels.
const leftovers = spawnSync('pgrep', ['-f', 'runner-[0-9a-f]+\\.(py|mjs)'], { encoding: 'utf8' })
const leftoverPids = (leftovers.stdout ?? '').trim()
if (leftoverPids) {
  console.log(`  [WARN] kernel processes survived the drive: ${leftoverPids} — killing`)
  for (const pid of leftoverPids.split('\n')) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}
run.cleanup()
console.log(failures === 0 ? '✅ REAL-BOOT DRIVE GREEN' : `❌ ${failures} REAL-BOOT NEEDLE(S) MISSING`)
process.exit(failures === 0 ? 0 : 1)
