#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const r = spawnSync(
  process.execPath,
  ['run', join(HERE, 'measure-render-traffic.ts'), 'turn-thinking', 'turn-tools', 'turn-responding'],
  {
    env: { ...process.env, MEASURE_BUDGET: '1', MEASURE_SECONDS: '8' },
    stdio: 'inherit',
    timeout: 240_000,
  },
)
process.exit(r.status ?? 1)
