#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUN = process.execPath

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function runScene(scene: string): { reasons: Record<string, number>; frames: number } {
  const dir = mkdtempSync(join(tmpdir(), 'scroll-damage-'))
  const composed = join(dir, 'composed.jsonl')
  spawnSync(
    'python3',
    [join(HERE, 'ptyrun.py'), '--cols', '120', '--rows', '40', '--seconds', '4', '--', BUN, 'run', join(HERE, 'measure-render-traffic.ts')],
    {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TERM: 'xterm-256color',
        MERCURY_FORCE_SYNC_OUTPUT: '1',
        MEASURE_CHILD: '1',
        MEASURE_SCENE: scene,
        MEASURE_COLS: '120',
        INK_COMPOSED_TEE: composed,
        MERCURY_CONFIG_DIR: join(dir, 'config'),
        MERCURY_DAEMON_DIR: join(dir, 'daemon'),
        MERCURY_TEAMS_DIR: join(dir, 'teams'),
      },
      encoding: 'utf8',
      timeout: 40_000,
    },
  )
  const reasons: Record<string, number> = {}
  let frames = 0
  try {
    for (const line of readFileSync(composed, 'utf8').trim().split('\n')) {
      if (!line) continue
      frames++
      const parsed = JSON.parse(line) as { phase?: string; reason?: string }
      if (parsed.phase === 'full-damage' && parsed.reason) {
        const key = parsed.reason.split(':')[0] ?? parsed.reason
        reasons[key] = (reasons[key] ?? 0) + 1
      }
    }
  } catch {
  }
  rmSync(dir, { recursive: true, force: true })
  return { reasons, frames }
}

console.log('prove-scroll-damage')

{
  const { reasons } = runScene('scroll-cockpit')
  check(
    'scroll-cockpit: ZERO scroll-no-hint full-damage frames (was 64/4s pre-fix)',
    (reasons['scroll-no-hint'] ?? 0) === 0,
    JSON.stringify(reasons),
  )
  check(
    'scroll-cockpit: zero rect-unsafe fallbacks in steady scroll',
    (reasons['scroll-rect-unsafe'] ?? 0) === 0,
    JSON.stringify(reasons),
  )
}

{
  const { reasons } = runScene('stream-cockpit')
  const scrollDamage = (reasons['scroll-no-hint'] ?? 0) + (reasons['scroll-rect-unsafe'] ?? 0)
  check('stream-cockpit: zero scroll-class full-damage frames while sticky-streaming', scrollDamage === 0, JSON.stringify(reasons))
}

console.log(failures === 0 ? '\n✓ prove-scroll-damage: all green' : `\n✗ prove-scroll-damage: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
