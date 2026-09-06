#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPulseArena } from '../pulse/lib/pulseArena.ts'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCREENGRAB = join(HERE, '..', 'streaming', 'screengrab.py')

const turns: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'Agent',
    input: {
      description: 'poise probe',
      prompt: 'Count to three slowly.',
      subagent_type: 'mercury-general',
      run_in_background: true,
    },
    preText: 'Spawning the probe agent.',
  },
  {
    kind: 'paced',
    deltas: Array.from({ length: 18 }, (_, i) => `count ${i + 1}. `),
    gapMs: 900,
  },
  { kind: 'text', text: 'Probe launched.' },
]

const run = await runPulseArena({
  turns,
  sends: ['2000:\\r', '6000:spawn the probe\\r'],
  seconds: 24,
  cols: 120,
  rows: 40,
  keep: true,
})

const grab = spawnSync(
  '/usr/bin/python3',
  [SCREENGRAB, run.paths.drive, '120', '40', '5500', '9000', '14000', '20000', '-1'],
  { encoding: 'utf8' },
)
if (grab.status !== 0) {
  console.error(`screengrab failed: ${grab.stderr}`)
  process.exit(2)
}
const { screens } = JSON.parse(grab.stdout) as {
  screens: { atMs: number; rows: string[] }[]
}
for (const s of screens) {
  console.log(`\n════ screen @${s.atMs}ms ════`)
  console.log(s.rows.filter(r => r.trim() !== '').join('\n'))
}

console.log('\n── captured model calls ──')
for (const req of run.fixture.requests) {
  const body = req.body as {
    model?: string
    messages?: { role: string; content: unknown }[]
  } | null
  if (!body?.messages) continue
  const lastUser = [...body.messages].reverse().find(m => m.role === 'user')
  const summary =
    typeof lastUser?.content === 'string'
      ? lastUser.content.slice(0, 90)
      : JSON.stringify(lastUser?.content)?.slice(0, 90)
  console.log(`model=${body.model} messages=${body.messages.length} lastUser=${summary}`)
}
run.cleanup()
